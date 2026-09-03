import { describe, it, expect } from 'vitest';
import { analyzeThreat } from '../src/index.js';
import { checkRequestFrequency } from '../src/rules/request-frequency.js';
import { checkBlockedAttempts } from '../src/rules/blocked-attempts.js';
import { checkPolicyProbing } from '../src/rules/policy-probing.js';
import { checkNearLimit } from '../src/rules/near-limit.js';
import { checkSpendingSpike } from '../src/rules/spending-spike.js';
import { checkRapidEscalation } from '../src/rules/rapid-escalation.js';
import { checkCategorySwitching } from '../src/rules/category-switching.js';
import { checkDeniedApprovals } from '../src/rules/denied-approvals.js';
import {
  ThreatContext,
  ThreatRule,
  ThreatLevel,
  ThreatAction,
} from '@agentbridge/shared-types';

function createMockContext(overrides: Partial<ThreatContext> = {}): ThreatContext {
  return {
    agentId: 'test-agent-1',
    currentAmountMinor: 299,
    currentCategory: 'Electronics Accessories',
    agentMaxTransactionMinor: 1000,
    requestCountLast60Sec: 1,
    blockedCountLast10Min: 0,
    blockedCountLast30Min: 0,
    deniedCountLast30Min: 0,
    recentCompletedAmountsMinor: [299, 350, 280],
    recentCategories: ['Electronics Accessories'],
    recentPolicyFailures: [],
    recentPurchaseIntents: [],
    ...overrides,
  };
}

describe('Behavioral Threat Analyzer (@agentbridge/threat-analyzer)', () => {
  describe('Rule 1 & 2: Request Frequency', () => {
    it('returns null for normal request frequency (<= 5)', () => {
      const ctx = createMockContext({ requestCountLast60Sec: 4 });
      expect(checkRequestFrequency(ctx)).toBeNull();
    });

    it('triggers HIGH_REQUEST_FREQUENCY (+20) for > 5 requests in 60s', () => {
      const ctx = createMockContext({ requestCountLast60Sec: 8 });
      const factor = checkRequestFrequency(ctx);
      expect(factor).not.toBeNull();
      expect(factor?.rule).toBe(ThreatRule.HIGH_REQUEST_FREQUENCY);
      expect(factor?.points).toBe(20);
    });

    it('triggers EXTREME_REQUEST_FREQUENCY (+50) for > 15 requests in 60s', () => {
      const ctx = createMockContext({ requestCountLast60Sec: 18 });
      const factor = checkRequestFrequency(ctx);
      expect(factor).not.toBeNull();
      expect(factor?.rule).toBe(ThreatRule.EXTREME_REQUEST_FREQUENCY);
      expect(factor?.points).toBe(50);
    });
  });

  describe('Rule 3 & 4: Blocked Attempts', () => {
    it('returns null for low blocked attempts', () => {
      const ctx = createMockContext({ blockedCountLast10Min: 1, blockedCountLast30Min: 2 });
      expect(checkBlockedAttempts(ctx)).toBeNull();
    });

    it('triggers REPEATED_BLOCKED_ATTEMPTS (+30) for >= 3 blocked in 10min', () => {
      const ctx = createMockContext({ blockedCountLast10Min: 3, blockedCountLast30Min: 3 });
      const factor = checkBlockedAttempts(ctx);
      expect(factor).not.toBeNull();
      expect(factor?.rule).toBe(ThreatRule.REPEATED_BLOCKED_ATTEMPTS);
      expect(factor?.points).toBe(30);
    });

    it('triggers EXCESSIVE_BLOCKED_ATTEMPTS (+60) for >= 6 blocked in 30min', () => {
      const ctx = createMockContext({ blockedCountLast10Min: 3, blockedCountLast30Min: 7 });
      const factor = checkBlockedAttempts(ctx);
      expect(factor).not.toBeNull();
      expect(factor?.rule).toBe(ThreatRule.EXCESSIVE_BLOCKED_ATTEMPTS);
      expect(factor?.points).toBe(60);
    });
  });

  describe('Rule 5: Policy Probing', () => {
    it('returns null for fewer than 3 failures', () => {
      const ctx = createMockContext({
        recentPolicyFailures: [
          { amountMinor: 500, category: 'Electronics', createdAt: new Date() },
          { amountMinor: 600, category: 'Electronics', createdAt: new Date() },
        ],
      });
      expect(checkPolicyProbing(ctx)).toBeNull();
    });

    it('returns null if failures are identical (single misconfigured request repeated)', () => {
      const ctx = createMockContext({
        recentPolicyFailures: [
          { amountMinor: 500, category: 'Electronics', createdAt: new Date() },
          { amountMinor: 500, category: 'Electronics', createdAt: new Date() },
          { amountMinor: 500, category: 'Electronics', createdAt: new Date() },
        ],
      });
      expect(checkPolicyProbing(ctx)).toBeNull();
    });

    it('triggers REPEATED_POLICY_PROBING (+40) on distinct failure variations', () => {
      const ctx = createMockContext({
        recentPolicyFailures: [
          { amountMinor: 1500, category: 'Electronics', createdAt: new Date() },
          { amountMinor: 1200, category: 'Electronics', createdAt: new Date() },
          { amountMinor: 999, category: 'Phones', createdAt: new Date() },
        ],
      });
      const factor = checkPolicyProbing(ctx);
      expect(factor).not.toBeNull();
      expect(factor?.rule).toBe(ThreatRule.REPEATED_POLICY_PROBING);
      expect(factor?.points).toBe(40);
    });
  });

  describe('Rule 6: Near Limit Attempts', () => {
    it('returns null when attempts are below 90% threshold', () => {
      const ctx = createMockContext({
        agentMaxTransactionMinor: 1000,
        currentAmountMinor: 500,
        recentPurchaseIntents: [
          { amountMinor: 400, status: 'COMPLETED', category: 'General', createdAt: new Date() },
        ],
      });
      expect(checkNearLimit(ctx)).toBeNull();
    });

    it('triggers REPEATED_NEAR_LIMIT_ATTEMPTS (+15) for >= 2 attempts >= 90% limit', () => {
      const ctx = createMockContext({
        agentMaxTransactionMinor: 1000,
        currentAmountMinor: 950,
        recentPurchaseIntents: [
          { amountMinor: 920, status: 'COMPLETED', category: 'General', createdAt: new Date() },
        ],
      });
      const factor = checkNearLimit(ctx);
      expect(factor).not.toBeNull();
      expect(factor?.rule).toBe(ThreatRule.REPEATED_NEAR_LIMIT_ATTEMPTS);
      expect(factor?.points).toBe(15);
    });
  });

  describe('Rule 7: Unusual Spending Spike', () => {
    it('returns null with insufficient transaction history (<3 samples)', () => {
      const ctx = createMockContext({
        recentCompletedAmountsMinor: [100, 100],
        currentAmountMinor: 800,
      });
      expect(checkSpendingSpike(ctx)).toBeNull();
    });

    it('triggers UNUSUAL_SPENDING_SPIKE (+15) when current is > 1.5x average', () => {
      const ctx = createMockContext({
        recentCompletedAmountsMinor: [200, 200, 200], // avg = 200, threshold = 300
        currentAmountMinor: 450,
      });
      const factor = checkSpendingSpike(ctx);
      expect(factor).not.toBeNull();
      expect(factor?.rule).toBe(ThreatRule.UNUSUAL_SPENDING_SPIKE);
      expect(factor?.points).toBe(15);
    });
  });

  describe('Rule 8: Rapid Escalation', () => {
    it('triggers RAPID_ESCALATION (+15) when strictly increasing >= 1.5x sequence', () => {
      const now = Date.now();
      const ctx = createMockContext({
        currentAmountMinor: 800,
        recentPurchaseIntents: [
          { amountMinor: 200, status: 'COMPLETED', category: 'Tech', createdAt: new Date(now - 300000) },
          { amountMinor: 400, status: 'COMPLETED', category: 'Tech', createdAt: new Date(now - 200000) },
          { amountMinor: 600, status: 'COMPLETED', category: 'Tech', createdAt: new Date(now - 100000) },
        ],
      });
      const factor = checkRapidEscalation(ctx);
      expect(factor).not.toBeNull();
      expect(factor?.rule).toBe(ThreatRule.RAPID_ESCALATION);
      expect(factor?.points).toBe(15);
    });

    it('returns null for non-increasing sequence', () => {
      const now = Date.now();
      const ctx = createMockContext({
        currentAmountMinor: 500,
        recentPurchaseIntents: [
          { amountMinor: 400, status: 'COMPLETED', category: 'Tech', createdAt: new Date(now - 300000) },
          { amountMinor: 300, status: 'COMPLETED', category: 'Tech', createdAt: new Date(now - 200000) },
          { amountMinor: 500, status: 'COMPLETED', category: 'Tech', createdAt: new Date(now - 100000) },
        ],
      });
      expect(checkRapidEscalation(ctx)).toBeNull();
    });
  });

  describe('Rule 9: Category Switching', () => {
    it('triggers SUSPICIOUS_CATEGORY_SWITCHING (+10) on rapid switching across categories', () => {
      const ctx = createMockContext({
        recentCategories: ['Electronics', 'Books'],
        currentCategory: 'Luxury Watches',
      });
      const factor = checkCategorySwitching(ctx);
      expect(factor).not.toBeNull();
      expect(factor?.rule).toBe(ThreatRule.SUSPICIOUS_CATEGORY_SWITCHING);
      expect(factor?.points).toBe(10);
    });

    it('returns null when category is not new', () => {
      const ctx = createMockContext({
        recentCategories: ['Electronics', 'Books'],
        currentCategory: 'Electronics',
      });
      expect(checkCategorySwitching(ctx)).toBeNull();
    });
  });

  describe('Rule 10: Denied Approvals', () => {
    it('triggers REPEATED_DENIED_APPROVALS (+20) for >= 2 denied in 30min', () => {
      const ctx = createMockContext({ deniedCountLast30Min: 2 });
      const factor = checkDeniedApprovals(ctx);
      expect(factor).not.toBeNull();
      expect(factor?.rule).toBe(ThreatRule.REPEATED_DENIED_APPROVALS);
      expect(factor?.points).toBe(20);
    });
  });

  describe('analyzeThreat & Multiple Security Warnings', () => {
    it('evaluates a clean agent as LOW threat and CONTINUE', () => {
      const ctx = createMockContext();
      const result = analyzeThreat(ctx);
      expect(result.score).toBe(0);
      expect(result.level).toBe(ThreatLevel.LOW);
      expect(result.recommendedAction).toBe(ThreatAction.CONTINUE);
      expect(result.factors).toHaveLength(0);
    });

    it('adds +20 bonus for MULTIPLE_SECURITY_WARNINGS when >= 3 rules trigger', () => {
      const ctx = createMockContext({
        requestCountLast60Sec: 8, // +20 (HIGH_REQUEST_FREQUENCY)
        blockedCountLast10Min: 3, // +30 (REPEATED_BLOCKED_ATTEMPTS)
        deniedCountLast30Min: 2,  // +20 (REPEATED_DENIED_APPROVALS)
        // 3 rules triggered -> +20 bonus = 90 total score
      });

      const result = analyzeThreat(ctx);
      expect(result.factors.some(f => f.rule === ThreatRule.MULTIPLE_SECURITY_WARNINGS)).toBe(true);
      expect(result.score).toBe(90);
      expect(result.level).toBe(ThreatLevel.CRITICAL);
      expect(result.recommendedAction).toBe(ThreatAction.QUARANTINE_AGENT);
    });

    it('maps HIGH threat score (60-79) to REQUIRE_APPROVAL', () => {
      const ctx = createMockContext({
        blockedCountLast30Min: 6, // +60 (EXCESSIVE_BLOCKED_ATTEMPTS)
      });
      const result = analyzeThreat(ctx);
      expect(result.score).toBe(60);
      expect(result.level).toBe(ThreatLevel.HIGH);
      expect(result.recommendedAction).toBe(ThreatAction.REQUIRE_APPROVAL);
    });

    it('caps maximum threat score at 100', () => {
      const ctx = createMockContext({
        requestCountLast60Sec: 20, // +50
        blockedCountLast30Min: 8,  // +60
        deniedCountLast30Min: 3,   // +20
      });
      const result = analyzeThreat(ctx);
      expect(result.score).toBe(100);
      expect(result.level).toBe(ThreatLevel.CRITICAL);
    });
  });
});
