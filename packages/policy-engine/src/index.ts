// ============================================
// AgentBridge - Deterministic Policy Engine
// The AI proposes. AgentBridge decides.
// ============================================
//
// THE CENTRAL INVARIANT OF THIS PROJECT:
// No language model participates in this function. `evaluatePolicy` is a pure,
// total function of its input. Given the same PolicyContext it always returns
// the same PolicyResult — no clock reads, no randomness, no I/O, no network.
//
// PRECEDENCE: BLOCK > REQUIRE_APPROVAL > ALLOW.
// A risk signal can escalate an ALLOW to REQUIRE_APPROVAL or BLOCK, but it can
// NEVER downgrade a hard policy BLOCK. That property falls out of the fold over
// `mostRestrictive` and is asserted directly by the invariant tests.

import {
  PolicyContext,
  PolicyResult,
  PolicyDecision,
  ReasonCode,
  EvaluatedRule,
  mostRestrictive,
  DECISION_PRECEDENCE,
} from '@agentbridge/shared-types';
import { POLICY_RULES } from './rules.js';

export function evaluatePolicy(context: PolicyContext): PolicyResult {
  const evaluatedRules: EvaluatedRule[] = POLICY_RULES.map((rule) => rule(context));
  const violations = evaluatedRules.filter((r) => !r.passed);

  // Fold every rule outcome into a single decision. Order-independent.
  const decision = evaluatedRules.reduce<PolicyDecision>(
    (acc, r) => mostRestrictive(acc, r.outcome),
    PolicyDecision.ALLOW
  );

  // Surface the first violation that is as restrictive as the final decision,
  // so the headline reason always matches the verdict.
  const governing = violations.find((v) => DECISION_PRECEDENCE[v.outcome] === DECISION_PRECEDENCE[decision]);

  const humanReadableReason =
    governing?.message ??
    (decision === PolicyDecision.ALLOW
      ? 'All policy checks passed'
      : 'Transaction did not satisfy merchant policy');

  return {
    decisionId: context.decisionId,
    decision,
    reasonCode: governing?.reasonCode ?? ReasonCode.OK,
    humanReadableReason,
    evaluatedRules,
    violations,
    policyVersion: context.merchantPolicy.version,
    timestamp: context.now.toISOString(),
  };
}

export { POLICY_RULES } from './rules.js';
export {
  assertTransition,
  canTransition,
  transition,
  getNextStates,
  isTerminalState,
  InvalidTransitionError,
} from './state-machine.js';
