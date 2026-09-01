import { ThreatContext, ThreatFactor, ThreatRule } from '@agentbridge/shared-types';

/**
 * RULE 7: UNUSUAL_SPENDING_SPIKE
 *
 * Only triggers when there is sufficient history (≥3 completed transactions).
 * If current amount > 1.5x historical average → +15pts
 *
 * This is a behavioral anomaly signal, not a hard limit check.
 */
const MIN_SAMPLES = 3;
const SPIKE_MULTIPLIER = 1.5;

export function checkSpendingSpike(ctx: ThreatContext): ThreatFactor | null {
  const { recentCompletedAmounts, currentAmount } = ctx;

  // Insufficient history — do not fire
  if (recentCompletedAmounts.length < MIN_SAMPLES) return null;

  const avg = recentCompletedAmounts.reduce((sum, v) => sum + v, 0) / recentCompletedAmounts.length;
  const threshold = avg * SPIKE_MULTIPLIER;

  if (currentAmount > threshold) {
    return {
      rule: ThreatRule.UNUSUAL_SPENDING_SPIKE,
      points: 15,
      message: `Current transaction amount ₹${currentAmount} is ${(currentAmount / avg).toFixed(1)}x the agent's recent average of ₹${Math.round(avg)}`,
      metadata: {
        currentAmount,
        historicalAverage: Math.round(avg),
        spikeRatio: +(currentAmount / avg).toFixed(2),
        sampleCount: recentCompletedAmounts.length,
        spikeMultiplier: SPIKE_MULTIPLIER,
      },
    };
  }

  return null;
}
