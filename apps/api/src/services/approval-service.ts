// ============================================
// AgentBridge - Approval Service
// ============================================
// Human-in-the-loop approval that actually requires a human.
//
// The Phase 0 audit showed an unauthenticated POST could approve any pending
// purchase, and the approving identity was a free-text string chosen by the
// caller. Four properties are now enforced structurally:
//
//   AUTHENTICATED  a decision requires a merchant-user session (route layer).
//   BOUND          the session's merchant must own the purchase intent.
//   SINGLE-USE     PENDING -> APPROVED|DENIED is a conditional update, so a
//                  replayed decision matches zero rows and is rejected.
//   TIME-LIMITED   an expired approval cannot be decided at all.
//
// The one-time token is additionally required, so possession of an approval
// link is not on its own sufficient, and the link cannot be guessed from the
// intent id.

import { prisma, type Db } from '../db.js';
import {
  ActorType,
  ApprovalStatus,
  AuditAction,
  PurchaseStatus,
  SecurityViolation,
} from '@agentbridge/shared-types';
import { generateToken, hashToken } from '../lib/crypto.js';
import { ForbiddenError, NotFoundError, SecurityError } from '../lib/errors.js';
import { recordAuditEvent } from './audit-service.js';
import { recordSecurityIncident } from './security-service.js';
import { loadPolicyState } from './policy-service.js';
import { reserveBudget, releaseBudget } from './ledger-service.js';
import { transitionIntent } from './purchase-service.js';
import { ledgerDay } from '../db.js';

/** Creates a pending approval. Returns the one-time token exactly once. */
export async function createApproval(
  db: Db,
  purchaseIntentId: string,
  ttlMs: number
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + ttlMs);
  const approval = await db.approval.create({
    data: {
      purchaseIntentId,
      status: ApprovalStatus.PENDING,
      tokenHash: hashToken(token),
      expiresAt,
    },
  });
  return { id: approval.id, token, expiresAt };
}

export interface DecideParams {
  purchaseIntentId: string;
  token: string;
  /** Authenticated merchant user. Never caller-supplied text. */
  merchantUserId: string;
  merchantId: string;
  approve: boolean;
}

/**
 * Records a human decision on a pending approval.
 *
 * On approval the budget is reserved atomically at THIS moment, not at
 * evaluation time — so an approval granted after the agent has spent its
 * remaining budget elsewhere is still correctly refused.
 */
export async function decideApproval(params: DecideParams) {
  const { purchaseIntentId, token, merchantUserId, merchantId, approve } = params;

  const intent = await prisma.purchaseIntent.findUnique({
    where: { id: purchaseIntentId },
    include: { product: true },
  });
  if (!intent) throw new NotFoundError('Purchase intent');

  // TENANT ISOLATION: approvers may only act on their own merchant's traffic.
  if (intent.merchantId !== merchantId) {
    await recordSecurityIncident({
      agentId: intent.agentId,
      type: SecurityViolation.CROSS_TENANT_ACCESS,
      description: 'Merchant user attempted to decide another merchant\'s approval',
      metadata: { purchaseIntentId, merchantUserId },
    });
    throw new NotFoundError('Purchase intent');
  }

  const approval = await prisma.approval.findFirst({
    where: { purchaseIntentId },
    orderBy: { createdAt: 'desc' },
  });
  if (!approval) throw new NotFoundError('Approval');

  // Constant-time-ish token check via digest equality.
  if (approval.tokenHash !== hashToken(token)) {
    await recordSecurityIncident({
      agentId: intent.agentId,
      type: SecurityViolation.APPROVAL_REPLAY,
      description: 'Approval decision presented an invalid token',
      metadata: { purchaseIntentId, merchantUserId },
    });
    throw new SecurityError(SecurityViolation.APPROVAL_REPLAY, 403, 'Approval token is not valid');
  }

  if (approval.expiresAt.getTime() <= Date.now()) {
    await expireApproval(approval.id, purchaseIntentId, intent.status as PurchaseStatus);
    throw new ForbiddenError('This approval request has expired', 'APPROVAL_EXPIRED');
  }

  const now = new Date();

  if (!approve) {
    return prisma.$transaction(async (tx) => {
      // SINGLE-USE: only a PENDING row can be decided.
      const claimed = await tx.approval.updateMany({
        where: { id: approval.id, status: ApprovalStatus.PENDING },
        data: { status: ApprovalStatus.DENIED, decidedById: merchantUserId, decidedAt: now },
      });
      if (claimed.count !== 1) {
        throw new ConflictOnReplay();
      }
      await transitionIntent(tx, purchaseIntentId, PurchaseStatus.REQUIRE_APPROVAL, PurchaseStatus.DENIED);
      await recordAuditEvent(
        {
          action: AuditAction.APPROVAL_DENIED,
          actorType: ActorType.MERCHANT_USER,
          actorId: merchantUserId,
          entityId: purchaseIntentId,
          metadata: { amountMinor: intent.amountMinor },
        },
        tx
      );
      return { decision: 'DENIED' as const, status: PurchaseStatus.DENIED };
    });
  }

  // ---- Approve ----
  const state = await loadPolicyState(intent.agentId, intent.merchantId);
  const day = ledgerDay(now);

  const reservation = await reserveBudget({
    agentId: intent.agentId,
    amountMinor: intent.amountMinor,
    dailyCapMinor: state.effectiveDailyCapMinor,
    countCap: state.effectiveCountCap,
    day,
  });

  if (!reservation.ok) {
    // Approved by a human, but the budget is gone. The ledger still wins.
    await prisma.$transaction(async (tx) => {
      await tx.approval.updateMany({
        where: { id: approval.id, status: ApprovalStatus.PENDING },
        data: { status: ApprovalStatus.DENIED, decidedById: merchantUserId, decidedAt: now },
      });
      await transitionIntent(tx, purchaseIntentId, PurchaseStatus.REQUIRE_APPROVAL, PurchaseStatus.BLOCKED);
    });
    throw new ForbiddenError(
      'Approved, but the agent no longer has sufficient daily budget — the purchase was blocked',
      'DAILY_LIMIT_EXCEEDED'
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const claimed = await tx.approval.updateMany({
        where: { id: approval.id, status: ApprovalStatus.PENDING },
        data: { status: ApprovalStatus.APPROVED, decidedById: merchantUserId, decidedAt: now },
      });
      if (claimed.count !== 1) throw new ConflictOnReplay();

      await transitionIntent(
        tx,
        purchaseIntentId,
        PurchaseStatus.REQUIRE_APPROVAL,
        PurchaseStatus.APPROVED
      );
      await transitionIntent(tx, purchaseIntentId, PurchaseStatus.APPROVED, PurchaseStatus.AUTHORIZED, {
        budgetHeld: true,
        ledgerDay: day,
      });

      await recordAuditEvent(
        {
          action: AuditAction.APPROVAL_GRANTED,
          actorType: ActorType.MERCHANT_USER,
          actorId: merchantUserId,
          entityId: purchaseIntentId,
          metadata: { amountMinor: intent.amountMinor, day },
        },
        tx
      );

      return { decision: 'APPROVED' as const, status: PurchaseStatus.AUTHORIZED };
    });
  } catch (error) {
    // The reservation succeeded but the state change did not commit — give the
    // budget back, or the agent would lose headroom for a purchase that never
    // happened.
    await releaseBudget({
      agentId: intent.agentId,
      day,
      amountMinor: intent.amountMinor,
    }).catch(() => undefined);
    throw error;
  }
}

class ConflictOnReplay extends SecurityError {
  constructor() {
    super(SecurityViolation.APPROVAL_REPLAY, 409, 'This approval has already been decided');
  }
}

async function expireApproval(
  approvalId: string,
  purchaseIntentId: string,
  currentStatus: PurchaseStatus
): Promise<void> {
  await prisma.approval.updateMany({
    where: { id: approvalId, status: ApprovalStatus.PENDING },
    data: { status: ApprovalStatus.EXPIRED },
  });
  if (currentStatus === PurchaseStatus.REQUIRE_APPROVAL) {
    await prisma.purchaseIntent
      .updateMany({
        where: { id: purchaseIntentId, status: PurchaseStatus.REQUIRE_APPROVAL },
        data: { status: PurchaseStatus.EXPIRED },
      })
      .catch(() => undefined);
  }
  await recordAuditEvent({
    action: AuditAction.APPROVAL_EXPIRED,
    actorType: ActorType.SYSTEM,
    actorId: 'approval-service',
    entityId: purchaseIntentId,
    metadata: {},
  });
}

/** Sweeps approvals whose deadline has passed. Called by the expiry job. */
export async function expireStaleApprovals(now: Date = new Date()): Promise<number> {
  const stale = await prisma.approval.findMany({
    where: { status: ApprovalStatus.PENDING, expiresAt: { lt: now } },
    select: { id: true, purchaseIntentId: true },
  });
  for (const a of stale) {
    const intent = await prisma.purchaseIntent.findUnique({ where: { id: a.purchaseIntentId } });
    await expireApproval(a.id, a.purchaseIntentId, (intent?.status ?? PurchaseStatus.EXPIRED) as PurchaseStatus);
  }
  return stale.length;
}
