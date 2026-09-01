// ============================================
// AgentBridge - Behavioral Threat Analyzer
// Deterministic, explainable, zero-trust
// ============================================

import { ThreatContext, ThreatAssessmentResult, ThreatFactor, ThreatLevel, ThreatAction, ThreatRule } from '@agentbridge/shared-types';
import { checkRequestFrequency } from './rules/request-frequency.js';
import { checkBlockedAttempts } from './rules/blocked-attempts.js';
import { checkPolicyProbing } from './rules/policy-probing.js';
import { checkNearLimit } from './rules/near-limit.js';
import { checkSpendingSpike } from './rules/spending-spike.js';
import { checkRapidEscalation } from './rules/rapid-escalation.js';
import { checkCategorySwitching } from './rules/category-switching.js';
import { checkDeniedApprovals } from './rules/denied-approvals.js';

/**
 * Analyzes behavioral threat signals for an agent request.
 *
 * IMPORTANT: This function is pure — it does NOT query the database.
 * The caller (threat-service.ts) is responsible for pre-querying
 * behavioral data and constructing ThreatContext.
 *
 * Rules:
 * 1. HIGH_REQUEST_FREQUENCY       +20
 * 2. EXTREME_REQUEST_FREQUENCY    +50
 * 3. REPEATED_BLOCKED_ATTEMPTS    +30
 * 4. EXCESSIVE_BLOCKED_ATTEMPTS   +60
 * 5. REPEATED_POLICY_PROBING      +40
 * 6. REPEATED_NEAR_LIMIT_ATTEMPTS +15
 * 7. UNUSUAL_SPENDING_SPIKE       +15
 * 8. RAPID_ESCALATION             +15
 * 9. SUSPICIOUS_CATEGORY_SWITCHING+10
 * 10. REPEATED_DENIED_APPROVALS   +20
 * 11. MULTIPLE_SECURITY_WARNINGS  +20 (when ≥3 different rules trigger)
 */
export function analyzeThreat(ctx: ThreatContext): ThreatAssessmentResult {
  const factors: ThreatFactor[] = [];

  // Run all rules
  const freq = checkRequestFrequency(ctx);
  const blocked = checkBlockedAttempts(ctx);
  const probing = checkPolicyProbing(ctx);
  const nearLimit = checkNearLimit(ctx);
  const spike = checkSpendingSpike(ctx);
  const escalation = checkRapidEscalation(ctx);
  const catSwitch = checkCategorySwitching(ctx);
  const denied = checkDeniedApprovals(ctx);

  for (const f of [freq, blocked, probing, nearLimit, spike, escalation, catSwitch, denied]) {
    if (f) factors.push(f);
  }

  // Rule 11: MULTIPLE_SECURITY_WARNINGS — 3+ distinct rules triggered
  if (factors.length >= 3) {
    factors.push({
      rule: ThreatRule.MULTIPLE_SECURITY_WARNINGS,
      points: 20,
      message: `Agent triggered ${factors.length} distinct threat indicators simultaneously`,
      metadata: { rulesTriggered: factors.map(f => f.rule) },
    });
  }

  // Sum points, cap at 100
  const rawScore = factors.reduce((sum, f) => sum + f.points, 0);
  const score = Math.min(100, rawScore);

  const level = scoreToLevel(score);
  const recommendedAction = levelToAction(level);

  return {
    score,
    level,
    recommendedAction,
    factors,
    analyzedAt: new Date(),
  };
}

function scoreToLevel(score: number): ThreatLevel {
  if (score >= 80) return ThreatLevel.CRITICAL;
  if (score >= 60) return ThreatLevel.HIGH;
  if (score >= 30) return ThreatLevel.MEDIUM;
  return ThreatLevel.LOW;
}

function levelToAction(level: ThreatLevel): ThreatAction {
  switch (level) {
    case ThreatLevel.CRITICAL: return ThreatAction.QUARANTINE_AGENT;
    case ThreatLevel.HIGH:     return ThreatAction.REQUIRE_APPROVAL;
    case ThreatLevel.MEDIUM:   return ThreatAction.CONTINUE;
    case ThreatLevel.LOW:      return ThreatAction.CONTINUE;
  }
}

export type { ThreatContext, ThreatAssessmentResult, ThreatFactor };
