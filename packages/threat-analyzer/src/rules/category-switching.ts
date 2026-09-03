import { ThreatContext, ThreatFactor, ThreatRule } from '@agentbridge/shared-types';

/**
 * RULE 9: SUSPICIOUS_CATEGORY_SWITCHING
 *
 * Detects rapid switching across product categories that differ from the agent's
 * normal behavioral pattern.
 *
 * Condition: ≥3 distinct categories in the last 30 minutes AND the current
 * request uses a category not seen in the agent's recent history.
 *
 * IMPORTANT: This is a behavioral signal only, not a hard block.
 * Hard category restrictions remain with the Policy Engine.
 *
 * Points: +10
 */
const MIN_DISTINCT_CATEGORIES = 3;

export function checkCategorySwitching(ctx: ThreatContext): ThreatFactor | null {
  const recentCategories = ctx.recentCategories;
  const distinctCategories = new Set([...recentCategories, ctx.currentCategory]);

  if (distinctCategories.size >= MIN_DISTINCT_CATEGORIES) {
    const isNewCategory = !recentCategories.includes(ctx.currentCategory);

    if (isNewCategory) {
      return {
        rule: ThreatRule.SUSPICIOUS_CATEGORY_SWITCHING,
        points: 10,
        message: `Agent is rapidly switching product categories: [${[...distinctCategories].join(', ')}] — current category "${ctx.currentCategory}" was not previously used`,
        detail: {
          distinctCategories: [...distinctCategories],
          currentCategory: ctx.currentCategory,
          previousCategories: recentCategories,
          windowMinutes: 30,
        },
      };
    }
  }

  return null;
}
