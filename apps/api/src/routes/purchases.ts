// ============================================
// AgentBridge - Purchase Intent Routes
// Create, evaluate, approve/deny, and execute purchases
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
} from '@agentbridge/shared-types';
import { recordAuditEvent } from '../audit.js';

export async function purchaseRoutes(app: FastifyInstance) {
  // POST /purchase-intents - Create a new purchase intent
  app.post('/purchase-intents', async (request, reply) => {
    const { agentId, productId, quantity, agentReason, merchantId } = request.body as {
      agentId: string;
      productId: string;
      quantity?: number;
      agentReason: string;
      merchantId: string;
    };

    // Validate product exists and has stock
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      return reply.status(404).send({ success: false, error: 'Product not found' });
    }
    if (product.stock < (quantity || 1)) {
      return reply.status(400).send({ success: false, error: 'Product out of stock' });
    }

    // Validate agent exists and is active
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.status !== 'ACTIVE') {
      return reply.status(403).send({ success: false, error: 'Agent not found or inactive' });
    }

    const amount = product.price * (quantity || 1);

    const intent = await prisma.purchaseIntent.create({
      data: {
        merchantId: merchantId || product.merchantId,
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

  // GET /purchase-intents/:id - Get purchase intent status
  app.get('/purchase-intents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const intent = await prisma.purchaseIntent.findUnique({
      where: { id },
      include: {
        product: true,
        authorizations: true,
        approvals: true,
        transactions: true,
      },
    });

    if (!intent) {
      return reply.status(404).send({ success: false, error: 'Purchase intent not found' });
    }

    return { success: true, data: intent };
  });

  // POST /purchase-intents/:id/evaluate - Run policy engine
  app.post('/purchase-intents/:id/evaluate', async (request, reply) => {
    const { id } = request.params as { id: string };

    const intent = await prisma.purchaseIntent.findUnique({
      where: { id },
      include: { product: true },
    });

    if (!intent) {
      return reply.status(404).send({ success: false, error: 'Purchase intent not found' });
    }

    // Validate state transition
    if (!canTransition(intent.status as PurchaseStatus, PurchaseStatus.EVALUATING)) {
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

    // Get agent permission
    const agentPermission = await prisma.agentPermission.findFirst({
      where: { agentId: intent.agentId },
    });

    if (!agentPermission) {
      await prisma.purchaseIntent.update({
        where: { id },
        data: { status: PurchaseStatus.BLOCKED },
      });
      return reply.status(403).send({
        success: false,
        error: 'No agent permission found',
        decision: PolicyDecision.BLOCK,
      });
    }

    // Get merchant policy
    const merchantPolicy = await prisma.policy.findFirst({
      where: { merchantId: intent.merchantId },
    });

    if (!merchantPolicy) {
      return reply.status(400).send({ success: false, error: 'No merchant policy found' });
    }

    // Get daily spending totals
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

    // Build policy context
    const context: PolicyContext = {
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

    // EVALUATE
    const result = evaluatePolicy(context);

    // Record audit
    await recordAuditEvent({
      action: AuditAction.POLICY_EVALUATED,
      actorType: ActorType.SYSTEM,
      actorId: 'policy-engine',
      entityId: intent.id,
      metadata: {
        decision: result.decision,
        reasons: result.reasons,
        violations: result.violations,
        amount: intent.amount,
      },
    });

    // Map decision to purchase status
    let newStatus: PurchaseStatus;
    let auditAction: AuditAction;

    switch (result.decision) {
      case PolicyDecision.ALLOW:
        newStatus = PurchaseStatus.AUTHORIZED;
        auditAction = AuditAction.PURCHASE_ALLOWED;
        break;
      case PolicyDecision.REQUIRE_APPROVAL:
        newStatus = PurchaseStatus.REQUIRE_APPROVAL;
        auditAction = AuditAction.APPROVAL_REQUESTED;
        break;
      case PolicyDecision.BLOCK:
        newStatus = PurchaseStatus.BLOCKED;
        auditAction = AuditAction.PURCHASE_BLOCKED;
        break;
    }

    // Update status
    const updated = await prisma.purchaseIntent.update({
      where: { id },
      data: { status: newStatus },
      include: { product: true },
    });

    // Create authorization record
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
        decision: result.decision,
        reasons: JSON.stringify(result.reasons),
        policySnapshot: JSON.stringify(policySnapshot),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 min expiry
      },
    });

    // Create approval record if needed
    if (result.decision === PolicyDecision.REQUIRE_APPROVAL) {
      await prisma.approval.create({
        data: {
          purchaseIntentId: id,
          status: 'PENDING',
        },
      });
    }

    // Record decision audit
    await recordAuditEvent({
      action: auditAction,
      actorType: ActorType.SYSTEM,
      actorId: 'policy-engine',
      entityId: intent.id,
      metadata: { decision: result.decision, amount: intent.amount },
    });

    return {
      success: true,
      data: {
        purchaseIntent: updated,
        authorization: {
          ...authorization,
          reasons: result.reasons,
          policySnapshot,
        },
        policyResult: result,
      },
    };
  });

  // POST /purchase-intents/:id/approve - Merchant approves
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

    // Update approval
    await prisma.approval.updateMany({
      where: { purchaseIntentId: id, status: 'PENDING' },
      data: { status: 'APPROVED', approvedBy: approvedBy || 'merchant', approvedAt: new Date() },
    });

    // Transition: REQUIRE_APPROVAL → APPROVED → AUTHORIZED
    await prisma.purchaseIntent.update({
      where: { id },
      data: { status: PurchaseStatus.APPROVED },
    });

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

  // POST /purchase-intents/:id/deny - Merchant denies
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

  // POST /purchase-intents/:id/execute - Execute payment
  app.post('/purchase-intents/:id/execute', async (request, reply) => {
    const { id } = request.params as { id: string };

    const intent = await prisma.purchaseIntent.findUnique({
      where: { id },
      include: { product: true, authorizations: true },
    });

    if (!intent) {
      return reply.status(404).send({ success: false, error: 'Purchase intent not found' });
    }

    // Must be AUTHORIZED
    if (intent.status !== PurchaseStatus.AUTHORIZED) {
      return reply.status(400).send({
        success: false,
        error: `Cannot execute from state: ${intent.status}. Must be AUTHORIZED.`,
      });
    }

    // Check authorization hasn't expired
    const auth = intent.authorizations[intent.authorizations.length - 1];
    if (!auth || new Date(auth.expiresAt) < new Date()) {
      return reply.status(400).send({
        success: false,
        error: 'Authorization has expired. Please re-evaluate.',
      });
    }

    // Check stock
    if (intent.product.stock < intent.quantity) {
      return reply.status(400).send({ success: false, error: 'Product out of stock' });
    }

    // Reserve stock
    await prisma.product.update({
      where: { id: intent.productId },
      data: { stock: { decrement: intent.quantity } },
    });

    // Create transaction
    const transaction = await prisma.transaction.create({
      data: {
        purchaseIntentId: id,
        amount: intent.amount,
        currency: intent.product.currency,
        paymentProvider: 'razorpay_test',
        status: 'PENDING',
      },
    });

    // Update to PAYMENT_PENDING
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

    return {
      success: true,
      data: {
        purchaseIntent: updated,
        transaction,
      },
    };
  });

  // POST /purchase-intents/:id/complete - Simulate payment completion (for demo)
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

    if (intent.status !== PurchaseStatus.PAYMENT_PENDING) {
      return reply.status(400).send({
        success: false,
        error: `Cannot complete from state: ${intent.status}`,
      });
    }

    // Update transaction
    const tx = intent.transactions[intent.transactions.length - 1];
    if (tx) {
      await prisma.transaction.update({
        where: { id: tx.id },
        data: {
          status: 'COMPLETED',
          providerPaymentId: providerPaymentId || `pay_test_${Date.now()}`,
          providerOrderId: `order_test_${Date.now()}`,
        },
      });
    }

    // PAYMENT_PENDING → PAYMENT_PROCESSING → COMPLETED
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
