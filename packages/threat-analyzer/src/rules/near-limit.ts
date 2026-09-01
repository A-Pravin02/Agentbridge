import { ThreatContext, ThreatFactor, ThreatRule } from '@agentbridge/shared-types';

/**
 * RULE 6: REPEATED_NEAR_LIMIT_ATTEMPTS
 *
 * Agent repeatedly attempts transactions at ≥90% of its max allowed amount.
 * "Near limit" threshold: configurable, default 90%.
 * Window: 10 minutes, minimum 2 near-limit attempts.
 * Points: +15
 */
const NEAR_LIMIT_THRESHOLD = 0.90; // 90% of max
const MIN_NEAR_LIMIT_COUNT = 2;

export function checkNearLimit(ctx: ThreatContext): ThreatFactor | null {
  const { agentMaxTransactionAmount } = ctx;
  if (agentMaxTransactionAmount <= 0) return null;

  // Count how many recent intents are near-limit
  const nearLimitAttempts = ctx.recentPurchaseIntents.filter(intent => {
    const ratio = intent.amount / agentMaxTransactionAmount;
    return ratio >= NEAR_LIMIT_THRESHOLD;
  });

  // Also include current request
  const currentRatio = ctx.currentAmount / agentMaxTransactionAmount;
  const currentIsNearLimit = currentRatio >= NEAR_LIMIT_THRESHOLD;
  const totalNearLimit = nearLimitAttempts.length + (currentIsNearLimit ? 1 : 0);

  if (totalNearLimit >= MIN_NEAR_LIMIT_COUNT) {
    return {
      rule: ThreatRule.REPEATED_NEAR_LIMIT_ATTEMPTS,
      points: 15,
      message: `Agent has made ${totalNearLimit} transaction attempts at ≥${NEAR_LIMIT_THRESHOLD * 100}% of its maximum limit (₹${agentMaxTransactionAmount}) in the last 10 minutes`,
      metadata: {
        count: totalNearLimit,
        threshold: NEAR_LIMIT_THRESHOLD,
        agentMaxTransactionAmount,
        windowMinutes: 10,
      },
    };
  }

  return null;
}
