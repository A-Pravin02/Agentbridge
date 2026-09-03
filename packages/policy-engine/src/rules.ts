// ============================================
// AgentBridge - Policy Rules
// ============================================
// Each rule is a pure function: PolicyContext -> EvaluatedRule.
//
// Rules are INDEPENDENT and COMPOSABLE. None of them short-circuits the others;
// the engine evaluates every rule so the dashboard can show exactly which
// checks ran, which passed, and why. The final decision is derived afterwards
// by taking the most restrictive outcome (BLOCK > REQUIRE_APPROVAL > ALLOW).
//
// A rule NEVER reads the clock, a random source, or a database. Everything it
// needs is in the context. This is what makes decisions reproducible.

import {
  PolicyContext,
  EvaluatedRule,
  PolicyDecision,
  PolicyRule,
  ReasonCode,
  AgentStatus,
  formatMinor,
  type Currency,
} from '@agentbridge/shared-types';

type Rule = (ctx: PolicyContext) => EvaluatedRule;

function pass(rule: PolicyRule, message: string, detail?: Record<string, unknown>): EvaluatedRule {
  return { rule, outcome: PolicyDecision.ALLOW, passed: true, reasonCode: ReasonCode.OK, message, detail };
}

function fail(
  rule: PolicyRule,
  outcome: PolicyDecision,
  reasonCode: ReasonCode,
  message: string,
  detail?: Record<string, unknown>
): EvaluatedRule {
  return { rule, outcome, passed: false, reasonCode, message, detail };
}

/** Formats using the request currency so reasons read correctly for any currency. */
function fmt(ctx: PolicyContext, minor: number): string {
  return formatMinor(minor, ctx.request.currency as Currency);
}

// ---- 1. Agent status ----

const agentStatusRule: Rule = (ctx) => {
  if (ctx.agentStatus !== AgentStatus.ACTIVE) {
    return fail(
      PolicyRule.AGENT_STATUS,
      PolicyDecision.BLOCK,
      ReasonCode.AGENT_NOT_ACTIVE,
      'Agent is not in an active state',
      { status: ctx.agentStatus }
    );
  }
  return pass(PolicyRule.AGENT_STATUS, 'Agent is active');
};

// ---- 2. Capability flags ----

const agentPermissionRule: Rule = (ctx) => {
  const { canCreatePurchaseIntent, canExecutePurchase } = ctx.permission;
  if (!canCreatePurchaseIntent || !canExecutePurchase) {
    return fail(
      PolicyRule.AGENT_PERMISSION,
      PolicyDecision.BLOCK,
      ReasonCode.AGENT_PERMISSION_DENIED,
      'Agent lacks the capability required to purchase',
      { canCreatePurchaseIntent, canExecutePurchase }
    );
  }
  return pass(PolicyRule.AGENT_PERMISSION, 'Agent holds purchase capability');
};

// ---- 3. Passport expiry ----

const permissionExpiryRule: Rule = (ctx) => {
  const expiresAt = ctx.permission.expiresAt;
  if (expiresAt && new Date(expiresAt).getTime() <= ctx.now.getTime()) {
    return fail(
      PolicyRule.PERMISSION_EXPIRY,
      PolicyDecision.BLOCK,
      ReasonCode.PERMISSION_EXPIRED,
      'Agent permission passport has expired',
      { expiresAt }
    );
  }
  return pass(PolicyRule.PERMISSION_EXPIRY, 'Agent permission passport is valid');
};

// ---- 4. Policy expiry ----

const policyExpiryRule: Rule = (ctx) => {
  const expiresAt = ctx.merchantPolicy.expiresAt;
  if (expiresAt && new Date(expiresAt).getTime() <= ctx.now.getTime()) {
    return fail(
      PolicyRule.POLICY_EXPIRY,
      PolicyDecision.BLOCK,
      ReasonCode.POLICY_EXPIRED,
      'Merchant policy has expired and must be renewed',
      { expiresAt }
    );
  }
  return pass(PolicyRule.POLICY_EXPIRY, 'Merchant policy is current');
};

// ---- 5. Currency ----

const currencyRule: Rule = (ctx) => {
  const currency = ctx.request.currency;
  const merchantAllows = ctx.merchantPolicy.allowedCurrencies.includes(currency);
  const agentAllows = ctx.permission.allowedCurrencies.includes(currency);
  if (!merchantAllows || !agentAllows) {
    return fail(
      PolicyRule.CURRENCY_ALLOWED,
      PolicyDecision.BLOCK,
      ReasonCode.CURRENCY_NOT_ALLOWED,
      `Currency ${currency} is not permitted`,
      { currency, merchantAllows, agentAllows }
    );
  }
  return pass(PolicyRule.CURRENCY_ALLOWED, `Currency ${currency} is permitted`);
};

// ---- 6. Merchant restriction ----

const merchantRule: Rule = (ctx) => {
  const allowed = ctx.permission.allowedMerchantIds;
  // An empty list means the passport places no extra merchant restriction.
  if (allowed.length > 0 && !allowed.includes(ctx.request.merchantId)) {
    return fail(
      PolicyRule.MERCHANT_ALLOWED,
      PolicyDecision.BLOCK,
      ReasonCode.MERCHANT_NOT_ALLOWED,
      'Agent is not permitted to transact with this merchant',
      { merchantId: ctx.request.merchantId }
    );
  }
  return pass(PolicyRule.MERCHANT_ALLOWED, 'Merchant is permitted');
};

// ---- 7. Category ----

const categoryRule: Rule = (ctx) => {
  const category = ctx.request.productCategory;
  const merchantAllows = ctx.merchantPolicy.allowedCategories.includes(category);
  const agentAllows = ctx.permission.allowedCategories.includes(category);
  if (!merchantAllows || !agentAllows) {
    return fail(
      PolicyRule.CATEGORY_ALLOWED,
      PolicyDecision.BLOCK,
      ReasonCode.CATEGORY_NOT_ALLOWED,
      `Category "${category}" is not allowed`,
      { category, merchantAllows, agentAllows }
    );
  }
  return pass(PolicyRule.CATEGORY_ALLOWED, `Category "${category}" is allowed`);
};

// ---- 8. Per-transaction ceiling ----

const maxTransactionRule: Rule = (ctx) => {
  const limit = Math.min(
    ctx.merchantPolicy.maxTransactionMinor,
    ctx.permission.maxTransactionMinor
  );
  const amount = ctx.request.amountMinor;
  if (amount > limit) {
    return fail(
      PolicyRule.MAX_TRANSACTION_AMOUNT,
      PolicyDecision.BLOCK,
      ReasonCode.TRANSACTION_LIMIT_EXCEEDED,
      `Transaction amount ${fmt(ctx, amount)} exceeds the per-transaction limit of ${fmt(ctx, limit)}`,
      { amountMinor: amount, limitMinor: limit }
    );
  }
  return pass(
    PolicyRule.MAX_TRANSACTION_AMOUNT,
    `Amount ${fmt(ctx, amount)} is within the per-transaction limit of ${fmt(ctx, limit)}`,
    { amountMinor: amount, limitMinor: limit }
  );
};

// ---- 9. Daily spend ----

const dailySpendRule: Rule = (ctx) => {
  const limit = Math.min(ctx.merchantPolicy.maxDailyMinor, ctx.permission.maxDailyMinor);
  const projected = ctx.usage.dailySpentMinor + ctx.request.amountMinor;
  if (projected > limit) {
    return fail(
      PolicyRule.DAILY_SPEND_LIMIT,
      PolicyDecision.BLOCK,
      ReasonCode.DAILY_LIMIT_EXCEEDED,
      `Daily spend would reach ${fmt(ctx, projected)}, exceeding the daily limit of ${fmt(ctx, limit)}`,
      {
        dailySpentMinor: ctx.usage.dailySpentMinor,
        projectedMinor: projected,
        limitMinor: limit,
        remainingMinor: Math.max(0, limit - ctx.usage.dailySpentMinor),
      }
    );
  }
  return pass(
    PolicyRule.DAILY_SPEND_LIMIT,
    `Daily spend ${fmt(ctx, projected)} is within the daily limit of ${fmt(ctx, limit)}`,
    { projectedMinor: projected, limitMinor: limit }
  );
};

// ---- 10. Daily transaction count ----

const dailyCountRule: Rule = (ctx) => {
  const limit = Math.min(
    ctx.merchantPolicy.maxTransactionsPerDay,
    ctx.permission.maxTransactionsPerDay
  );
  const projected = ctx.usage.dailyTransactionCount + 1;
  if (projected > limit) {
    return fail(
      PolicyRule.DAILY_TRANSACTION_COUNT,
      PolicyDecision.BLOCK,
      ReasonCode.DAILY_COUNT_EXCEEDED,
      `This would be transaction ${projected} today, exceeding the limit of ${limit}`,
      { projected, limit }
    );
  }
  return pass(
    PolicyRule.DAILY_TRANSACTION_COUNT,
    `Transaction ${projected} of ${limit} permitted today`,
    { projected, limit }
  );
};

// ---- 11. Velocity ----

const velocityRule: Rule = (ctx) => {
  const limit = ctx.permission.maxPerMinute;
  const observed = ctx.usage.countLastMinute;
  if (limit > 0 && observed >= limit) {
    return fail(
      PolicyRule.VELOCITY_LIMIT,
      PolicyDecision.BLOCK,
      ReasonCode.VELOCITY_EXCEEDED,
      `Agent has made ${observed} requests in the last minute, at or above the limit of ${limit}`,
      { observed, limit }
    );
  }
  return pass(PolicyRule.VELOCITY_LIMIT, `Request rate ${observed}/min is within the limit`, {
    observed,
    limit,
  });
};

// ---- 12. Time window ----

const timeWindowRule: Rule = (ctx) => {
  const window = ctx.permission.allowedHoursUtc;
  if (!window) {
    return pass(PolicyRule.TIME_WINDOW, 'No time-of-day restriction configured');
  }
  const hour = ctx.now.getUTCHours();
  // A window may wrap midnight, e.g. { start: 22, end: 6 }.
  const inWindow =
    window.start <= window.end
      ? hour >= window.start && hour < window.end
      : hour >= window.start || hour < window.end;
  if (!inWindow) {
    return fail(
      PolicyRule.TIME_WINDOW,
      PolicyDecision.BLOCK,
      ReasonCode.OUTSIDE_ALLOWED_HOURS,
      `Purchases are only permitted between ${window.start}:00 and ${window.end}:00 UTC (now ${hour}:00)`,
      { hour, window }
    );
  }
  return pass(PolicyRule.TIME_WINDOW, `Current hour ${hour}:00 UTC is within the allowed window`);
};

// ---- 13. Risk blocks ----

const riskBlockRule: Rule = (ctx) => {
  const threshold = ctx.merchantPolicy.riskBlockThreshold;
  if (ctx.risk && ctx.risk.score >= threshold) {
    return fail(
      PolicyRule.RISK_BLOCK_THRESHOLD,
      PolicyDecision.BLOCK,
      ReasonCode.RISK_TOO_HIGH,
      `Risk score ${ctx.risk.score} is at or above the blocking threshold of ${threshold}`,
      { score: ctx.risk.score, level: ctx.risk.level, threshold }
    );
  }
  return pass(
    PolicyRule.RISK_BLOCK_THRESHOLD,
    ctx.risk ? `Risk score ${ctx.risk.score} is below the blocking threshold` : 'No risk signal',
    ctx.risk ? { score: ctx.risk.score, threshold } : undefined
  );
};

// ---- 14. Risk requires approval ----

const riskApprovalRule: Rule = (ctx) => {
  const threshold = ctx.merchantPolicy.riskApprovalThreshold;
  if (ctx.risk && ctx.risk.score >= threshold) {
    return fail(
      PolicyRule.RISK_APPROVAL_THRESHOLD,
      PolicyDecision.REQUIRE_APPROVAL,
      ReasonCode.RISK_REQUIRES_APPROVAL,
      `Risk score ${ctx.risk.score} is at or above the approval threshold of ${threshold} — human review required`,
      { score: ctx.risk.score, level: ctx.risk.level, threshold }
    );
  }
  return pass(
    PolicyRule.RISK_APPROVAL_THRESHOLD,
    ctx.risk ? `Risk score ${ctx.risk.score} is below the approval threshold` : 'No risk signal'
  );
};

// ---- 15. Approval amount threshold ----

const approvalThresholdRule: Rule = (ctx) => {
  const threshold = ctx.merchantPolicy.approvalThresholdMinor;
  const amount = ctx.request.amountMinor;
  if (amount > threshold) {
    return fail(
      PolicyRule.APPROVAL_AMOUNT_THRESHOLD,
      PolicyDecision.REQUIRE_APPROVAL,
      ReasonCode.APPROVAL_THRESHOLD_EXCEEDED,
      `Amount ${fmt(ctx, amount)} exceeds the approval threshold of ${fmt(ctx, threshold)} — human approval required`,
      { amountMinor: amount, thresholdMinor: threshold }
    );
  }
  return pass(
    PolicyRule.APPROVAL_AMOUNT_THRESHOLD,
    `Amount ${fmt(ctx, amount)} is at or below the approval threshold of ${fmt(ctx, threshold)}`
  );
};

/**
 * The rule set, in evaluation order. Order affects only the presentation order
 * of `evaluatedRules` and which reason is surfaced first among equally
 * restrictive failures — never the final decision, which is order-independent
 * because it is a fold over `mostRestrictive`.
 */
export const POLICY_RULES: Rule[] = [
  agentStatusRule,
  agentPermissionRule,
  permissionExpiryRule,
  policyExpiryRule,
  currencyRule,
  merchantRule,
  categoryRule,
  maxTransactionRule,
  dailySpendRule,
  dailyCountRule,
  velocityRule,
  timeWindowRule,
  riskBlockRule,
  riskApprovalRule,
  approvalThresholdRule,
];
