// ============================================
// AgentBridge - Decision Orchestrator
// Single deterministic source of truth for final decisions
// ============================================

import {
  SecurityCheckResult,
  ThreatAssessmentResult,
  ThreatLevel,
  ThreatAction,
  PolicyResult,
  PolicyDecision,
  CombinedDecision,
  SecurityViolation,
} from '@agentbridge/shared-types';

/**
 * Combines all security signals into a single final decision.
 *
 * PRIORITY ORDER (highest wins):
 * 1.  Identity failure (unknown/unverifiable agent)     → BLOCK
 * 2.  Agent status not ACTIVE (quarantined/blocked)     → BLOCK
 * 3.  Request integrity failure (replay/timestamp/sig)  → BLOCK
 * 4.  Permission failure                                → BLOCK
 * 5.  Hard policy BLOCK (amount/category/daily limit)   → BLOCK
 * 6.  CRITICAL threat score (≥80) → agent quarantined   → BLOCK
 * 7.  Policy REQUIRE_APPROVAL (approval threshold)      → REQUIRE_APPROVAL
 * 8.  HIGH threat (score 60-79)                         → REQUIRE_APPROVAL
 * 9.  MEDIUM threat (30-59) — pass context, policy decides → policy result
 * 10. LOW threat + all checks pass                       → ALLOW
 *
 * CRITICAL INVARIANT: A hard Policy BLOCK is NEVER overridden by a risk assessment.
 * An ALLOW from the Policy Engine can be overridden by a CRITICAL threat assessment.
 */
export function combineDecisions(params: {
  agentStatusCheck: SecurityCheckResult;
  integrityCheck: SecurityCheckResult;
  permissionCheck: SecurityCheckResult;
  threatAssessment: ThreatAssessmentResult | null;
  policyResult: PolicyResult;
}): CombinedDecision {
  const { agentStatusCheck, integrityCheck, permissionCheck, threatAssessment, policyResult } = params;
  const reasons: string[] = [];

  // ---- Priority 1: Identity / authentication failure ----
  if (!agentStatusCheck.passed) {
    return {
      finalDecision: 'BLOCK',
      shouldQuarantine: false,
      reasons: [agentStatusCheck.message],
      securityViolation: agentStatusCheck.violation,
    };
  }

  // ---- Priority 2: Agent status (already quarantined/blocked) ----
  // Handled above — if agent is not ACTIVE, agentStatusCheck.passed is false

  // ---- Priority 3: Request integrity failure ----
  if (!integrityCheck.passed) {
    reasons.push(integrityCheck.message);
    return {
      finalDecision: 'BLOCK',
      shouldQuarantine: false,
      reasons,
      securityViolation: integrityCheck.violation,
      threatAssessment: threatAssessment ?? undefined,
    };
  }

  // ---- Priority 4: Permission failure ----
  if (!permissionCheck.passed) {
    return {
      finalDecision: 'BLOCK',
      shouldQuarantine: false,
      reasons: [permissionCheck.message],
      securityViolation: permissionCheck.violation,
    };
  }

  // ---- Priority 5: Hard policy BLOCK ----
  if (policyResult.decision === PolicyDecision.BLOCK) {
    // A hard policy violation is never overridden — not even by a LOW threat
    reasons.push(...policyResult.reasons);
    return {
      finalDecision: 'BLOCK',
      shouldQuarantine: false, // Hard policy block does NOT auto-quarantine
      reasons,
      policyResult,
      threatAssessment: threatAssessment ?? undefined,
    };
  }

  // ---- Priority 6: CRITICAL threat → QUARANTINE + BLOCK ----
  if (threatAssessment && threatAssessment.level === ThreatLevel.CRITICAL) {
    reasons.push(
      `Critical behavioral threat detected (score: ${threatAssessment.score}/100)`,
      ...threatAssessment.factors.map(f => f.message)
    );
    return {
      finalDecision: 'BLOCK',
      shouldQuarantine: true, // CRITICAL → quarantine the agent
      reasons,
      policyResult,
      threatAssessment,
    };
  }

  // ---- Priority 7: Policy REQUIRE_APPROVAL ----
  if (policyResult.decision === PolicyDecision.REQUIRE_APPROVAL) {
    reasons.push(...policyResult.reasons);
    if (threatAssessment && threatAssessment.factors.length > 0) {
      reasons.push(`Threat score: ${threatAssessment.score}/100 (${threatAssessment.level})`);
    }
    return {
      finalDecision: 'REQUIRE_APPROVAL',
      shouldQuarantine: false,
      reasons,
      policyResult,
      threatAssessment: threatAssessment ?? undefined,
    };
  }

  // ---- Priority 8: HIGH threat → REQUIRE_APPROVAL ----
  if (threatAssessment && threatAssessment.level === ThreatLevel.HIGH) {
    reasons.push(
      `High behavioral threat detected (score: ${threatAssessment.score}/100) — human approval required`,
      ...threatAssessment.factors.map(f => f.message)
    );
    return {
      finalDecision: 'REQUIRE_APPROVAL',
      shouldQuarantine: false,
      reasons,
      policyResult,
      threatAssessment,
    };
  }

  // ---- Priority 9 & 10: MEDIUM/LOW threat — ALLOW ----
  reasons.push(...policyResult.reasons);
  if (threatAssessment && threatAssessment.score > 0) {
    reasons.push(`Behavioral threat score: ${threatAssessment.score}/100 (${threatAssessment.level})`);
  }

  return {
    finalDecision: 'ALLOW',
    shouldQuarantine: false,
    reasons,
    policyResult,
    threatAssessment: threatAssessment ?? undefined,
  };
}

/**
 * Maps CombinedDecision to PurchaseStatus.
 * Used by the evaluate endpoint to set the final purchase state.
 */
export function decisionToPurchaseStatus(decision: CombinedDecision): string {
  switch (decision.finalDecision) {
    case 'ALLOW':           return 'AUTHORIZED';
    case 'REQUIRE_APPROVAL': return 'REQUIRE_APPROVAL';
    case 'BLOCK':           return 'BLOCKED';
  }
}
