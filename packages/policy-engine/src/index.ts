// ============================================
// AgentBridge - Deterministic Policy Engine
// The AI suggests. AgentBridge decides.
// ============================================

import {
  PolicyContext,
  PolicyResult,
  PolicyDecision,
  PolicyViolation,
  ViolationRule,
} from '@agentbridge/shared-types';

/**
 * Evaluates a purchase request against merchant policy and agent permissions.
 * 
 * Evaluation order:
 * 1. Agent permission validation
 * 2. Transaction amount check
 * 3. Daily spending check
 * 4. Category check
 * 5. Daily transaction count check
 * 6. Approval threshold check
 * 
 * Any hard violation → BLOCK
 * No hard violation but above approval threshold → REQUIRE_APPROVAL
 * Everything passes → ALLOW
 */
export function evaluatePolicy(context: PolicyContext): PolicyResult {
  const violations: PolicyViolation[] = [];
  const reasons: string[] = [];

  const { request, policy, dailySpent, dailyTransactionCount } = context;
  const { agentPermission, merchantPolicy } = policy;

  // ---- Step 1: Validate agent permissions ----
  if (!agentPermission.canCreatePurchaseIntent) {
    violations.push({
      rule: ViolationRule.AGENT_PERMISSION_INVALID,
      message: 'Agent does not have permission to create purchase intents',
    });
  }

  if (!agentPermission.canExecutePurchase) {
    violations.push({
      rule: ViolationRule.AGENT_PERMISSION_INVALID,
      message: 'Agent does not have permission to execute purchases',
    });
  }

  // Check agent expiry
  if (agentPermission.expiresAt && new Date(agentPermission.expiresAt) < new Date()) {
    violations.push({
      rule: ViolationRule.AGENT_EXPIRED,
      message: 'Agent permission has expired',
    });
  }

  // ---- Step 2: Check transaction amount ----
  const effectiveMaxTransaction = Math.min(
    merchantPolicy.maxTransactionAmount,
    agentPermission.maxTransactionAmount
  );

  if (request.amount > effectiveMaxTransaction) {
    violations.push({
      rule: ViolationRule.MAX_TRANSACTION_AMOUNT,
      message: `Transaction amount ₹${request.amount} exceeds maximum limit ₹${effectiveMaxTransaction}`,
    });
  }

  // ---- Step 3: Check daily spending ----
  const effectiveMaxDaily = Math.min(
    merchantPolicy.maxDailyAmount,
    agentPermission.maxDailyAmount
  );

  if (dailySpent + request.amount > effectiveMaxDaily) {
    violations.push({
      rule: ViolationRule.MAX_DAILY_AMOUNT,
      message: `Daily spending would be ₹${dailySpent + request.amount}, exceeding daily limit ₹${effectiveMaxDaily}`,
    });
  }

  // ---- Step 4: Check category ----
  const merchantAllows = merchantPolicy.allowedCategories.includes(request.productCategory);
  const agentAllows = agentPermission.allowedCategories.includes(request.productCategory);

  if (!merchantAllows || !agentAllows) {
    violations.push({
      rule: ViolationRule.CATEGORY_NOT_ALLOWED,
      message: `Category "${request.productCategory}" is not allowed`,
    });
  }

  // ---- Step 5: Check daily transaction count ----
  if (dailyTransactionCount + 1 > merchantPolicy.maxTransactionsPerDay) {
    violations.push({
      rule: ViolationRule.MAX_TRANSACTIONS_PER_DAY,
      message: `Daily transaction count would be ${dailyTransactionCount + 1}, exceeding limit of ${merchantPolicy.maxTransactionsPerDay}`,
    });
  }

  // ---- Decision Logic ----

  // Any hard violation = BLOCK
  if (violations.length > 0) {
    const blockReasons = violations.map((v) => v.message);
    return {
      decision: PolicyDecision.BLOCK,
      reasons: blockReasons,
      violations,
    };
  }

  // ---- Step 6: Check approval threshold ----
  if (request.amount > merchantPolicy.approvalThreshold) {
    return {
      decision: PolicyDecision.REQUIRE_APPROVAL,
      reasons: [
        `Transaction amount ₹${request.amount} exceeds approval threshold ₹${merchantPolicy.approvalThreshold}`,
      ],
      violations: [],
    };
  }

  // Everything passes
  reasons.push(
    `Transaction amount ₹${request.amount} is within limit ₹${effectiveMaxTransaction}`,
    `Daily spending ₹${dailySpent + request.amount} is within daily limit ₹${effectiveMaxDaily}`,
    `Category "${request.productCategory}" is allowed`,
  );

  return {
    decision: PolicyDecision.ALLOW,
    reasons,
    violations: [],
  };
}

export { evaluatePolicy as evaluate };

// State machine exports
export {
  canTransition,
  transition,
  getNextStates,
  isTerminalState,
  InvalidTransitionError,
} from './state-machine.js';
