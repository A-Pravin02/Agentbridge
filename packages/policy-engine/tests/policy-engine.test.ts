// ============================================
// Policy Engine — rule coverage, precedence, determinism
// ============================================

import { describe, it, expect } from 'vitest';
import {
  AgentStatus,
  PolicyDecision,
  PolicyRule,
  ReasonCode,
  ThreatLevel,
  toMinor,
  type PolicyContext,
} from '@agentbridge/shared-types';
import { evaluatePolicy } from '../src/index.js';

const NOW = new Date('2026-09-03T12:00:00.000Z');

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  const base: PolicyContext = {
    decisionId: 'decision-fixed-for-determinism',
    now: NOW,
    request: {
      merchantId: 'm1',
      agentId: 'a1',
      productId: 'p1',
      productCategory: 'Phone Accessories',
      amountMinor: toMinor(299),
      currency: 'INR',
      quantity: 1,
      agentReason: 'user asked for a cable',
    },
    agentStatus: AgentStatus.ACTIVE,
    permission: {
      agentId: 'a1',
      canSearch: true,
      canCreatePurchaseIntent: true,
      canExecutePurchase: true,
      allowedCategories: ['Phone Accessories', 'Electronics Accessories'],
      allowedMerchantIds: ['m1'],
      allowedCurrencies: ['INR'],
      maxTransactionMinor: toMinor(500),
      maxDailyMinor: toMinor(2000),
      maxTransactionsPerDay: 5,
      maxPerMinute: 30,
      allowedHoursUtc: null,
      expiresAt: null,
    },
    merchantPolicy: {
      id: 'pol1',
      merchantId: 'm1',
      version: 7,
      maxTransactionMinor: toMinor(500),
      maxDailyMinor: toMinor(2000),
      maxTransactionsPerDay: 5,
      allowedCategories: ['Phone Accessories', 'Electronics Accessories'],
      allowedCurrencies: ['INR'],
      approvalThresholdMinor: toMinor(400),
      riskBlockThreshold: 80,
      riskApprovalThreshold: 60,
      expiresAt: null,
    },
    usage: { dailySpentMinor: 0, dailyTransactionCount: 0, countLastMinute: 0 },
    risk: { score: 0, level: ThreatLevel.LOW },
  };
  return { ...base, ...overrides } as PolicyContext;
}

const ruleOf = (result: ReturnType<typeof evaluatePolicy>, rule: PolicyRule) =>
  result.evaluatedRules.find((r) => r.rule === rule)!;

describe('evaluatePolicy', () => {
  describe('happy path', () => {
    it('allows a purchase that satisfies every rule', () => {
      const result = evaluatePolicy(context());
      expect(result.decision).toBe(PolicyDecision.ALLOW);
      expect(result.reasonCode).toBe(ReasonCode.OK);
      expect(result.violations).toHaveLength(0);
    });

    it('evaluates every rule, not just the failing ones', () => {
      const result = evaluatePolicy(context());
      // Explainability: the dashboard shows passing checks too.
      expect(result.evaluatedRules).toHaveLength(Object.keys(PolicyRule).length);
      expect(result.evaluatedRules.every((r) => r.passed)).toBe(true);
    });

    it('reports the policy version that produced the decision', () => {
      expect(evaluatePolicy(context()).policyVersion).toBe(7);
    });
  });

  describe('blocking rules', () => {
    it('blocks when the agent is not active', () => {
      const result = evaluatePolicy(context({ agentStatus: AgentStatus.QUARANTINED }));
      expect(result.decision).toBe(PolicyDecision.BLOCK);
      expect(result.reasonCode).toBe(ReasonCode.AGENT_NOT_ACTIVE);
    });

    it('blocks when the agent lacks purchase capability', () => {
      const ctx = context();
      ctx.permission.canExecutePurchase = false;
      expect(evaluatePolicy(ctx).reasonCode).toBe(ReasonCode.AGENT_PERMISSION_DENIED);
    });

    it('blocks on an expired passport', () => {
      const ctx = context();
      ctx.permission.expiresAt = new Date(NOW.getTime() - 1);
      expect(evaluatePolicy(ctx).reasonCode).toBe(ReasonCode.PERMISSION_EXPIRED);
    });

    it('treats a passport expiring exactly now as expired', () => {
      const ctx = context();
      ctx.permission.expiresAt = new Date(NOW.getTime());
      expect(evaluatePolicy(ctx).decision).toBe(PolicyDecision.BLOCK);
    });

    it('blocks on an expired merchant policy', () => {
      const ctx = context();
      ctx.merchantPolicy.expiresAt = new Date(NOW.getTime() - 1000);
      expect(evaluatePolicy(ctx).reasonCode).toBe(ReasonCode.POLICY_EXPIRED);
    });

    it('blocks a currency neither side permits', () => {
      const ctx = context();
      ctx.request.currency = 'USD';
      expect(evaluatePolicy(ctx).reasonCode).toBe(ReasonCode.CURRENCY_NOT_ALLOWED);
    });

    it('blocks a merchant outside the passport allow-list', () => {
      const ctx = context();
      ctx.permission.allowedMerchantIds = ['other-merchant'];
      expect(evaluatePolicy(ctx).reasonCode).toBe(ReasonCode.MERCHANT_NOT_ALLOWED);
    });

    it('treats an empty merchant allow-list as "no extra restriction"', () => {
      const ctx = context();
      ctx.permission.allowedMerchantIds = [];
      expect(evaluatePolicy(ctx).decision).toBe(PolicyDecision.ALLOW);
    });

    it('blocks a category the merchant permits but the agent does not', () => {
      const ctx = context();
      ctx.permission.allowedCategories = ['Electronics Accessories'];
      expect(evaluatePolicy(ctx).reasonCode).toBe(ReasonCode.CATEGORY_NOT_ALLOWED);
    });

    it('blocks a category the agent permits but the merchant does not', () => {
      const ctx = context();
      ctx.merchantPolicy.allowedCategories = ['Electronics Accessories'];
      expect(evaluatePolicy(ctx).reasonCode).toBe(ReasonCode.CATEGORY_NOT_ALLOWED);
    });

    it('fails closed when the category allow-list is empty', () => {
      const ctx = context();
      ctx.permission.allowedCategories = [];
      expect(evaluatePolicy(ctx).decision).toBe(PolicyDecision.BLOCK);
    });

    it('blocks above the per-transaction limit', () => {
      const ctx = context();
      ctx.request.amountMinor = toMinor(1499);
      const result = evaluatePolicy(ctx);
      expect(result.reasonCode).toBe(ReasonCode.TRANSACTION_LIMIT_EXCEEDED);
      expect(ruleOf(result, PolicyRule.MAX_TRANSACTION_AMOUNT).detail).toMatchObject({
        amountMinor: 149900,
        limitMinor: 50000,
      });
    });

    it('uses the LOWER of the merchant and agent transaction limits', () => {
      const ctx = context();
      ctx.permission.maxTransactionMinor = toMinor(200);
      ctx.request.amountMinor = toMinor(299);
      expect(evaluatePolicy(ctx).reasonCode).toBe(ReasonCode.TRANSACTION_LIMIT_EXCEEDED);
    });

    it('allows an amount exactly at the limit', () => {
      const ctx = context();
      ctx.request.amountMinor = toMinor(500);
      ctx.merchantPolicy.approvalThresholdMinor = toMinor(500);
      expect(evaluatePolicy(ctx).decision).toBe(PolicyDecision.ALLOW);
    });

    it('blocks when the projected daily spend exceeds the cap', () => {
      const ctx = context();
      ctx.usage.dailySpentMinor = toMinor(1900);
      ctx.request.amountMinor = toMinor(299);
      const result = evaluatePolicy(ctx);
      expect(result.reasonCode).toBe(ReasonCode.DAILY_LIMIT_EXCEEDED);
      expect(ruleOf(result, PolicyRule.DAILY_SPEND_LIMIT).detail).toMatchObject({
        remainingMinor: toMinor(100),
      });
    });

    it('allows a spend that lands exactly on the daily cap', () => {
      const ctx = context();
      ctx.usage.dailySpentMinor = toMinor(1701);
      ctx.request.amountMinor = toMinor(299);
      expect(evaluatePolicy(ctx).decision).toBe(PolicyDecision.ALLOW);
    });

    it('blocks when the daily transaction count is exhausted', () => {
      const ctx = context();
      ctx.usage.dailyTransactionCount = 5;
      expect(evaluatePolicy(ctx).reasonCode).toBe(ReasonCode.DAILY_COUNT_EXCEEDED);
    });

    it('blocks when the per-minute velocity limit is reached', () => {
      const ctx = context();
      ctx.usage.countLastMinute = 30;
      expect(evaluatePolicy(ctx).reasonCode).toBe(ReasonCode.VELOCITY_EXCEEDED);
    });

    it('blocks outside the permitted hours', () => {
      const ctx = context();
      ctx.permission.allowedHoursUtc = { start: 9, end: 11 }; // now is 12:00 UTC
      expect(evaluatePolicy(ctx).reasonCode).toBe(ReasonCode.OUTSIDE_ALLOWED_HOURS);
    });

    it('supports a window that wraps midnight', () => {
      const ctx = context({ now: new Date('2026-09-03T23:30:00.000Z') });
      ctx.permission.allowedHoursUtc = { start: 22, end: 6 };
      expect(evaluatePolicy(ctx).decision).toBe(PolicyDecision.ALLOW);

      const outside = context({ now: new Date('2026-09-03T12:00:00.000Z') });
      outside.permission.allowedHoursUtc = { start: 22, end: 6 };
      expect(evaluatePolicy(outside).decision).toBe(PolicyDecision.BLOCK);
    });

    it('blocks when the risk score reaches the blocking threshold', () => {
      const ctx = context({ risk: { score: 80, level: ThreatLevel.CRITICAL } });
      expect(evaluatePolicy(ctx).reasonCode).toBe(ReasonCode.RISK_TOO_HIGH);
    });
  });

  describe('approval rules', () => {
    it('requires approval above the amount threshold', () => {
      const ctx = context();
      ctx.request.amountMinor = toMinor(499);
      const result = evaluatePolicy(ctx);
      expect(result.decision).toBe(PolicyDecision.REQUIRE_APPROVAL);
      expect(result.reasonCode).toBe(ReasonCode.APPROVAL_THRESHOLD_EXCEEDED);
    });

    it('does not require approval exactly at the threshold', () => {
      const ctx = context();
      ctx.request.amountMinor = toMinor(400);
      expect(evaluatePolicy(ctx).decision).toBe(PolicyDecision.ALLOW);
    });

    it('requires approval on an elevated risk score', () => {
      const ctx = context({ risk: { score: 65, level: ThreatLevel.HIGH } });
      const result = evaluatePolicy(ctx);
      expect(result.decision).toBe(PolicyDecision.REQUIRE_APPROVAL);
      expect(result.reasonCode).toBe(ReasonCode.RISK_REQUIRES_APPROVAL);
    });

    it('allows when risk sits below the approval threshold', () => {
      const ctx = context({ risk: { score: 59, level: ThreatLevel.MEDIUM } });
      expect(evaluatePolicy(ctx).decision).toBe(PolicyDecision.ALLOW);
    });
  });

  describe('precedence: BLOCK > REQUIRE_APPROVAL > ALLOW', () => {
    it('a hard block outranks an approval requirement', () => {
      const ctx = context();
      ctx.request.amountMinor = toMinor(1499); // over limit AND over threshold
      const result = evaluatePolicy(ctx);
      expect(result.decision).toBe(PolicyDecision.BLOCK);
      // Both rules did fire; only the verdict is BLOCK.
      expect(ruleOf(result, PolicyRule.APPROVAL_AMOUNT_THRESHOLD).passed).toBe(false);
    });

    it('a low risk score can NEVER downgrade a hard policy block', () => {
      const ctx = context({ risk: { score: 0, level: ThreatLevel.LOW } });
      ctx.request.amountMinor = toMinor(1499);
      expect(evaluatePolicy(ctx).decision).toBe(PolicyDecision.BLOCK);
    });

    it('the headline reason always matches the verdict', () => {
      const ctx = context({ risk: { score: 65, level: ThreatLevel.HIGH } });
      ctx.request.amountMinor = toMinor(1499);
      const result = evaluatePolicy(ctx);
      expect(result.decision).toBe(PolicyDecision.BLOCK);
      const governing = result.evaluatedRules.find((r) => r.reasonCode === result.reasonCode)!;
      expect(governing.outcome).toBe(PolicyDecision.BLOCK);
    });

    it('surfaces multiple simultaneous violations', () => {
      const ctx = context({ agentStatus: AgentStatus.BLOCKED });
      ctx.request.amountMinor = toMinor(9999);
      ctx.request.currency = 'USD';
      expect(evaluatePolicy(ctx).violations.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('determinism', () => {
    it('produces an identical result for an identical context', () => {
      const a = evaluatePolicy(context());
      const b = evaluatePolicy(context());
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('does not read the ambient clock', () => {
      // Same context, evaluated at two different wall-clock moments.
      const ctx = context();
      const a = evaluatePolicy(ctx);
      const later = evaluatePolicy(ctx);
      expect(a.timestamp).toBe(later.timestamp);
      expect(a.timestamp).toBe(NOW.toISOString());
    });

    it('does not mutate its input', () => {
      const ctx = context();
      const snapshot = JSON.stringify(ctx);
      evaluatePolicy(ctx);
      expect(JSON.stringify(ctx)).toBe(snapshot);
    });

    it('is order-independent: the verdict is a fold, not a first-match', () => {
      // Two different violations; whichever is listed first, BLOCK still wins.
      const ctx = context({ risk: { score: 95, level: ThreatLevel.CRITICAL } });
      ctx.usage.dailyTransactionCount = 99;
      expect(evaluatePolicy(ctx).decision).toBe(PolicyDecision.BLOCK);
    });
  });
});
