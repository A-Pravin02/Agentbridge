// ============================================
// AgentBridge - Purchase Service
// ============================================
// The orchestration layer. Route handlers stay thin; all business rules,
// state transitions and transaction boundaries live here.
//
// ORDER OF OPERATIONS FOR AN EVALUATION — this order is the security design:
//
//   1. Load AUTHORITATIVE product data (price comes from the database; the
//      agent's opinion of the price is never read).
//   2. Verify tenancy: the agent, the product and the policy must belong to
//      the same merchant.
//   3. Run the behavioural threat analyzer.
//   4. Run the deterministic policy engine over an advisory usage snapshot.
//   5. If — and only if — the engine says ALLOW, atomically RESERVE budget.
//      The reservation is the enforcement; step 4 is the explanation. If the
//      reservation fails the verdict is downgraded to BLOCK regardless of what
//      step 4 concluded, because the ledger is the authority.
//   6. Persist the decision and transition state inside one transaction.

import {
  ActorType,
  AuditAction,
  PolicyDecision,
  PurchaseStatus,
  ReasonCode,
  SecurityViolation,
  ThreatLevel,
  formatMinor,
  multiplyMinor,
  type Currency,
  type PolicyContext,
  type PolicyResult,
  type ThreatAssessmentResult,
} from '@agentbridge/shared-types';
import { evaluatePolicy, assertTransition, InvalidTransitionError } from '@agentbridge/policy-engine';
import { randomUUID } from 'crypto';
import { prisma, ledgerDay, type Db } from '../db.js';
import { getConfig } from '../config.js';
import { ForbiddenError, NotFoundError, StateError } from '../lib/errors.js';
import { recordAuditEvent } from './audit-service.js';
import { loadPolicyState } from './policy-service.js';
import { performThreatAnalysis } from './threat-service.js';
import { reserveBudget, releaseBudget, getUsage } from './ledger-service.js';
import { recordSecurityIncident, quarantineAgent } from './security-service.js';
import { createApproval } from './approval-service.js';
import { QuarantineTrigger } from '@agentbridge/shared-types';

// ---- State transitions ----

/**
 * Moves a purchase intent to a new status, validating the edge against the
 * state machine INSIDE the transaction and refusing if another writer changed
 * the row first (`where` pins the expected current status).
 *
 * This is the only way status is ever written. There are no raw status updates
 * anywhere in the codebase.
 */
export async function transitionIntent(
  db: Db,
  intentId: string,
  from: PurchaseStatus,
  to: PurchaseStatus,
  extra: Record<string, unknown> = {}
): Promise<void> {
  assertTransition(from, to);
  const result = await db.purchaseIntent.updateMany({
    where: { id: intentId, status: from },
    data: { status: to, ...extra },
  });
  if (result.count !== 1) {
    throw new StateError(
      `Purchase intent is no longer in state ${from}; another operation changed it first`,
      { expected: from, attempted: to }
    );
  }
}

// ---- Create ----

export interface CreateIntentParams {
  agentId: string;
  merchantId: string;
  productId: string;
  quantity: number;
  agentReason: string;
}

export async function createPurchaseIntent(params: CreateIntentParams) {
  const { agentId, merchantId, productId, quantity, agentReason } = params;

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || !product.active) throw new NotFoundError('Product');

  // TENANT ISOLATION: an agent may only transact against its own merchant's
  // catalogue. The audit found this check entirely absent.
  if (product.merchantId !== merchantId) {
    await recordSecurityIncident({
      agentId,
      type: SecurityViolation.CROSS_TENANT_ACCESS,
      description: 'Agent attempted to purchase another merchant\'s product',
      metadata: { productId, productMerchantId: product.merchantId, agentMerchantId: merchantId },
    });
    // Deliberately indistinguishable from "no such product": a probing agent
    // must not be able to enumerate other merchants' catalogues.
    throw new NotFoundError('Product');
  }

  if (product.stock < quantity) {
    throw new ForbiddenError('Product is out of stock', 'OUT_OF_STOCK');
  }

  // AUTHORITATIVE PRICING: computed from the stored price. No caller-supplied
  // amount is read anywhere in this function. `multiplyMinor` rejects a
  // non-positive quantity and any result outside the safe integer range.
  const amountMinor = multiplyMinor(product.priceMinor, quantity);

  const intent = await prisma.purchaseIntent.create({
    data: {
      merchantId: product.merchantId,
      agentId,
      productId,
      quantity,
      amountMinor,
      currency: product.currency,
      status: PurchaseStatus.CREATED,
      agentReason,
    },
    include: { product: true },
  });

  await recordAuditEvent({
    action: AuditAction.PURCHASE_INTENT_CREATED,
    actorType: ActorType.AGENT,
    actorId: agentId,
    entityId: intent.id,
    metadata: { productId, quantity, amountMinor, currency: product.currency, agentReason },
  });

  return intent;
}

// ---- Evaluate ----

export interface EvaluationOutcome {
  intent: Awaited<ReturnType<typeof createPurchaseIntent>>;
  decision: PolicyDecision;
  policyResult: PolicyResult;
  threat: ThreatAssessmentResult;
  authorizationId: string;
  approvalToken?: string;
  approvalExpiresAt?: Date;
  quarantined: boolean;
}

export async function evaluatePurchaseIntent(
  intentId: string,
  agentId: string
): Promise<EvaluationOutcome> {
  const config = getConfig();
  const now = new Date();

  const intent = await prisma.purchaseIntent.findUnique({
    where: { id: intentId },
    include: { product: true },
  });
  if (!intent) throw new NotFoundError('Purchase intent');

  // OWNERSHIP: only the agent that created an intent may evaluate it.
  if (intent.agentId !== agentId) {
    await recordSecurityIncident({
      agentId,
      type: SecurityViolation.CROSS_TENANT_ACCESS,
      description: 'Agent attempted to evaluate a purchase intent it does not own',
      metadata: { intentId },
    });
    throw new NotFoundError('Purchase intent');
  }

  if (intent.status !== PurchaseStatus.CREATED) {
    throw new StateError(`Cannot evaluate a purchase intent in state ${intent.status}`, {
      status: intent.status,
    });
  }

  const state = await loadPolicyState(agentId, intent.merchantId);

  // Re-derive the amount from the CURRENT product price. If the catalogue
  // changed since the intent was created, the stale amount is not honoured.
  const currentAmountMinor = multiplyMinor(intent.product.priceMinor, intent.quantity);
  if (currentAmountMinor !== intent.amountMinor) {
    await prisma.purchaseIntent.update({
      where: { id: intentId },
      data: { amountMinor: currentAmountMinor },
    });
    intent.amountMinor = currentAmountMinor;
  }

  await transitionIntent(prisma, intentId, PurchaseStatus.CREATED, PurchaseStatus.EVALUATING);

  // ---- Threat analysis ----
  const threat = await performThreatAnalysis({
    agentId,
    purchaseIntentId: intentId,
    amountMinor: intent.amountMinor,
    category: intent.product.category,
    agentMaxTransactionMinor: state.effectiveMaxTransactionMinor,
    now,
  });

  // ---- Policy evaluation (advisory usage snapshot) ----
  const day = ledgerDay(now);
  const usage = await getUsage(agentId, day);
  const countLastMinute = await prisma.purchaseIntent.count({
    where: { agentId, createdAt: { gte: new Date(now.getTime() - 60_000) } },
  });

  const decisionId = randomUUID();
  const context: PolicyContext = {
    decisionId,
    now,
    request: {
      merchantId: intent.merchantId,
      agentId,
      productId: intent.productId,
      productCategory: intent.product.category,
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      quantity: intent.quantity,
      agentReason: intent.agentReason,
    },
    agentStatus: state.agentStatus,
    permission: state.passport,
    merchantPolicy: state.merchantPolicy,
    usage: {
      dailySpentMinor: usage.reservedMinor,
      dailyTransactionCount: usage.txnCount,
      countLastMinute,
    },
    risk: { score: threat.score, level: threat.level },
  };

  const policyResult = evaluatePolicy(context);
  let decision = policyResult.decision;

  await recordAuditEvent({
    action: AuditAction.POLICY_EVALUATED,
    actorType: ActorType.SYSTEM,
    actorId: 'policy-engine',
    entityId: intentId,
    metadata: {
      decisionId,
      decision,
      reasonCode: policyResult.reasonCode,
      policyVersion: policyResult.policyVersion,
      amountMinor: intent.amountMinor,
      riskScore: threat.score,
    },
  });

  // ---- Budget reservation: the authority ----
  //
  // Only an ALLOW reserves. REQUIRE_APPROVAL reserves at approval time, so a
  // pending approval cannot silently consume budget it may never use.
  let reservedDay: string | null = null;
  let ledgerReason: string | null = null;

  if (decision === PolicyDecision.ALLOW) {
    const reservation = await reserveBudget({
      agentId,
      amountMinor: intent.amountMinor,
      dailyCapMinor: state.effectiveDailyCapMinor,
      countCap: state.effectiveCountCap,
      day,
    });

    if (reservation.ok) {
      reservedDay = reservation.day;
      await recordAuditEvent({
        action: AuditAction.BUDGET_RESERVED,
        actorType: ActorType.SYSTEM,
        actorId: 'ledger',
        entityId: intentId,
        metadata: {
          agentId,
          day: reservation.day,
          amountMinor: intent.amountMinor,
          reservedAfterMinor: reservation.reservedAfterMinor,
        },
      });
    } else {
      // The ledger refused. It outranks the engine's advisory verdict, which
      // was computed against a snapshot that a concurrent request has since
      // invalidated. This is the branch that makes the daily cap unbreachable.
      decision = PolicyDecision.BLOCK;
      ledgerReason =
        reservation.reason === 'DAILY_COUNT_EXCEEDED'
          ? `Daily transaction count limit reached (${reservation.txnCount}/${state.effectiveCountCap})`
          : `Daily spending limit reached — ${formatMinor(reservation.remainingMinor, intent.currency as Currency)} remaining, ${formatMinor(intent.amountMinor, intent.currency as Currency)} requested`;
    }
  }

  // ---- Quarantine on critical threat ----
  const quarantined = threat.level === ThreatLevel.CRITICAL;
  if (quarantined) {
    await quarantineAgent(
      agentId,
      `Critical behavioural threat (score ${threat.score}/100)`,
      QuarantineTrigger.AUTOMATIC_THREAT_DETECTION
    );
  }

  // ---- Persist decision + transition, atomically ----
  const finalStatus =
    decision === PolicyDecision.ALLOW
      ? PurchaseStatus.AUTHORIZED
      : decision === PolicyDecision.REQUIRE_APPROVAL
        ? PurchaseStatus.REQUIRE_APPROVAL
        : PurchaseStatus.BLOCKED;

  const humanReason = ledgerReason ?? policyResult.humanReadableReason;

  // If the transaction below fails after a successful reservation, the budget
  // would be held for a purchase that never exists. Release it rather than
  // silently shrinking the agent's remaining headroom.
  const persist = () =>
    prisma.$transaction(async (tx) => {
      await transitionIntent(tx, intentId, PurchaseStatus.EVALUATING, finalStatus, {
        budgetHeld: reservedDay !== null,
        ledgerDay: reservedDay,
      });

      const authorization = await tx.authorization.create({
        data: {
          purchaseIntentId: intentId,
          decisionId,
          decision,
          reasonCode: ledgerReason ? ReasonCode.DAILY_LIMIT_EXCEEDED : policyResult.reasonCode,
          humanReason,
          evaluatedRules: JSON.stringify(policyResult.evaluatedRules),
          policySnapshot: JSON.stringify(state.merchantPolicy),
          policyVersion: policyResult.policyVersion,
          riskScore: threat.score,
          expiresAt: new Date(now.getTime() + config.AUTHORIZATION_TTL_MS),
        },
      });

      let token: string | undefined;
      let expiresAt: Date | undefined;
      if (decision === PolicyDecision.REQUIRE_APPROVAL) {
        const approval = await createApproval(tx, intentId, config.APPROVAL_TTL_MS);
        token = approval.token;
        expiresAt = approval.expiresAt;
      }

      return { authorizationId: authorization.id, approvalToken: token, approvalExpiresAt: expiresAt };
    });

  let persisted: Awaited<ReturnType<typeof persist>>;
  try {
    persisted = await persist();
  } catch (error) {
    if (reservedDay) {
      await releaseBudget({
        agentId,
        day: reservedDay,
        amountMinor: intent.amountMinor,
      }).catch(() => undefined);
    }
    throw error;
  }
  const { authorizationId, approvalToken, approvalExpiresAt } = persisted;

  await recordAuditEvent({
    action:
      decision === PolicyDecision.ALLOW
        ? AuditAction.PURCHASE_ALLOWED
        : decision === PolicyDecision.REQUIRE_APPROVAL
          ? AuditAction.APPROVAL_REQUESTED
          : AuditAction.PURCHASE_BLOCKED,
    actorType: ActorType.SYSTEM,
    actorId: 'agentbridge',
    entityId: intentId,
    metadata: {
      decisionId,
      decision,
      amountMinor: intent.amountMinor,
      riskScore: threat.score,
      riskLevel: threat.level,
      quarantined,
      reason: humanReason,
    },
  });

  const updated = await prisma.purchaseIntent.findUniqueOrThrow({
    where: { id: intentId },
    include: { product: true },
  });

  return {
    intent: updated,
    decision,
    policyResult: ledgerReason
      ? { ...policyResult, decision, humanReadableReason: humanReason, reasonCode: ReasonCode.DAILY_LIMIT_EXCEEDED }
      : policyResult,
    threat,
    authorizationId,
    approvalToken,
    approvalExpiresAt,
    quarantined,
  };
}

// ---- Release budget when an intent will never be paid ----

export async function releaseIntentBudget(intentId: string, reason: string): Promise<void> {
  const intent = await prisma.purchaseIntent.findUnique({ where: { id: intentId } });
  if (!intent || !intent.budgetHeld || !intent.ledgerDay) return;

  const released = await prisma.$transaction(async (tx) => {
    // Clearing the flag conditionally makes a double release impossible.
    const cleared = await tx.purchaseIntent.updateMany({
      where: { id: intentId, budgetHeld: true },
      data: { budgetHeld: false },
    });
    if (cleared.count !== 1) return false;
    return releaseBudget(
      { agentId: intent.agentId, day: intent.ledgerDay!, amountMinor: intent.amountMinor },
      tx
    );
  });

  if (released) {
    await recordAuditEvent({
      action: AuditAction.BUDGET_RELEASED,
      actorType: ActorType.SYSTEM,
      actorId: 'ledger',
      entityId: intentId,
      metadata: { agentId: intent.agentId, amountMinor: intent.amountMinor, reason },
    });
  }
}

export { InvalidTransitionError };
