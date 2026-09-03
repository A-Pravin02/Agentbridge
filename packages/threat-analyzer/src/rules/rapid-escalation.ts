import { ThreatContext, ThreatFactor, ThreatRule, formatMinor } from '@agentbridge/shared-types';

/**
 * RULE 8: RAPID_ESCALATION
 *
 * Detects systematically increasing transaction amounts toward the agent limit.
 *
 * Algorithm:
 * - Take the last 3+ recent purchase intents (any status) sorted by time ascending
 * - Check if amounts form a strictly increasing sequence
 * - AND the sequence spans at least 1.5x (i.e., last/first ratio ≥ 1.5)
 * - AND the current amount is ≥ the last item in the sequence
 *
 * Points: +15
 */
const MIN_ESCALATION_INTENTS = 3;
const MIN_ESCALATION_RATIO = 1.5;

export function checkRapidEscalation(ctx: ThreatContext): ThreatFactor | null {
  const intents = ctx.recentPurchaseIntents;
  if (intents.length < MIN_ESCALATION_INTENTS) return null;

  // Sort by time ascending — most recent last
  const sorted = [...intents].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const amounts = sorted.map(i => i.amountMinor);

  // Check strictly increasing
  let isIncreasing = true;
  for (let i = 1; i < amounts.length; i++) {
    if (amounts[i] <= amounts[i - 1]) {
      isIncreasing = false;
      break;
    }
  }

  if (!isIncreasing) return null;

  const firstAmount = amounts[0];
  const lastAmount = amounts[amounts.length - 1];
  const ratio = firstAmount > 0 ? lastAmount / firstAmount : 0;

  if (ratio >= MIN_ESCALATION_RATIO && ctx.currentAmountMinor >= lastAmount) {
    return {
      rule: ThreatRule.RAPID_ESCALATION,
      points: 15,
      message: `Agent transaction amounts are escalating: ${amounts.map((a) => formatMinor(a)).join(' -> ')} -> ${formatMinor(ctx.currentAmountMinor)} (${ratio.toFixed(1)}x increase)`,
      detail: {
        amounts,
        currentAmountMinor: ctx.currentAmountMinor,
        escalationRatio: +ratio.toFixed(2),
        windowMinutes: 10,
      },
    };
  }

  return null;
}
