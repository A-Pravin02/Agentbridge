// ============================================
// AgentBridge - Policy Engine Contracts
// ============================================

import type { Minor } from './money.js';
import {
  PolicyDecision,
  PolicyRule,
  ReasonCode,
  AgentStatus,
  ThreatLevel,
} from './enums.js';

// ---- Agent Permission Passport ----

/**
 * What a specific agent is allowed to do. Issued by the merchant, stored
 * server-side, and never supplied by the agent itself.
 */
export interface AgentPermissionPassport {
  agentId: string;
  /** Capability flags. */
  canSearch: boolean;
  canCreatePurchaseIntent: boolean;
  canExecutePurchase: boolean;
  /** Empty array means "no categories permitted" (deny by default). */
  allowedCategories: string[];
  /** Empty array means "no merchant restriction beyond the owning merchant". */
  allowedMerchantIds: string[];
  allowedCurrencies: string[];
  maxTransactionMinor: Minor;
  maxDailyMinor: Minor;
  maxTransactionsPerDay: number;
  /** Maximum purchase intents per rolling minute. */
  maxPerMinute: number;
  /** Inclusive local-hour window [start, end); 0-23. null disables the rule. */
  allowedHoursUtc: { start: number; end: number } | null;
  expiresAt: Date | null;
}

// ---- Merchant Policy ----

export interface MerchantPolicy {
  id: string;
  merchantId: string;
  /** Monotonic; bumped on every change so decisions are reproducible. */
  version: number;
  maxTransactionMinor: Minor;
  maxDailyMinor: Minor;
  maxTransactionsPerDay: number;
  allowedCategories: string[];
  allowedCurrencies: string[];
  approvalThresholdMinor: Minor;
  /** Risk score at or above which the transaction is blocked outright. */
  riskBlockThreshold: number;
  /** Risk score at or above which human approval is required. */
  riskApprovalThreshold: number;
  expiresAt: Date | null;
}

// ---- Engine input ----

export interface PolicyRequest {
  merchantId: string;
  agentId: string;
  productId: string;
  productCategory: string;
  /** Server-resolved authoritative amount. Never agent-supplied. */
  amountMinor: Minor;
  currency: string;
  quantity: number;
  agentReason: string;
}

export interface PolicyUsage {
  /** Budget already reserved or spent today, in minor units. */
  dailySpentMinor: Minor;
  dailyTransactionCount: number;
  /** Purchase intents created by this agent in the last rolling minute. */
  countLastMinute: number;
}

export interface PolicyRiskSignal {
  score: number;
  level: ThreatLevel;
}

/**
 * The complete, self-contained input to a policy decision.
 *
 * DETERMINISM CONTRACT: `evaluatePolicy` is a pure function of this object.
 * `now` and `decisionId` are inputs rather than being read from the ambient
 * clock or a random source, so the same context and policy version always
 * produce a byte-identical decision. This is what makes decisions replayable
 * and is asserted by the reproducibility invariant test.
 */
export interface PolicyContext {
  decisionId: string;
  now: Date;
  request: PolicyRequest;
  agentStatus: AgentStatus;
  permission: AgentPermissionPassport;
  merchantPolicy: MerchantPolicy;
  usage: PolicyUsage;
  risk: PolicyRiskSignal | null;
}

// ---- Engine output ----

export interface EvaluatedRule {
  rule: PolicyRule;
  /** The decision this rule alone would produce. */
  outcome: PolicyDecision;
  passed: boolean;
  reasonCode: ReasonCode;
  message: string;
  /** Structured detail for the dashboard: limits, observed values. */
  detail?: Record<string, unknown>;
}

export interface PolicyResult {
  decisionId: string;
  decision: PolicyDecision;
  /** The reason code of the single most restrictive failing rule. */
  reasonCode: ReasonCode;
  humanReadableReason: string;
  /** Every rule, in evaluation order — passing and failing alike. */
  evaluatedRules: EvaluatedRule[];
  /** Only the rules that did not pass. */
  violations: EvaluatedRule[];
  policyVersion: number;
  timestamp: string;
}

// ---- Threat engine contracts ----

export interface ThreatFactor {
  rule: string;
  points: number;
  message: string;
  detail?: Record<string, unknown>;
}

export interface ThreatContext {
  agentId: string;
  /** Caller-supplied clock. Keeps the analyzer pure and its output reproducible. */
  now?: Date;
  currentAmountMinor: Minor;
  currentCategory: string;
  agentMaxTransactionMinor: Minor;
  requestCountLast60Sec: number;
  blockedCountLast10Min: number;
  blockedCountLast30Min: number;
  deniedCountLast30Min: number;
  recentCompletedAmountsMinor: Minor[];
  recentCategories: string[];
  recentPolicyFailures: Array<{ amountMinor: Minor; category: string; createdAt: Date }>;
  recentPurchaseIntents: Array<{
    amountMinor: Minor;
    status: string;
    category: string;
    createdAt: Date;
  }>;
}

export interface ThreatAssessmentResult {
  score: number;
  level: ThreatLevel;
  recommendedAction: string;
  factors: ThreatFactor[];
  analyzedAt: Date;
}
