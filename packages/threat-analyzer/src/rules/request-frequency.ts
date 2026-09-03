import { ThreatContext, ThreatFactor, ThreatRule } from '@agentbridge/shared-types';

/**
 * RULE 1: HIGH_REQUEST_FREQUENCY   — >5 requests in 60s  → +20pts
 * RULE 2: EXTREME_REQUEST_FREQUENCY — >15 requests in 60s → +50pts
 *
 * EXTREME supersedes HIGH (only one fires, highest wins).
 */
export function checkRequestFrequency(ctx: ThreatContext): ThreatFactor | null {
  const count = ctx.requestCountLast60Sec;

  if (count > 15) {
    return {
      rule: ThreatRule.EXTREME_REQUEST_FREQUENCY,
      points: 50,
      message: `Agent made ${count} purchase attempts within the last 60 seconds (extreme frequency)`,
      detail: { count, windowSeconds: 60, threshold: 15 },
    };
  }

  if (count > 5) {
    return {
      rule: ThreatRule.HIGH_REQUEST_FREQUENCY,
      points: 20,
      message: `Agent made ${count} purchase attempts within the last 60 seconds`,
      detail: { count, windowSeconds: 60, threshold: 5 },
    };
  }

  return null;
}
