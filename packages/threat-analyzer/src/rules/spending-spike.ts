import { ThreatContext, ThreatFactor, ThreatRule, formatMinor } from '@agentbridge/shared-types';

/**
 * RULE 7: UNUSUAL_SPENDING_SPIKE
 *
 * Only fires with sufficient history (>=3 completed transactions), so a new
 * agent's first purchases are never flagged as anomalous.
 * Current amount > 1.5x the historical average -> +15pts.
 *
 * A behavioural anomaly signal, not a hard limit. Hard limits are the policy
 * engine's job.
 */
const MIN_SAMPLES = 3;
const SPIKE_MULTIPLIER = 1.5;

export function checkSpendingSpike(ctx: ThreatContext): ThreatFactor | null {
  const { recentCompletedAmountsMinor, currentAmountMinor } = ctx;

  if (recentCompletedAmountsMinor.length < MIN_SAMPLES) return null;

  const avg =
    recentCompletedAmountsMinor.reduce((sum, v) => sum + v, 0) / recentCompletedAmountsMinor.length;
  if (avg <= 0) return null;

  const threshold = avg * SPIKE_MULTIPLIER;

  if (currentAmountMinor > threshold) {
    const ratio = currentAmountMinor / avg;
    return {
      rule: ThreatRule.UNUSUAL_SPENDING_SPIKE,
      points: 15,
      message: `Current amount ${formatMinor(currentAmountMinor)} is ${ratio.toFixed(1)}x the agent's recent average of ${formatMinor(Math.round(avg))}`,
      detail: {
        currentAmountMinor,
        historicalAverageMinor: Math.round(avg),
        spikeRatio: +ratio.toFixed(2),
        sampleCount: recentCompletedAmountsMinor.length,
        spikeMultiplier: SPIKE_MULTIPLIER,
      },
    };
  }

  return null;
}
