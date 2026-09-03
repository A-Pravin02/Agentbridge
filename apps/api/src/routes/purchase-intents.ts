// ============================================
// AgentBridge - Purchase Intent Routes
// ============================================
// Thin handlers. Validation, authentication and idempotency are declarative;
// all decisions live in the services.

import type { FastifyInstance } from 'fastify';
import {
  ActorType,
  PolicyDecision,
  formatMinor,
  type Currency,
} from '@agentbridge/shared-types';
import { authenticateAgent } from '../plugins/auth.js';
import {
  createPurchaseIntentSchema,
  evaluateSchema,
  createOrderSchema,
  verifyPaymentSchema,
} from '../schemas.js';
import {
  createPurchaseIntent,
  evaluatePurchaseIntent,
} from '../services/purchase-service.js';
import { createPaymentOrder, verifyAndSettle } from '../services/payment-service.js';
import { withIdempotency } from '../services/idempotency-service.js';
import { NotFoundError } from '../lib/errors.js';
import { prisma, parseJsonObject } from '../db.js';

export async function purchaseIntentRoutes(app: FastifyInstance) {
  // Every route here requires a verified Ed25519 signature.
  app.addHook('preHandler', authenticateAgent);

  // ---- Create ----
  app.post('/purchase-intents', async (request) => {
    const body = createPurchaseIntentSchema.parse(request.body ?? {});
    const agent = request.agent!;

    return withIdempotency(
      { request, agentId: agent.id, endpoint: 'POST /purchase-intents' },
      async () => {
        const intent = await createPurchaseIntent({
          agentId: agent.id,
          merchantId: agent.merchantId,
          productId: body.productId,
          quantity: body.quantity,
          agentReason: body.agentReason,
        });
        return { success: true, data: serializeIntent(intent) };
      }
    );
  });

  // ---- Evaluate ----
  app.post('/purchase-intents/:id/evaluate', async (request) => {
    evaluateSchema.parse(request.body ?? {});
    const { id } = request.params as { id: string };
    const agent = request.agent!;

    return withIdempotency(
      { request, agentId: agent.id, endpoint: 'POST /evaluate' },
      async () => {
        const outcome = await evaluatePurchaseIntent(id, agent.id);
        return {
          success: true,
          data: {
            purchaseIntent: serializeIntent(outcome.intent),
            decision: outcome.decision,
            reasonCode: outcome.policyResult.reasonCode,
            reason: outcome.policyResult.humanReadableReason,
            policyVersion: outcome.policyResult.policyVersion,
            decisionId: outcome.policyResult.decisionId,
            // The full rule trace is what makes a decision explainable.
            evaluatedRules: outcome.policyResult.evaluatedRules,
            risk: {
              score: outcome.threat.score,
              level: outcome.threat.level,
              factors: outcome.threat.factors,
            },
            agentQuarantined: outcome.quarantined,
            // Returned exactly once, only to the agent that owns the intent.
            approval:
              outcome.decision === PolicyDecision.REQUIRE_APPROVAL
                ? { token: outcome.approvalToken, expiresAt: outcome.approvalExpiresAt }
                : undefined,
          },
        };
      }
    );
  });

  // ---- Create a payment order ----
  app.post('/purchase-intents/:id/payment-order', async (request) => {
    createOrderSchema.parse(request.body ?? {});
    const { id } = request.params as { id: string };
    const agent = request.agent!;

    return withIdempotency(
      { request, agentId: agent.id, endpoint: 'POST /payment-order' },
      async () => {
        const order = await createPaymentOrder({ intentId: id, agentId: agent.id });
        return { success: true, data: order };
      }
    );
  });

  // ---- Settle a payment ----
  // Requires a provider signature. There is no path to COMPLETED without one.
  app.post('/purchase-intents/:id/verify-payment', async (request) => {
    const body = verifyPaymentSchema.parse(request.body ?? {});
    const { id } = request.params as { id: string };
    const agent = request.agent!;

    const intent = await prisma.purchaseIntent.findUnique({
      where: { id },
      select: { agentId: true },
    });
    if (!intent || intent.agentId !== agent.id) throw new NotFoundError('Purchase intent');

    return withIdempotency(
      { request, agentId: agent.id, endpoint: 'POST /verify-payment' },
      async () => {
        const settled = await verifyAndSettle({
          intentId: id,
          providerPaymentId: body.providerPaymentId,
          signature: body.signature,
          actorId: agent.id,
          actorType: ActorType.AGENT,
        });
        return { success: true, data: serializeIntent(settled) };
      }
    );
  });

  // ---- Read ----
  app.get('/purchase-intents/:id', async (request) => {
    const { id } = request.params as { id: string };
    const agent = request.agent!;

    const intent = await prisma.purchaseIntent.findUnique({
      where: { id },
      include: {
        product: true,
        authorizations: { orderBy: { createdAt: 'desc' }, take: 1 },
        approvals: { orderBy: { createdAt: 'desc' }, take: 1 },
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
        threatAssessments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    // Ownership check folded into the 404 so an agent cannot probe for the
    // existence of another agent's intents.
    if (!intent || intent.agentId !== agent.id) throw new NotFoundError('Purchase intent');

    const authorization = intent.authorizations[0];
    return {
      success: true,
      data: {
        ...serializeIntent(intent),
        decision: authorization?.decision ?? null,
        reason: authorization?.humanReason ?? null,
        evaluatedRules: authorization
          ? parseJsonObject<unknown[]>(authorization.evaluatedRules, [])
          : [],
        risk: intent.threatAssessments[0]
          ? {
              score: intent.threatAssessments[0].score,
              level: intent.threatAssessments[0].level,
            }
          : null,
        payment: intent.payments[0]
          ? {
              status: intent.payments[0].status,
              providerOrderId: intent.payments[0].providerOrderId,
              // The provider payment id is safe to echo; nothing sensitive.
              providerPaymentId: intent.payments[0].providerPaymentId,
            }
          : null,
        approvalPending: intent.approvals[0]?.status === 'PENDING',
      },
    };
  });
}

/** Adds display strings so clients never divide by 100 themselves. */
function serializeIntent(intent: {
  id: string;
  amountMinor: number;
  currency: string;
  [k: string]: unknown;
}) {
  return {
    ...intent,
    amountDisplay: formatMinor(intent.amountMinor, intent.currency as Currency),
  };
}
