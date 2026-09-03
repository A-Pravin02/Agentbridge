import { ThreatContext, ThreatFactor, ThreatRule } from '@agentbridge/shared-types';

/**
 * RULE 5: REPEATED_POLICY_PROBING
 *
 * Detects an agent systematically testing authorization boundaries.
 * Condition: ≥3 policy failures with VARYING amounts or categories within 10 min → +40pts
 *
 * "Varying" means at least 2 distinct failure values (amount or category),
 * which distinguishes probing from a single misconfigured agent request.
 */
export function checkPolicyProbing(ctx: ThreatContext): ThreatFactor | null {
  const failures = ctx.recentPolicyFailures;

  if (failures.length < 3) return null;

  // Check for variation: distinct amounts or distinct categories
  const distinctAmounts = new Set(failures.map(f => Math.round(f.amountMinor))).size;
  const distinctCategories = new Set(failures.map(f => f.category)).size;

  if (distinctAmounts >= 2 || distinctCategories >= 2) {
    return {
      rule: ThreatRule.REPEATED_POLICY_PROBING,
      points: 40,
      message: `Agent appears to be probing authorization boundaries: ${failures.length} policy failures with ${distinctAmounts} distinct amounts and ${distinctCategories} distinct categories in 10 minutes`,
      detail: {
        failureCount: failures.length,
        distinctAmounts,
        distinctCategories,
        windowMinutes: 10,
      },
    };
  }

  return null;
}
