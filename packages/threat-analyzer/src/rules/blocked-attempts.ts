import { ThreatContext, ThreatFactor, ThreatRule } from '@agentbridge/shared-types';

/**
 * RULE 3: REPEATED_BLOCKED_ATTEMPTS  — ≥3 blocked in 10min  → +30pts
 * RULE 4: EXCESSIVE_BLOCKED_ATTEMPTS — ≥6 blocked in 30min  → +60pts
 *
 * EXCESSIVE supersedes REPEATED (only one fires, highest wins).
 */
export function checkBlockedAttempts(ctx: ThreatContext): ThreatFactor | null {
  if (ctx.blockedCountLast30Min >= 6) {
    return {
      rule: ThreatRule.EXCESSIVE_BLOCKED_ATTEMPTS,
      points: 60,
      message: `Agent has ${ctx.blockedCountLast30Min} blocked transaction attempts in the last 30 minutes — severe malicious behavior signal`,
      detail: { count: ctx.blockedCountLast30Min, windowMinutes: 30, threshold: 6 },
    };
  }

  if (ctx.blockedCountLast10Min >= 3) {
    return {
      rule: ThreatRule.REPEATED_BLOCKED_ATTEMPTS,
      points: 30,
      message: `Agent has ${ctx.blockedCountLast10Min} blocked transaction attempts in the last 10 minutes`,
      detail: { count: ctx.blockedCountLast10Min, windowMinutes: 10, threshold: 3 },
    };
  }

  return null;
}
