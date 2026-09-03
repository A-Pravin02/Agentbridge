import { ThreatContext, ThreatFactor, ThreatRule } from '@agentbridge/shared-types';

/**
 * RULE 10: REPEATED_DENIED_APPROVALS
 *
 * Agent repeatedly attempts transactions that were denied by human reviewers.
 * Condition: ≥2 human-denied approvals in the last 30 minutes → +20pts
 *
 * This indicates an agent ignoring or bypassing human rejection signals.
 */
const MIN_DENIED_COUNT = 2;

export function checkDeniedApprovals(ctx: ThreatContext): ThreatFactor | null {
  if (ctx.deniedCountLast30Min >= MIN_DENIED_COUNT) {
    return {
      rule: ThreatRule.REPEATED_DENIED_APPROVALS,
      points: 20,
      message: `Agent has had ${ctx.deniedCountLast30Min} transactions denied by human reviewers in the last 30 minutes`,
      detail: {
        count: ctx.deniedCountLast30Min,
        windowMinutes: 30,
        threshold: MIN_DENIED_COUNT,
      },
    };
  }

  return null;
}
