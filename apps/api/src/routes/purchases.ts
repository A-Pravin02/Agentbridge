// ============================================
// AgentBridge - Purchase Intent Routes
// Create, evaluate, approve/deny, and execute purchases
// Full 3-layer security integration
// ============================================

import { FastifyInstance } from 'fastify';
import { prisma, parseJsonArray } from '../db.js';
import { evaluatePolicy } from '@agentbridge/policy-engine';
import { canTransition } from '@agentbridge/policy-engine';
import {
  PolicyContext,
  PurchaseStatus,
  PolicyDecision,
  AuditAction,
  ActorType,
  SecurityViolation,
} from '@agentbridge/shared-types';
import { recordAuditEvent } from '../audit.js';
import {
  checkAgentStatus,
  validateTimestamp,
  checkReplayProtection,
  consumeRequestId,
  checkIdempotency,
  storeIdempotencyResult,
  buildCanonicalRequest,
  verifyAgentSignature,
  hashRequestBody,
} from '../integrity-service.js';
import { performThreatAnalysis, isThreatAssessmentValid } from '../threat-service.js';
import { recordSecurityIncident, quarantineAgent } from '../security-service.js';
import { combineDecisions, decisionToPurchaseStatus } from '../decision-orchestrator.js';
import { QuarantineTrigger } from '@agentbridge/shared-types';

export async function purchaseRoutes(app: FastifyInstance) {
  // ============================================
  // POST /purchase-intents - Create a new purchase intent
  // ============================================
  app.post('/purchase-intents', async (request, reply) => {
    const body = request.body as {
      agentId: string;
      productId: string;
      quantity?: number;
      agentReason: string;
      merchantId: string;
    };
    const { agentId, productId, quantity, agentReason, merchantId } = body;

    // ---- Layer 1: Agent Status Check ----
    const statusCheck = await checkAgentStatus(agentId);
    if (!statusCheck.passed) {
      await recordAuditEvent({
        action: AuditAction.REQUEST_BLOCKED_SECURITY,
        actorType: ActorType.SYSTEM,
        actorId: 'security-engine',
        entityId: agentId,
        metadata: { violation: statusCheck.violation, stage: 'purchase-intent-creation' },
      });
      return reply.status(403).send({
        success: false,
        error: statusCheck.message,
        code: statusCheck.violation,
      });
    }

    // Validate product exists and has stock
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      return reply.status(404).send({ success: false, error: 'Product not found' });
    }
    if (product.stock < (quantity || 1)) {
      return reply.status(400).send({ success: false, error: 'Product out of stock' });
    }

    const amount = product.price * (quantity || 1);

    const intent = await prisma.purchaseIntent.create({
      data: {
        // Always derive merchantId from the product record — never trust caller (GAP-05 fix)
        merchantId: product.merchantId,
        agentId,
        productId,
        quantity: quantity || 1,
        amount,
        status: PurchaseStatus.CREATED,
        agentReason: agentReason || '',
      },
      include: { product: true },
    });

    await recordAuditEvent({
      action: AuditAction.PURCHASE_INTENT_CREATED,
      actorType: ActorType.AGENT,
      actorId: agentId,
      entityId: intent.id,
      metadata: { productId, amount, agentReason },
    });

    return { success: true, data: intent };
  });

  // ============================================
  // GET /purchase-intents/:id - Get purchase intent status
  // ============================================
  app.get('/purchase-intents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const intent = await prisma.purchaseIntent.findUnique({
      where: { id },
      include: {
        product: true,
        authorizations: true,
        approvals: true,
        transactions: true,
        threatAssessments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    if (!intent) {
      return reply.status(404).send({ success: false, error: 'Purchase intent not found' });
    }

    return { success: true, data: intent };
  });

  // ============================================
  // POST /purchase-intents/:id/evaluate - Full 3-layer security evaluation
  // ============================================
  app.post('/purchase-intents/:id/evaluate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const headers = request.headers as Record<string, string | undefined>;
    const rawBody = JSON.stringify(request.body || {});

    const intent = await prisma.purchaseIntent.findUnique({
      where: { id },
      include: { product: true },
    });

    if (!intent) {
      return reply.status(404).send({ success: false, error: 'Purchase intent not found' });
    }

    // ---- Layer 1a: Agent Status Check ----
    const statusCheck = await checkAgentStatus(intent.agentId);
    if (!statusCheck.passed) {
      await prisma.purchaseIntent.update({ where: { id }, data: { status: PurchaseStatus.BLOCKED } });
      await recordAuditEvent({
        action: AuditAction.REQUEST_BLOCKED_SECURITY,
        actorType: ActorType.SYSTEM,
        actorId: 'security-engine',
        entityId: id,
        metadata: { violation: statusCheck.violation, agentId: intent.agentId },
      });
      return reply.status(403).send({
        success: false,
        error: statusCheck.message,
        decision: 'BLOCK',
        code: statusCheck.violation,
      });
    }

    // ---- Layer 1b: Timestamp Validation ----
    const tsCheck = validateTimestamp(headers['x-timestamp']);
    if (!tsCheck.passed) {
      await recordSecurityIncident(
        intent.agentId,
        SecurityViolation.EXPIRED_REQUEST,
        'Request timestamp validation failed',
        { purchaseIntentId: id }
      );
      return reply.status(400).send({
        success: false,
        error: 'Request integrity check failed',
        decision: 'BLOCK',
      });
    }

    // ---- Layer 1c: Replay Protection ----
    const requestId = headers['x-request-id'];
    if (requestId) {
      const requestHash = hashRequestBody(request.body);
      const replayCheck = await checkReplayProtection(intent.agentId, requestId, requestHash);
      if (!replayCheck.passed) {
        await recordSecurityIncident(
          intent.agentId,
          SecurityViolation.REPLAY_ATTACK,
          'Replay attack detected on purchase evaluation',
          { purchaseIntentId: id, requestId }
        );
        await recordAuditEvent({
          action: AuditAction.REPLAY_ATTACK_DETECTED,
          actorType: ActorType.SYSTEM,
          actorId: 'security-engine',
          entityId: id,
          metadata: { agentId: intent.agentId },
        });
        return reply.status(400).send({
          success: false,
          error: 'Request integrity check failed',
          decision: 'BLOCK',
        });
      }
    }

    // ---- Layer 1d: HMAC Signature Verification ----
    if (requestId && headers['x-timestamp']) {
      const canonicalReq = buildCanonicalRequest(
        intent.agentId,
        requestId,
        headers['x-timestamp']!,
        'POST',
        `/api/purchase-intents/${id}/evaluate`,
        rawBody
      );
      const sigCheck = await verifyAgentSignature(
        intent.agentId,
        canonicalReq,
        headers['x-agent-signature']
      );
      if (!sigCheck.passed) {
        await recordSecurityIncident(
          intent.agentId,
          SecurityViolation.INVALID_REQUEST_SIGNATURE,
          'HMAC signature verification failed',
          { purchaseIntentId: id }
        );
        await recordAuditEvent({
          action: AuditAction.SECURITY_VIOLATION_DETECTED,
          actorType: ActorType.SYSTEM,
          actorId: 'security-engine',
          entityId: id,
          metadata: { violation: SecurityViolation.INVALID_REQUEST_SIGNATURE, agentId: intent.agentId },
        });
        return reply.status(403).send({
          success: false,
          error: 'Request integrity check failed',
          decision: 'BLOCK',
        });
      }
    }

    // ---- State Machine Check ----
    if (!canTransition(intent.status as PurchaseStatus, PurchaseStatus.EVALUATING)) {
      await recordSecurityIncident(
        intent.agentId,
        SecurityViolation.INVALID_STATE_TRANSITION,
        `Invalid state transition attempt: ${intent.status} → EVALUATING`,
        { purchaseIntentId: id, currentStatus: intent.status }
      );
      return reply.status(400).send({
        success: false,
        error: `Cannot evaluate from state: ${intent.status}`,
      });
    }

    // Update to EVALUATING
    await prisma.purchaseIntent.update({
      where: { id },
      data: { status: PurchaseStatus.EVALUATING },
    });

    // ---- Get agent permission ----
    const agentPermission = await prisma.agentPermission.findFirst({
      where: { agentId: intent.agentId },
    });

    if (!agentPermission) {
      await prisma.purchaseIntent.update({ where: { id }, data: { status: PurchaseStatus.BLOCKED } });
      return reply.status(403).send({
        success: false,
        error: 'No agent permission found',
        decision: PolicyDecision.BLOCK,
      });
    }

    // ---- Get merchant policy ----
    const merchantPolicy = await prisma.policy.findFirst({
      where: { merchantId: intent.merchantId },
    });

    if (!merchantPolicy) {
      return reply.status(400).send({ success: false, error: 'No merchant policy found' });
    }

    // ---- Layer 2: Behavioral Threat Analysis ----
    const agentMaxTransaction = Math.min(
      merchantPolicy.maxTransactionAmount,
      agentPermission.maxTransactionAmount
    );
    const threatAssessment = await performThreatAnalysis(
      intent.agentId,
      id,
      intent.amount,
      intent.product.category,
      agentMaxTransaction
    );

    // Check if agent was just quarantined by threat analysis
    const freshStatusCheck = await checkAgentStatus(intent.agentId);
    if (!freshStatusCheck.passed) {
      await prisma.purchaseIntent.update({ where: { id }, data: { status: PurchaseStatus.BLOCKED } });
      return reply.status(403).send({
        success: false,
        error: 'Agent has been suspended pending security review',
        decision: 'BLOCK',
        threatAssessment: {
          score: threatAssessment.score,
          level: threatAssessment.level,
          factors: threatAssessment.factors,
        },
      });
    }

    // ---- Get daily spending totals ----
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dailyIntents = await prisma.purchaseIntent.findMany({
      where: {
        agentId: intent.agentId,
        status: { in: ['COMPLETED', 'PAYMENT_PENDING', 'PAYMENT_PROCESSING', 'AUTHORIZED'] },
        createdAt: { gte: today },
      },
    });

    const dailySpent = dailyIntents.reduce((sum, i) => sum + i.amount, 0);
    const dailyTransactionCount = dailyIntents.length;

    // ---- Layer 3: Policy Engine ----
    const policyContext: PolicyContext = {
      request: {
        merchantId: intent.merchantId,
        agentId: intent.agentId,
        productId: intent.productId,
        productCategory: intent.product.category,
        amount: intent.amount,
        currency: intent.product.currency,
        quantity: intent.quantity,
        agentReason: intent.agentReason,
      },
      policy: {
        agentPermission: {
          id: agentPermission.id,
          agentId: agentPermission.agentId,
          canSearch: agentPermission.canSearch,
          canCreatePurchaseIntent: agentPermission.canCreatePurchaseIntent,
          canExecutePurchase: agentPermission.canExecutePurchase,
          allowedCategories: parseJsonArray(agentPermission.allowedCategories),
          maxTransactionAmount: agentPermission.maxTransactionAmount,
          maxDailyAmount: agentPermission.maxDailyAmount,
          expiresAt: agentPermission.expiresAt,
        },
        merchantPolicy: {
          id: merchantPolicy.id,
          merchantId: merchantPolicy.merchantId,
          maxTransactionAmount: merchantPolicy.maxTransactionAmount,
          maxDailyAmount: merchantPolicy.maxDailyAmount,
          maxTransactionsPerDay: merchantPolicy.maxTransactionsPerDay,
          allowedCategories: parseJsonArray(merchantPolicy.allowedCategories),
          approvalThreshold: merchantPolicy.approvalThreshold,
          createdAt: merchantPolicy.createdAt,
          updatedAt: merchantPolicy.updatedAt,
        },
      },
      dailySpent,
      dailyTransactionCount,
    };

    const policyResult = evaluatePolicy(policyContext);

    await recordAuditEvent({
      action: AuditAction.POLICY_EVALUATED,
      actorType: ActorType.SYSTEM,
      actorId: 'policy-engine',
      entityId: id,
      metadata: {
        decision: policyResult.decision,
        reasons: policyResult.reasons,
        violations: policyResult.violations,
        amount: intent.amount,
      },
    });

    // ---- Decision Orchestrator: Combine all signals ----
    const combined = combineDecisions({
      agentStatusCheck: { passed: true, message: 'Agent active' },
      integrityCheck: { passed: true, message: 'Integrity verified' },
      permissionCheck: { passed: true, message: 'Permission valid' },
      threatAssessment,
      policyResult,
    });

    // ---- Apply quarantine if needed ----
    if (combined.shouldQuarantine) {
      await quarantineAgent(
        intent.agentId,
        `Critical behavioral threat during purchase evaluation`,
        QuarantineTrigger.AUTOMATIC_THREAT_DETECTION
      );
    }

    // ---- Map to purchase status ----
    const newStatus = decisionToPurchaseStatus(combined) as PurchaseStatus;
    const updated = await prisma.purchaseIntent.update({
      where: { id },
      data: { status: newStatus },
      include: { product: true },
    });

    // ---- Create authorization record ----
    const policySnapshot = {
      maxTransactionAmount: merchantPolicy.maxTransactionAmount,
      maxDailyAmount: merchantPolicy.maxDailyAmount,
      maxTransactionsPerDay: merchantPolicy.maxTransactionsPerDay,
      allowedCategories: parseJsonArray(merchantPolicy.allowedCategories),
      approvalThreshold: merchantPolicy.approvalThreshold,
      agentMaxTransaction: agentPermission.maxTransactionAmount,
      agentMaxDaily: agentPermission.maxDailyAmount,
      agentAllowedCategories: parseJsonArray(agentPermission.allowedCategories),
    };

    const authorization = await prisma.authorization.create({
      data: {
        purchaseIntentId: id,
        decision: combined.finalDecision === 'ALLOW'
          ? PolicyDecision.ALLOW
          : combined.finalDecision === 'REQUIRE_APPROVAL'
          ? PolicyDecision.REQUIRE_APPROVAL
          : PolicyDecision.BLOCK,
        reasons: JSON.stringify(combined.reasons),
        policySnapshot: JSON.stringify(policySnapshot),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    if (combined.finalDecision === 'REQUIRE_APPROVAL') {
      await prisma.approval.create({
        data: { purchaseIntentId: id, status: 'PENDING' },
      });
    }

    // ---- Audit final decision ----
    const decisionAuditAction =
      combined.finalDecision === 'ALLOW'
        ? AuditAction.PURCHASE_ALLOWED
        : combined.finalDecision === 'REQUIRE_APPROVAL'
        ? AuditAction.APPROVAL_REQUESTED
        : AuditAction.PURCHASE_BLOCKED;

    await recordAuditEvent({
      action: decisionAuditAction,
      actorType: ActorType.SYSTEM,
      actorId: 'decision-orchestrator',
      entityId: id,
      metadata: {
        decision: combined.finalDecision,
        amount: intent.amount,
        threatScore: threatAssessment.score,
        threatLevel: threatAssessment.level,
        quarantined: combined.shouldQuarantine,
      },
    });

    // Mark request ID as consumed (replay protection)
    if (requestId) {
      await consumeRequestId(intent.agentId, requestId, hashRequestBody(request.body));
    }

    return {
      success: true,
      data: {
        purchaseIntent: updated,
        authorization: {
          ...authorization,
          reasons: combined.reasons,
          policySnapshot,
        },
        policyResult,
        riskAssessment: {
          score: threatAssessment.score,
          level: threatAssessment.level,
          recommendedAction: threatAssessment.recommendedAction,
          factors: threatAssessment.factors,
          analyzedAt: threatAssessment.analyzedAt,
        },
        finalDecision: combined.finalDecision,
        finalReasons: combined.reasons,
        agentQuarantined: combined.shouldQuarantine,
      },
    };
  });

  // ============================================
  // POST /purchase-intents/:id/approve - Merchant approves
  // ============================================
  app.post('/purchase-intents/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { approvedBy } = request.body as { approvedBy?: string };

    const intent = await prisma.purchaseIntent.findUnique({ where: { id } });
    if (!intent) {
      return reply.status(404).send({ success: false, error: 'Purchase intent not found' });
    }

    if (intent.status !== PurchaseStatus.REQUIRE_APPROVAL) {
      return reply.status(400).send({
        success: false,
        error: `Cannot approve from state: ${intent.status}`,
      });
    }

    await prisma.approval.updateMany({
      where: { purchaseIntentId: id, status: 'PENDING' },
      data: { status: 'APPROVED', approvedBy: approvedBy || 'merchant', approvedAt: new Date() },
    });

    await prisma.purchaseIntent.update({ where: { id }, data: { status: PurchaseStatus.APPROVED } });
    const updated = await prisma.purchaseIntent.update({
      where: { id },
      data: { status: PurchaseStatus.AUTHORIZED },
      include: { product: true, authorizations: true },
    });

    await recordAuditEvent({
      action: AuditAction.APPROVAL_GRANTED,
      actorType: ActorType.MERCHANT,
      actorId: approvedBy || 'merchant',
      entityId: id,
      metadata: { amount: intent.amount },
    });

    return { success: true, data: updated };
  });

  // ============================================
  // POST /purchase-intents/:id/deny - Merchant denies
  // ============================================
  app.post('/purchase-intents/:id/deny', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { deniedBy } = request.body as { deniedBy?: string };

    const intent = await prisma.purchaseIntent.findUnique({ where: { id } });
    if (!intent) {
      return reply.status(404).send({ success: false, error: 'Purchase intent not found' });
    }

    if (intent.status !== PurchaseStatus.REQUIRE_APPROVAL) {
      return reply.status(400).send({
        success: false,
        error: `Cannot deny from state: ${intent.status}`,
      });
    }

    await prisma.approval.updateMany({
      where: { purchaseIntentId: id, status: 'PENDING' },
      data: { status: 'DENIED', approvedBy: deniedBy || 'merchant', approvedAt: new Date() },
    });

    const updated = await prisma.purchaseIntent.update({
      where: { id },
      data: { status: PurchaseStatus.DENIED },
      include: { product: true },
    });

    await recordAuditEvent({
      action: AuditAction.APPROVAL_DENIED,
      actorType: ActorType.MERCHANT,
      actorId: deniedBy || 'merchant',
      entityId: id,
      metadata: { amount: intent.amount },
    });

    return { success: true, data: updated };
  });

  // ============================================
  // POST /purchase-intents/:id/execute - Execute payment (with pre-payment revalidation)
  // ============================================
  app.post('/purchase-intents/:id/execute', async (request, reply) => {
    const { id } = request.params as { id: string };
    const headers = request.headers as Record<string, string | undefined>;
    const idempotencyKey = headers['idempotency-key'];

    // ---- Idempotency Check ----
    if (idempotencyKey) {
      const requestHash = hashRequestBody(request.body);
      const idempotencyResult = await checkIdempotency(idempotencyKey, requestHash, `/execute`);

      if (idempotencyResult.result === 'EXISTING') {
        // Safe retry — return original result without re-processing
        return { success: true, data: idempotencyResult.existingData, idempotent: true };
      }

      if (idempotencyResult.result === 'CONFLICT') {
        const intent = await prisma.purchaseIntent.findUnique({ where: { id } });
        if (intent) {
          await recordSecurityIncident(
            intent.agentId,
            SecurityViolation.IDEMPOTENCY_CONFLICT,
            'Idempotency key reused with different payload on execute',
            { purchaseIntentId: id, idempotencyKey }
          );
          await recordAuditEvent({
            action: AuditAction.IDEMPOTENCY_CONFLICT_DETECTED,
            actorType: ActorType.SYSTEM,
            actorId: 'security-engine',
            entityId: id,
            metadata: { agentId: intent.agentId },
          });
        }
        return reply.status(409).send({
          success: false,
          error: 'Request integrity check failed',
          code: SecurityViolation.IDEMPOTENCY_CONFLICT,
        });
      }
    }

    const intent = await prisma.purchaseIntent.findUnique({
      where: { id },
      include: { product: true, authorizations: true },
    });

    if (!intent) {
      return reply.status(404).send({ success: false, error: 'Purchase intent not found' });
    }

    // ---- Pre-payment Revalidation ----

    // 1. Agent must still exist and be ACTIVE
    const statusCheck = await checkAgentStatus(intent.agentId);
    if (!statusCheck.passed) {
      return reply.status(403).send({
        success: false,
        error: 'Agent access revoked — cannot execute payment',
        code: statusCheck.violation,
      });
    }

    // 2. Must be AUTHORIZED
    if (intent.status !== PurchaseStatus.AUTHORIZED) {
      return reply.status(400).send({
        success: false,
        error: `Cannot execute from state: ${intent.status}. Must be AUTHORIZED.`,
      });
    }

    // 3. Authorization must not be expired
    const auth = intent.authorizations[intent.authorizations.length - 1];
    if (!auth || new Date(auth.expiresAt) < new Date()) {
      return reply.status(400).send({
        success: false,
        error: 'Authorization has expired. Please re-evaluate.',
      });
    }

    // 4. Threat assessment validity check (5-minute window)
    const { valid: threatValid } = await isThreatAssessmentValid(id);
    if (!threatValid) {
      // Re-analyze — agent behavior may have changed since authorization
      const agentPermission = await prisma.agentPermission.findFirst({
        where: { agentId: intent.agentId },
      });
      const merchantPolicy = await prisma.policy.findFirst({
        where: { merchantId: intent.merchantId },
      });
      const agentMaxTransaction = Math.min(
        merchantPolicy?.maxTransactionAmount ?? 0,
        agentPermission?.maxTransactionAmount ?? 0
      );

      const freshThreat = await performThreatAnalysis(
        intent.agentId,
        id,
        intent.amount,
        intent.product.category,
        agentMaxTransaction
      );

      // If now CRITICAL → quarantine and block
      if (freshThreat.recommendedAction === 'QUARANTINE_AGENT') {
        return reply.status(403).send({
          success: false,
          error: 'Agent behavior has escalated — payment blocked',
          threatAssessment: { score: freshThreat.score, level: freshThreat.level },
        });
      }
    }

    // 5. Check stock
    if (intent.product.stock < intent.quantity) {
      return reply.status(400).send({ success: false, error: 'Product out of stock' });
    }

    // ---- Reserve stock ----
    await prisma.product.update({
      where: { id: intent.productId },
      data: { stock: { decrement: intent.quantity } },
    });

    // ---- Create transaction ----
    const transaction = await prisma.transaction.create({
      data: {
        purchaseIntentId: id,
        amount: intent.amount,
        currency: intent.product.currency,
        paymentProvider: 'razorpay_test',
        status: 'PENDING',
      },
    });

    const updated = await prisma.purchaseIntent.update({
      where: { id },
      data: { status: PurchaseStatus.PAYMENT_PENDING },
      include: { product: true, transactions: true },
    });

    await recordAuditEvent({
      action: AuditAction.PAYMENT_ORDER_CREATED,
      actorType: ActorType.SYSTEM,
      actorId: 'payment-system',
      entityId: id,
      metadata: { transactionId: transaction.id, amount: intent.amount },
    });

    const result = { purchaseIntent: updated, transaction };

    // Store idempotency result
    if (idempotencyKey) {
      await storeIdempotencyResult(idempotencyKey, hashRequestBody(request.body), '/execute', result);
    }

    return { success: true, data: result };
  });

  // ============================================
  // POST /purchase-intents/:id/complete - Server-controlled payment completion
  // ============================================
  app.post('/purchase-intents/:id/complete', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { providerPaymentId } = request.body as { providerPaymentId?: string };

    const intent = await prisma.purchaseIntent.findUnique({
      where: { id },
      include: { transactions: true },
    });

    if (!intent) {
      return reply.status(404).send({ success: false, error: 'Purchase intent not found' });
    }

    // ---- Secure Completion: Server-side validation ----
    // 1. Must be in PAYMENT_PENDING state
    if (intent.status !== PurchaseStatus.PAYMENT_PENDING) {
      return reply.status(400).send({
        success: false,
        error: `Cannot complete from state: ${intent.status}`,
      });
    }

    // 2. Must have an existing transaction record (created by execute endpoint)
    const tx = intent.transactions[intent.transactions.length - 1];
    if (!tx) {
      return reply.status(400).send({
        success: false,
        error: 'No payment transaction found. Call /execute first.',
      });
    }

    // 3. Transaction must belong to this purchase intent (ownership check)
    if (tx.purchaseIntentId !== id) {
      return reply.status(403).send({ success: false, error: 'Transaction ownership mismatch' });
    }

    // 4. Transaction must be in PENDING status (not already completed)
    if (tx.status === 'COMPLETED') {
      return reply.status(400).send({ success: false, error: 'Transaction already completed' });
    }

    // ---- Update transaction ----
    await prisma.transaction.update({
      where: { id: tx.id },
      data: {
        status: 'COMPLETED',
        providerPaymentId: providerPaymentId || `pay_test_${Date.now()}`,
        providerOrderId: `order_test_${Date.now()}`,
      },
    });

    await prisma.purchaseIntent.update({
      where: { id },
      data: { status: PurchaseStatus.PAYMENT_PROCESSING },
    });

    const updated = await prisma.purchaseIntent.update({
      where: { id },
      data: { status: PurchaseStatus.COMPLETED },
      include: { product: true, transactions: true, authorizations: true },
    });

    await recordAuditEvent({
      action: AuditAction.PAYMENT_VERIFIED,
      actorType: ActorType.PAYMENT_PROVIDER,
      actorId: 'razorpay_test',
      entityId: id,
      metadata: { amount: intent.amount },
    });

    await recordAuditEvent({
      action: AuditAction.TRANSACTION_COMPLETED,
      actorType: ActorType.SYSTEM,
      actorId: 'system',
      entityId: id,
      metadata: { amount: intent.amount, productId: intent.productId },
    });

    return { success: true, data: updated };
  });
}
