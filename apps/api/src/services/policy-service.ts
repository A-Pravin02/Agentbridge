// ============================================
// AgentBridge - Policy Service
// ============================================
// Loads authoritative policy state from the database and shapes it into the
// pure engine's input. No decision logic lives here — that is the engine's job.

import { prisma, type Db, parseJsonArray, parseJsonObject } from '../db.js';
import {
  AgentStatus,
  type AgentPermissionPassport,
  type MerchantPolicy,
} from '@agentbridge/shared-types';
import { NotFoundError } from '../lib/errors.js';

type PermissionRow = NonNullable<Awaited<ReturnType<typeof prisma.agentPermission.findUnique>>>;
type PolicyRow = NonNullable<Awaited<ReturnType<typeof prisma.policy.findUnique>>>;

export function toPassport(row: PermissionRow): AgentPermissionPassport {
  return {
    agentId: row.agentId,
    canSearch: row.canSearch,
    canCreatePurchaseIntent: row.canCreatePurchaseIntent,
    canExecutePurchase: row.canExecutePurchase,
    allowedCategories: parseJsonArray(row.allowedCategories),
    allowedMerchantIds: parseJsonArray(row.allowedMerchantIds),
    allowedCurrencies: parseJsonArray(row.allowedCurrencies),
    maxTransactionMinor: row.maxTransactionMinor,
    maxDailyMinor: row.maxDailyMinor,
    maxTransactionsPerDay: row.maxTransactionsPerDay,
    maxPerMinute: row.maxPerMinute,
    allowedHoursUtc: row.allowedHoursUtc
      ? parseJsonObject<{ start: number; end: number } | null>(row.allowedHoursUtc, null)
      : null,
    expiresAt: row.expiresAt,
  };
}

export function toMerchantPolicy(row: PolicyRow): MerchantPolicy {
  return {
    id: row.id,
    merchantId: row.merchantId,
    version: row.version,
    maxTransactionMinor: row.maxTransactionMinor,
    maxDailyMinor: row.maxDailyMinor,
    maxTransactionsPerDay: row.maxTransactionsPerDay,
    allowedCategories: parseJsonArray(row.allowedCategories),
    allowedCurrencies: parseJsonArray(row.allowedCurrencies),
    approvalThresholdMinor: row.approvalThresholdMinor,
    riskBlockThreshold: row.riskBlockThreshold,
    riskApprovalThreshold: row.riskApprovalThreshold,
    expiresAt: row.expiresAt,
  };
}

export interface LoadedPolicyState {
  passport: AgentPermissionPassport;
  merchantPolicy: MerchantPolicy;
  agentStatus: AgentStatus;
  /** The lower of the merchant's and the agent's caps — what the ledger enforces. */
  effectiveDailyCapMinor: number;
  effectiveCountCap: number;
  effectiveMaxTransactionMinor: number;
}

/**
 * Loads everything the engine needs.
 *
 * A missing passport or a missing merchant policy is a hard failure, never a
 * permissive default: an agent with no passport can do nothing at all.
 */
export async function loadPolicyState(
  agentId: string,
  merchantId: string,
  db: Db = prisma
): Promise<LoadedPolicyState> {
  const [agent, permissionRow, policyRow] = await Promise.all([
    db.agent.findUnique({ where: { id: agentId }, select: { status: true } }),
    db.agentPermission.findUnique({ where: { agentId } }),
    db.policy.findUnique({ where: { merchantId } }),
  ]);

  if (!agent) throw new NotFoundError('Agent');
  if (!permissionRow) throw new NotFoundError('Agent permission passport');
  if (!policyRow) throw new NotFoundError('Merchant policy');

  const passport = toPassport(permissionRow);
  const merchantPolicy = toMerchantPolicy(policyRow);

  return {
    passport,
    merchantPolicy,
    agentStatus: agent.status as AgentStatus,
    effectiveDailyCapMinor: Math.min(merchantPolicy.maxDailyMinor, passport.maxDailyMinor),
    effectiveCountCap: Math.min(
      merchantPolicy.maxTransactionsPerDay,
      passport.maxTransactionsPerDay
    ),
    effectiveMaxTransactionMinor: Math.min(
      merchantPolicy.maxTransactionMinor,
      passport.maxTransactionMinor
    ),
  };
}

/** Records an immutable snapshot whenever a policy changes. */
export async function bumpPolicyVersion(
  policyId: string,
  changedBy: string,
  db: Db = prisma
): Promise<number> {
  const policy = await db.policy.findUnique({ where: { id: policyId } });
  if (!policy) throw new NotFoundError('Policy');
  await db.policyVersion.create({
    data: {
      policyId,
      version: policy.version,
      changedBy,
      snapshot: JSON.stringify(toMerchantPolicy(policy)),
    },
  });
  return policy.version;
}
