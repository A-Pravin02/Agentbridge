// ============================================
// AgentBridge - Policy Engine Tests
// Tests for deterministic financial authorization
// ============================================

import { describe, it, expect } from 'vitest';
import { evaluatePolicy } from '../src/index.js';
import { transition, canTransition, InvalidTransitionError } from '../src/state-machine.js';
import {
  PolicyContext,
  PolicyDecision,
  PurchaseStatus,
  ViolationRule,
} from '@agentbridge/shared-types';

// ---- Test Helpers ----

function createTestContext(overrides: Partial<{
  amount: number;
  category: string;
  dailySpent: number;
  dailyTransactionCount: number;
  maxTransactionAmount: number;
  maxDailyAmount: number;
  approvalThreshold: number;
  allowedCategories: string[];
  agentMaxTransaction: number;
  agentMaxDaily: number;
  agentAllowedCategories: string[];
  canCreatePurchaseIntent: boolean;
  canExecutePurchase: boolean;
  expiresAt: Date | null;
}> = {}): PolicyContext {
  return {
    request: {
      merchantId: 'techkart',
      agentId: 'agent_shopping_01',
      productId: 'product_1',
      productCategory: overrides.category ?? 'Phone Accessories',
      amount: overrides.amount ?? 399,
      currency: 'INR',
      quantity: 1,
      agentReason: 'User requested a phone case under ₹500',
    },
    policy: {
      agentPermission: {
        id: 'perm_1',
        agentId: 'agent_shopping_01',
        canSearch: true,
        canCreatePurchaseIntent: overrides.canCreatePurchaseIntent ?? true,
        canExecutePurchase: overrides.canExecutePurchase ?? true,
        allowedCategories: overrides.agentAllowedCategories ?? overrides.allowedCategories ?? ['Phone Accessories', 'Electronics Accessories'],
        maxTransactionAmount: overrides.agentMaxTransaction ?? overrides.maxTransactionAmount ?? 500,
        maxDailyAmount: overrides.agentMaxDaily ?? overrides.maxDailyAmount ?? 2000,
        expiresAt: overrides.expiresAt === undefined ? null : overrides.expiresAt,
      },
      merchantPolicy: {
        id: 'policy_1',
        merchantId: 'techkart',
        maxTransactionAmount: overrides.maxTransactionAmount ?? 500,
        maxDailyAmount: overrides.maxDailyAmount ?? 2000,
        maxTransactionsPerDay: 5,
        allowedCategories: overrides.allowedCategories ?? ['Phone Accessories', 'Electronics Accessories'],
        approvalThreshold: overrides.approvalThreshold ?? 400,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
    dailySpent: overrides.dailySpent ?? 0,
    dailyTransactionCount: overrides.dailyTransactionCount ?? 0,
  };
}

// ============================================
// POLICY ENGINE TESTS
// ============================================

describe('Policy Engine', () => {
  describe('ALLOW decisions', () => {
    it('should ALLOW ₹299 USB-C Cable', () => {
      const ctx = createTestContext({ amount: 299, category: 'Electronics Accessories' });
      const result = evaluatePolicy(ctx);
      expect(result.decision).toBe(PolicyDecision.ALLOW);
      expect(result.violations).toHaveLength(0);
    });

    it('should ALLOW ₹399 Premium Phone Case', () => {
      const ctx = createTestContext({ amount: 399, category: 'Phone Accessories' });
      const result = evaluatePolicy(ctx);
      expect(result.decision).toBe(PolicyDecision.ALLOW);
      expect(result.violations).toHaveLength(0);
    });

    it('should ALLOW exactly at approval threshold ₹400', () => {
      const ctx = createTestContext({ amount: 400, category: 'Phone Accessories' });
      const result = evaluatePolicy(ctx);
      expect(result.decision).toBe(PolicyDecision.ALLOW);
    });
  });

  describe('REQUIRE_APPROVAL decisions', () => {
    it('should REQUIRE_APPROVAL for ₹499 (above ₹400 threshold, within ₹500 limit)', () => {
      const ctx = createTestContext({ amount: 499, category: 'Phone Accessories' });
      const result = evaluatePolicy(ctx);
      expect(result.decision).toBe(PolicyDecision.REQUIRE_APPROVAL);
      expect(result.violations).toHaveLength(0);
      expect(result.reasons[0]).toContain('approval threshold');
    });
  });

  describe('BLOCK decisions', () => {
    it('should BLOCK ₹1499 Power Bank (exceeds ₹500 limit)', () => {
      const ctx = createTestContext({ amount: 1499, category: 'Electronics' });
      const result = evaluatePolicy(ctx);
      expect(result.decision).toBe(PolicyDecision.BLOCK);
      expect(result.violations.some(v => v.rule === ViolationRule.MAX_TRANSACTION_AMOUNT)).toBe(true);
    });

    it('should BLOCK ₹2999 Bluetooth Speaker', () => {
      const ctx = createTestContext({ amount: 2999, category: 'Electronics' });
      const result = evaluatePolicy(ctx);
      expect(result.decision).toBe(PolicyDecision.BLOCK);
    });

    it('should BLOCK when daily spending limit would be exceeded', () => {
      const ctx = createTestContext({ amount: 399, dailySpent: 1700 });
      const result = evaluatePolicy(ctx);
      expect(result.decision).toBe(PolicyDecision.BLOCK);
      expect(result.violations.some(v => v.rule === ViolationRule.MAX_DAILY_AMOUNT)).toBe(true);
    });

    it('should BLOCK when category is not allowed', () => {
      const ctx = createTestContext({ amount: 299, category: 'Furniture' });
      const result = evaluatePolicy(ctx);
      expect(result.decision).toBe(PolicyDecision.BLOCK);
      expect(result.violations.some(v => v.rule === ViolationRule.CATEGORY_NOT_ALLOWED)).toBe(true);
    });

    it('should BLOCK when daily transaction count exceeded', () => {
      const ctx = createTestContext({ amount: 299, dailyTransactionCount: 5 });
      const result = evaluatePolicy(ctx);
      expect(result.decision).toBe(PolicyDecision.BLOCK);
      expect(result.violations.some(v => v.rule === ViolationRule.MAX_TRANSACTIONS_PER_DAY)).toBe(true);
    });

    it('should BLOCK when agent lacks purchase intent permission', () => {
      const ctx = createTestContext({ amount: 299, canCreatePurchaseIntent: false });
      const result = evaluatePolicy(ctx);
      expect(result.decision).toBe(PolicyDecision.BLOCK);
      expect(result.violations.some(v => v.rule === ViolationRule.AGENT_PERMISSION_INVALID)).toBe(true);
    });

    it('should BLOCK when agent permission is expired', () => {
      const ctx = createTestContext({
        amount: 299,
        expiresAt: new Date('2020-01-01'),
      });
      const result = evaluatePolicy(ctx);
      expect(result.decision).toBe(PolicyDecision.BLOCK);
      expect(result.violations.some(v => v.rule === ViolationRule.AGENT_EXPIRED)).toBe(true);
    });
  });

  describe('Explainability', () => {
    it('should provide clear reasons for BLOCK', () => {
      const ctx = createTestContext({ amount: 1499, category: 'Electronics' });
      const result = evaluatePolicy(ctx);
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.reasons[0]).toContain('₹1499');
      expect(result.reasons[0]).toContain('₹500');
    });

    it('should provide clear reasons for ALLOW', () => {
      const ctx = createTestContext({ amount: 299, category: 'Electronics Accessories' });
      const result = evaluatePolicy(ctx);
      expect(result.reasons.length).toBeGreaterThan(0);
      expect(result.reasons[0]).toContain('within limit');
    });
  });
});

// ============================================
// STATE MACHINE TESTS
// ============================================

describe('Purchase State Machine', () => {
  describe('Valid transitions', () => {
    it('CREATED → EVALUATING', () => {
      expect(transition(PurchaseStatus.CREATED, PurchaseStatus.EVALUATING)).toBe(PurchaseStatus.EVALUATING);
    });

    it('EVALUATING → AUTHORIZED', () => {
      expect(transition(PurchaseStatus.EVALUATING, PurchaseStatus.AUTHORIZED)).toBe(PurchaseStatus.AUTHORIZED);
    });

    it('EVALUATING → REQUIRE_APPROVAL', () => {
      expect(transition(PurchaseStatus.EVALUATING, PurchaseStatus.REQUIRE_APPROVAL)).toBe(PurchaseStatus.REQUIRE_APPROVAL);
    });

    it('EVALUATING → BLOCKED', () => {
      expect(transition(PurchaseStatus.EVALUATING, PurchaseStatus.BLOCKED)).toBe(PurchaseStatus.BLOCKED);
    });

    it('REQUIRE_APPROVAL → APPROVED', () => {
      expect(transition(PurchaseStatus.REQUIRE_APPROVAL, PurchaseStatus.APPROVED)).toBe(PurchaseStatus.APPROVED);
    });

    it('REQUIRE_APPROVAL → DENIED', () => {
      expect(transition(PurchaseStatus.REQUIRE_APPROVAL, PurchaseStatus.DENIED)).toBe(PurchaseStatus.DENIED);
    });

    it('APPROVED → AUTHORIZED', () => {
      expect(transition(PurchaseStatus.APPROVED, PurchaseStatus.AUTHORIZED)).toBe(PurchaseStatus.AUTHORIZED);
    });

    it('AUTHORIZED → PAYMENT_PENDING', () => {
      expect(transition(PurchaseStatus.AUTHORIZED, PurchaseStatus.PAYMENT_PENDING)).toBe(PurchaseStatus.PAYMENT_PENDING);
    });

    it('PAYMENT_PENDING → PAYMENT_PROCESSING', () => {
      expect(transition(PurchaseStatus.PAYMENT_PENDING, PurchaseStatus.PAYMENT_PROCESSING)).toBe(PurchaseStatus.PAYMENT_PROCESSING);
    });

    it('PAYMENT_PROCESSING → COMPLETED', () => {
      expect(transition(PurchaseStatus.PAYMENT_PROCESSING, PurchaseStatus.COMPLETED)).toBe(PurchaseStatus.COMPLETED);
    });
  });

  describe('Invalid transitions must throw', () => {
    it('BLOCKED → PAYMENT_PROCESSING must fail', () => {
      expect(() => transition(PurchaseStatus.BLOCKED, PurchaseStatus.PAYMENT_PROCESSING))
        .toThrow(InvalidTransitionError);
    });

    it('BLOCKED → AUTHORIZED must fail', () => {
      expect(() => transition(PurchaseStatus.BLOCKED, PurchaseStatus.AUTHORIZED))
        .toThrow(InvalidTransitionError);
    });

    it('DENIED → PAYMENT_PENDING must fail', () => {
      expect(() => transition(PurchaseStatus.DENIED, PurchaseStatus.PAYMENT_PENDING))
        .toThrow(InvalidTransitionError);
    });

    it('COMPLETED → CREATED must fail', () => {
      expect(() => transition(PurchaseStatus.COMPLETED, PurchaseStatus.CREATED))
        .toThrow(InvalidTransitionError);
    });

    it('CREATED → COMPLETED must fail (skip states)', () => {
      expect(() => transition(PurchaseStatus.CREATED, PurchaseStatus.COMPLETED))
        .toThrow(InvalidTransitionError);
    });

    it('CREATED → PAYMENT_PROCESSING must fail', () => {
      expect(() => transition(PurchaseStatus.CREATED, PurchaseStatus.PAYMENT_PROCESSING))
        .toThrow(InvalidTransitionError);
    });
  });

  describe('canTransition', () => {
    it('returns true for valid transition', () => {
      expect(canTransition(PurchaseStatus.CREATED, PurchaseStatus.EVALUATING)).toBe(true);
    });

    it('returns false for invalid transition', () => {
      expect(canTransition(PurchaseStatus.BLOCKED, PurchaseStatus.COMPLETED)).toBe(false);
    });
  });
});
