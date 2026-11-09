import {
  BOX_HOUR_PRICE_MICROS,
  PLAN_LIMITS,
  PLAN_PRICES,
  includedWeightedSeconds,
  sizePriceTable,
  usagePercent,
  type BillingPricing,
  type BillingStatus,
  type PlanTier,
} from '@talyn/shared';

export const BILLING_PRICING_FOR_TESTS: BillingPricing = {
  proMonthlyMicros: PLAN_PRICES.pro.monthlyMicros,
  proAnnualMicros: PLAN_PRICES.pro.annualMicros ?? 0,
  legacyProMonthlyMicros: PLAN_PRICES.legacy_pro.monthlyMicros,
  boxHourMicros: BOX_HOUR_PRICE_MICROS,
};

/** The pricing a backend sends when this account may buy Max (or holds it). */
export const BILLING_PRICING_WITH_MAX: BillingPricing = {
  ...BILLING_PRICING_FOR_TESTS,
  maxMonthlyMicros: PLAN_PRICES.max.monthlyMicros,
};

/** The old backend's status: no usage fields at all. */
export function oldStatus(overrides: Partial<BillingStatus> = {}): BillingStatus {
  return {
    billingEnabled: true,
    plan: 'free',
    planSource: 'default',
    cancelAtPeriodEnd: false,
    activeTasks: 0,
    activeTaskLimit: 3,
    queuedPrs: 0,
    mergeQueueLimit: 3,
    workflows: 0,
    workflowLimit: 3,
    loops: 0,
    loopLimit: 3,
    activeReviews: 0,
    activeReviewLimit: 1,
    ...overrides,
  };
}

export const PERIOD_END = '2026-11-30T00:00:00.000Z';

/** A usage-billing status for `tier`, with `usedHours` box-hours used. */
export function usageStatus(
  tier: PlanTier,
  opts: {
    usedHours?: number;
    exhausted?: boolean;
    balanceMicros?: number;
    planSource?: BillingStatus['planSource'];
    /** Send Max prices. A Max holder always gets them. */
    maxOffered?: boolean;
  } = {},
  overrides: Partial<BillingStatus> = {}
): BillingStatus {
  const included = includedWeightedSeconds(tier);
  const used = Math.round((opts.usedHours ?? 0) * 3600);
  const limits = PLAN_LIMITS[tier];
  return {
    ...oldStatus(),
    plan: tier,
    planSource: opts.planSource ?? (tier === 'free' ? 'default' : 'subscription'),
    activeTaskLimit: limits.concurrentBoxes,
    mergeQueueLimit: null,
    workflowLimit: null,
    loopLimit: null,
    activeReviewLimit: null,
    tier,
    usage: {
      periodStart: '2026-11-01T00:00:00.000Z',
      periodEnd: PERIOD_END,
      includedWsec: included,
      usedWsec: used,
      percent: usagePercent(used, included),
      exhausted: opts.exhausted ?? false,
    },
    ...(limits.creditsAllowed
      ? {
          credits: {
            balanceMicros: opts.balanceMicros ?? 0,
            expiringSoonMicros: 0,
            lots: [],
          },
          autoTopup: {
            enabled: false,
            triggerMicros: 5_000_000,
            pack: '25' as const,
            monthlyLimitMicros: 100_000_000,
            monthSpentMicros: 0,
            lastFailure: null,
            lastFailureAt: null,
          },
        }
      : {}),
    sizePrices: sizePriceTable(tier),
    concurrentBoxes: { used: 0, limit: limits.concurrentBoxes },
    pricing: opts.maxOffered || tier === 'max' ? BILLING_PRICING_WITH_MAX : BILLING_PRICING_FOR_TESTS,
    ...overrides,
  };
}
