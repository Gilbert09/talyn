import {
  PLAN_LIMITS,
  boxHoursToWeightedSeconds,
  sizePriceTable,
  usagePercent,
  type BillingStatus,
  type CreditLot,
  type PlanTier,
} from '@talyn/shared';

/** A billing status from a backend that predates usage billing. */
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

export const PERIOD_END = '2026-12-01T00:00:00.000Z';

/** A billing status from a backend with usage billing. `usedHours` is box-hours. */
export function usageStatus(
  tier: PlanTier,
  opts: {
    usedHours?: number;
    exhausted?: boolean;
    balanceMicros?: number;
    lots?: CreditLot[];
    expiringSoonMicros?: number;
    /** The credit draw's start, as the backend sends it while the account draws on credit. */
    drawStartMicros?: number;
    /** Send Max prices, as a backend does when this account may buy Max. A Max holder always gets them. */
    maxOffered?: boolean;
    overrides?: Partial<BillingStatus>;
  } = {},
): BillingStatus {
  const includedWsec = boxHoursToWeightedSeconds(PLAN_LIMITS[tier].includedBoxHours);
  const usedWsec = boxHoursToWeightedSeconds(opts.usedHours ?? 0);
  const creditsAllowed = PLAN_LIMITS[tier].creditsAllowed;
  return oldStatus({
    plan: tier,
    planSource: tier === 'free' ? 'default' : 'subscription',
    activeTaskLimit: PLAN_LIMITS[tier].concurrentBoxes,
    mergeQueueLimit: null,
    workflowLimit: null,
    loopLimit: null,
    activeReviewLimit: null,
    tier,
    usage: {
      periodStart: '2026-11-01T00:00:00.000Z',
      periodEnd: PERIOD_END,
      includedWsec,
      usedWsec,
      percent: usagePercent(usedWsec, includedWsec),
      exhausted: opts.exhausted ?? false,
    },
    ...(creditsAllowed || opts.balanceMicros
      ? {
          credits: {
            balanceMicros: opts.balanceMicros ?? 0,
            expiringSoonMicros: opts.expiringSoonMicros ?? 0,
            lots: opts.lots ?? [],
            ...(opts.drawStartMicros !== undefined ? { drawStartMicros: opts.drawStartMicros } : {}),
          },
        }
      : {}),
    ...(creditsAllowed
      ? {
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
    concurrentBoxes: { used: 1, limit: PLAN_LIMITS[tier].concurrentBoxes },
    pricing: {
      proMonthlyMicros: 40_000_000,
      proAnnualMicros: 400_000_000,
      legacyProMonthlyMicros: 15_000_000,
      boxHourMicros: 220_000,
      ...(opts.maxOffered || tier === 'max' ? { maxMonthlyMicros: 100_000_000 } : {}),
    },
    ...opts.overrides,
  });
}
