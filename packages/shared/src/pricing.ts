/**
 * Usage pricing: plan tiers, box-hours, sandbox size prices and credits.
 *
 * This replaces the old `'free' | 'unlimited'` plan model and its count caps.
 * There is no feature flag: the release of the workbench branch is the gate.
 * Enforcement still needs the `POLAR_*` env group (absent = limits off).
 *
 * # Units
 *
 * - **Money is integer micro-dollars** (`Micros`, USD × 1,000,000). Cents are
 *   too coarse: a `small` box costs $0.11 an hour, which is 0.18 cents a minute,
 *   and `medium` costs 27.5 cents an hour. A meter that charges each minute in
 *   whole cents would overcharge a small box five times. Polar amounts are in
 *   cents; convert at that edge with {@link centsToMicros} / {@link microsToCents}.
 * - **Usage is integer weighted seconds** (`wsec`): running seconds × the size's
 *   weight. One box-hour is 3,600 wsec, so a `large` box (weight 2) uses one
 *   box-hour in 30 minutes.
 *
 * # Rounding never drifts
 *
 * Each conversion rounds once. Callers that charge in steps must compute every
 * step as the difference of two CUMULATIVE totals (see
 * {@link weightedSecondsDelta} and {@link consumeBudget}). The sum of the steps
 * then equals the conversion of the total, whatever the step size.
 */
import type { SandboxSize } from './sandboxSize.js';

/** Integer micro-dollars: USD × 1,000,000. */
export type Micros = number;

export const MICROS_PER_DOLLAR = 1_000_000;
export const MICROS_PER_CENT = 10_000;

/** Weighted seconds in one box-hour (one `standard` box for one hour). */
export const BOX_HOUR_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Plan tiers
// ---------------------------------------------------------------------------

export const PLAN_TIERS = ['free', 'pro', 'max', 'legacy_pro'] as const;

/** The usage-billing plan tier. `legacy_pro` is the old Unlimited plan at its old price. */
export type PlanTier = (typeof PLAN_TIERS)[number];

export function isPlanTier(value: unknown): value is PlanTier {
  return typeof value === 'string' && (PLAN_TIERS as readonly string[]).includes(value);
}

export const PLAN_TIER_LABELS: Record<PlanTier, string> = {
  free: 'Free',
  pro: 'Pro',
  max: 'Max',
  legacy_pro: 'Legacy Pro',
};

const ALL_SIZES: readonly SandboxSize[] = ['small', 'standard', 'medium', 'large', 'xlarge'];

export interface PlanLimits {
  /** Box-hours included each usage period (a month). Resets with no rollover. */
  readonly includedBoxHours: number;
  /** Boxes that may run at the same time. */
  readonly concurrentBoxes: number;
  /** The sandbox sizes the tier may start. */
  readonly sizes: readonly SandboxSize[];
  /** May buy credits and use auto top-up. */
  readonly creditsAllowed: boolean;
  /** May turn on the auto-keep default and auto-review. */
  readonly autoFeatures: boolean;
}

/** Config constants. Raise them here; nothing else hard-codes a number. */
export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    includedBoxHours: 10,
    concurrentBoxes: 2,
    sizes: ['small', 'standard'],
    creditsAllowed: false,
    autoFeatures: false,
  },
  pro: {
    includedBoxHours: 200,
    concurrentBoxes: 100,
    sizes: ALL_SIZES,
    creditsAllowed: true,
    autoFeatures: true,
  },
  /**
   * Max: five times Pro's hours for two and a half times its price, so a
   * box-hour costs $0.10 here against Pro's $0.20 and the $0.22 credit price.
   * Sold monthly only.
   * The margin holds while a fleet box-hour costs less than about $0.09 after
   * Polar's fees, with every included hour used. See {@link breakEvenBoxHourMicros}.
   */
  max: {
    includedBoxHours: 1000,
    concurrentBoxes: 100,
    sizes: ALL_SIZES,
    creditsAllowed: true,
    autoFeatures: true,
  },
  legacy_pro: {
    includedBoxHours: 50,
    concurrentBoxes: 100,
    sizes: ALL_SIZES,
    creditsAllowed: true,
    autoFeatures: true,
  },
};

export interface PlanPrice {
  readonly monthlyMicros: Micros;
  /** Null when the tier is not sold annually. */
  readonly annualMicros: Micros | null;
}

/** List prices. `legacy_pro` is not sold to new buyers; its price is shown to its holders. */
export const PLAN_PRICES: Record<PlanTier, PlanPrice> = {
  free: { monthlyMicros: 0, annualMicros: null },
  pro: { monthlyMicros: 40 * MICROS_PER_DOLLAR, annualMicros: 400 * MICROS_PER_DOLLAR },
  // Monthly only (Tom, 2026-11-08). There is no annual Max product.
  max: { monthlyMicros: 100 * MICROS_PER_DOLLAR, annualMicros: null },
  legacy_pro: { monthlyMicros: 15 * MICROS_PER_DOLLAR, annualMicros: 150 * MICROS_PER_DOLLAR },
};

/** The tiers a person can buy today. `legacy_pro` is no longer sold. */
export const SELLABLE_TIERS = ['pro', 'max'] as const;
export type SellableTier = (typeof SELLABLE_TIERS)[number];

export function isSellableTier(value: unknown): value is SellableTier {
  return typeof value === 'string' && (SELLABLE_TIERS as readonly string[]).includes(value);
}

/** Paid tiers in order of included hours, so "is this an upgrade" is one comparison. */
const PAID_TIER_RANK: Record<PaidTier, number> = { legacy_pro: 1, pro: 2, max: 3 };

/** True when moving from `from` to `to` buys more included hours. Free is below every paid tier. */
export function isTierUpgrade(from: PlanTier, to: PlanTier): boolean {
  const rank = (tier: PlanTier) => (tier === 'free' ? 0 : PAID_TIER_RANK[tier]);
  return rank(to) > rank(from);
}

/**
 * Polar's fee on one card payment, as a worst case for margin checks: 4% +
 * $0.40, plus 1.5% for an international card and 0.5% for a subscription.
 */
export const PAYMENT_FEE_PERCENT = 6;
export const PAYMENT_FEE_FIXED_MICROS: Micros = 400_000;

/** What a payment of `micros` leaves after {@link PAYMENT_FEE_PERCENT} and the fixed fee. */
export function netOfPaymentFees(micros: Micros): Micros {
  if (micros <= 0) return 0;
  return Math.max(0, Math.round((micros * (100 - PAYMENT_FEE_PERCENT)) / 100) - PAYMENT_FEE_FIXED_MICROS);
}

/**
 * A cautious estimate of what one `standard` box-hour costs us on the fleet,
 * for margin checks only. Nothing bills with it.
 *
 * Derivation (2026-11): the main fleet host is a Scaleway Elastic Metal
 * EM-B520E-NVMe (EPYC 7272, 24 threads, 256 GiB), billed monthly at a
 * listed €189.99, about $205 or $0.28 a host-hour. CPU binds before memory
 * (the host caps at 96 boxes, four a thread). One busy `standard` box per
 * thread (24 at once) costs $0.012 a box-hour; 12 at once costs $0.023.
 * This figure, $0.04, is the 12-box case at a host price near €330 (one
 * listing shows that price, and Scaleway raised other Elastic Metal prices
 * in 2026), plus suspension storage and the control plane. Raise it if the
 * hardware bill says so; the pricing tests then show which tier stops
 * paying for itself.
 */
export const FLEET_BOX_HOUR_COST_ESTIMATE_MICROS: Micros = 40_000;

/** The gross margin every paid tier must keep with all its included hours used. */
export const MIN_FULL_USE_MARGIN_PERCENT = 50;

/**
 * The fleet cost of one box-hour at which a tier's monthly price, net of
 * payment fees, only just pays for every included hour. Above it, a customer
 * who uses the whole allowance loses us money. Zero for a tier that includes
 * nothing or costs nothing.
 */
export function breakEvenBoxHourMicros(tier: PlanTier): Micros {
  const hours = PLAN_LIMITS[tier].includedBoxHours;
  const net = netOfPaymentFees(PLAN_PRICES[tier].monthlyMicros);
  return hours > 0 ? Math.floor(net / hours) : 0;
}

/** A tier somebody pays for. */
export type PaidTier = Exclude<PlanTier, 'free'>;

/** A team seat is a paid tier. There is no free seat, and teams do not sell Max. */
export type TeamTier = Exclude<PaidTier, 'max'>;

/** The tier of a team bought before usage billing. Existing seats keep Legacy Pro terms. */
export const DEFAULT_TEAM_TIER: TeamTier = 'legacy_pro';

/** The tier of a team bought on the new Pro team product: one Pro seat each. */
export const NEW_TEAM_TIER: TeamTier = 'pro';

/** Per-seat list price of a Pro team seat, per month. */
export const TEAM_PRO_SEAT_MONTHLY_MICROS: Micros = PLAN_PRICES.pro.monthlyMicros;

/** The tier a paid team seat gives its holder. An unknown or missing value is a legacy team. */
export function teamSeatTier(teamTier: string | null | undefined): TeamTier {
  return teamTier === 'pro' ? 'pro' : DEFAULT_TEAM_TIER;
}

/** Values `users.plan_override` accepts. `unlimited` is the old comp value. */
export const PLAN_OVERRIDE_VALUES = ['free', 'unlimited', 'pro', 'max', 'legacy_pro'] as const;
export type PlanOverride = (typeof PLAN_OVERRIDE_VALUES)[number];

export function isPlanOverride(value: unknown): value is PlanOverride {
  return typeof value === 'string' && (PLAN_OVERRIDE_VALUES as readonly string[]).includes(value);
}

/**
 * The tier a `users.plan_override` value grants, or null when there is no
 * usable override. Old `unlimited` comps become Pro (spec: comps → Pro).
 */
export function planTierFromOverride(override: string | null | undefined): PlanTier | null {
  switch (override) {
    case 'free':
      return 'free';
    case 'unlimited':
    case 'pro':
      return 'pro';
    case 'max':
      return 'max';
    case 'legacy_pro':
      return 'legacy_pro';
    default:
      return null;
  }
}

export function includedWeightedSeconds(tier: PlanTier): number {
  return boxHoursToWeightedSeconds(PLAN_LIMITS[tier].includedBoxHours);
}

/**
 * The included weighted seconds a usage period holds after its tier changes
 * from `from` to `to` at `now`.
 *
 * An upgrade from one PAID tier to a bigger one adds only the share of the
 * extra hours that is left in the period, the way Polar prorates the charge
 * (`PLAN_CHANGE_PRORATION`). Without this, a Pro subscriber could move to Max
 * on the last day of a period, pay about $2 and get 800 more box-hours.
 *
 * Every other change gives the new tier's full amount at once: a downgrade
 * (the smaller allowance applies now), a move from Free (a checkout starts a
 * new period anyway, so this is a comp), a move to Free, and an unknown tier.
 * The result never goes above the new tier's full amount.
 */
export function includedAfterTierChange(input: {
  from: string;
  to: PlanTier;
  currentIncludedWsec: number;
  period: { start: Date; end: Date };
  now: Date;
}): number {
  const full = includedWeightedSeconds(input.to);
  const { from, to } = input;
  if (!isPlanTier(from) || from === 'free' || to === 'free' || !isTierUpgrade(from, to)) return full;
  const span = input.period.end.getTime() - input.period.start.getTime();
  if (!(span > 0)) return full;
  const left = Math.min(1, Math.max(0, (input.period.end.getTime() - input.now.getTime()) / span));
  const extra = Math.round((full - includedWeightedSeconds(from)) * left);
  const current = Number.isFinite(input.currentIncludedWsec) ? Math.max(0, input.currentIncludedWsec) : 0;
  return Math.min(full, current + Math.max(0, extra));
}

// ---------------------------------------------------------------------------
// Sizes, weights and prices
// ---------------------------------------------------------------------------

/** Price of one box-hour (a `standard` box for one hour): $0.22. */
export const BOX_HOUR_PRICE_MICROS: Micros = 220_000;

/** Weights in hundredths, so every price and usage step stays integer math. */
const SIZE_WEIGHT_HUNDREDTHS: Record<SandboxSize, number> = {
  small: 50,
  standard: 100,
  medium: 125,
  large: 200,
  xlarge: 250,
};

/** How many box-hours one running hour of each size uses. */
export const SIZE_WEIGHT: Record<SandboxSize, number> = mapSizes((size) => SIZE_WEIGHT_HUNDREDTHS[size] / 100);

/** Price per running hour, above the plan: weight × {@link BOX_HOUR_PRICE_MICROS}. */
export const SIZE_PRICE_MICROS_PER_HOUR: Record<SandboxSize, Micros> = mapSizes(
  (size) => (BOX_HOUR_PRICE_MICROS * SIZE_WEIGHT_HUNDREDTHS[size]) / 100,
);

/** The size unattended runs (reviews, loops, merge-queue fixes, auto-keep, workflows) use. */
export const UNATTENDED_SANDBOX_SIZE: SandboxSize = 'small';

export function sizeAllowedOnTier(tier: PlanTier, size: SandboxSize): boolean {
  return PLAN_LIMITS[tier].sizes.includes(size);
}

export interface SizePrice {
  size: SandboxSize;
  weight: number;
  priceMicrosPerHour: Micros;
  /** The tier may start this size. */
  allowed: boolean;
}

/** The sizes table both front ends draw, in size order. */
export function sizePriceTable(tier: PlanTier): SizePrice[] {
  return ALL_SIZES.map((size) => ({
    size,
    weight: SIZE_WEIGHT[size],
    priceMicrosPerHour: SIZE_PRICE_MICROS_PER_HOUR[size],
    allowed: sizeAllowedOnTier(tier, size),
  }));
}

function mapSizes<T>(fn: (size: SandboxSize) => T): Record<SandboxSize, T> {
  return Object.fromEntries(ALL_SIZES.map((size) => [size, fn(size)])) as Record<SandboxSize, T>;
}

// ---------------------------------------------------------------------------
// Usage math
// ---------------------------------------------------------------------------

/**
 * Weighted seconds for `seconds` of running time at `size`, rounded to the
 * nearest integer. `seconds` may be fractional (from millisecond timestamps).
 * Negative or non-finite input counts as zero.
 */
export function weightedSeconds(size: SandboxSize, seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round((seconds * SIZE_WEIGHT_HUNDREDTHS[size]) / 100);
}

/**
 * The weighted seconds a box used between two points of its own running time,
 * both measured from the box's start. Computed from cumulative totals, so a
 * meter that charges every minute adds up to exactly `weightedSeconds(size, total)`.
 */
export function weightedSecondsDelta(size: SandboxSize, prevElapsedSeconds: number, nextElapsedSeconds: number): number {
  return Math.max(0, weightedSeconds(size, nextElapsedSeconds) - weightedSeconds(size, prevElapsedSeconds));
}

export function boxHoursToWeightedSeconds(boxHours: number): number {
  if (!Number.isFinite(boxHours) || boxHours <= 0) return 0;
  return Math.round(boxHours * BOX_HOUR_SECONDS);
}

export function weightedSecondsToBoxHours(wsec: number): number {
  if (!Number.isFinite(wsec) || wsec <= 0) return 0;
  return wsec / BOX_HOUR_SECONDS;
}

/** What `wsec` weighted seconds cost at the box-hour price, rounded to the nearest micro-dollar. */
export function costMicrosForWeightedSeconds(wsec: number): Micros {
  if (!Number.isFinite(wsec) || wsec <= 0) return 0;
  return Math.round((wsec * BOX_HOUR_PRICE_MICROS) / BOX_HOUR_SECONDS);
}

/** What `seconds` of running time at `size` costs from credits (no included hours applied). */
export function runningCostMicros(size: SandboxSize, seconds: number): Micros {
  return costMicrosForWeightedSeconds(weightedSeconds(size, seconds));
}

export interface BudgetSplit {
  /** Part of the step that the included hours cover. */
  fromIncludedWsec: number;
  /** Part of the step above the included hours. */
  overageWsec: number;
  /** What the overage costs in credits. */
  overageMicros: Micros;
}

/**
 * Split one metering step into included hours and credits. Included hours go
 * first. `overageMicros` is the difference of two cumulative costs, so steps
 * never drift from the total.
 */
export function consumeBudget(input: { includedWsec: number; usedBeforeWsec: number; deltaWsec: number }): BudgetSplit {
  const included = Math.max(0, input.includedWsec);
  const before = Math.max(0, input.usedBeforeWsec);
  const delta = Math.max(0, input.deltaWsec);
  const after = before + delta;
  const overBefore = Math.max(0, before - included);
  const overAfter = Math.max(0, after - included);
  const overageWsec = overAfter - overBefore;
  return {
    fromIncludedWsec: delta - overageWsec,
    overageWsec,
    overageMicros: costMicrosForWeightedSeconds(overAfter) - costMicrosForWeightedSeconds(overBefore),
  };
}

/** Percent of the included hours used, floored and clamped to 0..100. Zero included reads as 100 once anything is used. */
export function usagePercent(usedWsec: number, includedWsec: number): number {
  if (usedWsec <= 0) return 0;
  if (includedWsec <= 0) return 100;
  return Math.min(100, Math.floor((usedWsec * 100) / includedWsec));
}

// ---------------------------------------------------------------------------
// Usage periods
// ---------------------------------------------------------------------------

/** Add calendar months in UTC. The day clamps to the target month's last day (Jan 31 + 1 → Feb 28/29). */
export function addMonthsUtc(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

export interface UsagePeriod {
  /** Inclusive. */
  start: Date;
  /** Exclusive. */
  end: Date;
}

/**
 * The monthly usage period that contains `now`.
 *
 * - `anchor` null (free users, comps): the calendar month in UTC.
 * - `anchor` set (subscribers; pass `current_period_end`): monthly windows on
 *   the anchor's DAY, starting at 00:00 UTC (Tom, 2026-11-08: a reset is a
 *   calendar date, not the time of day the subscription began). Annual
 *   subscribers reset monthly too, because included hours are per month. Each
 *   boundary is `anchor + k months` from the anchor itself, never chained, so a
 *   31st-day anchor does not drift to the 28th.
 */
export function usagePeriodFor(input: { now: Date; anchor?: Date | null }): UsagePeriod {
  const { now } = input;
  if (!input.anchor || Number.isNaN(input.anchor.getTime())) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { start, end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
  }
  const anchor = new Date(Date.UTC(input.anchor.getUTCFullYear(), input.anchor.getUTCMonth(), input.anchor.getUTCDate()));
  let k =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  while (addMonthsUtc(anchor, k).getTime() > now.getTime()) k--;
  while (addMonthsUtc(anchor, k + 1).getTime() <= now.getTime()) k++;
  return { start: addMonthsUtc(anchor, k), end: addMonthsUtc(anchor, k + 1) };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export const USAGE_ALERT_THRESHOLDS = [50, 80, 100] as const;
export type UsageAlertThreshold = (typeof USAGE_ALERT_THRESHOLDS)[number];

/**
 * The thresholds a step crossed: below before, at or above after. Empty when
 * nothing is included (there is nothing to warn about).
 */
export function crossedUsageThresholds(usedBeforeWsec: number, usedAfterWsec: number, includedWsec: number): UsageAlertThreshold[] {
  if (includedWsec <= 0) return [];
  return USAGE_ALERT_THRESHOLDS.filter((pct) => {
    const line = (includedWsec * pct) / 100;
    return usedBeforeWsec < line && usedAfterWsec >= line;
  });
}

// ---------------------------------------------------------------------------
// Usage reset
// ---------------------------------------------------------------------------

/**
 * The tiers that can buy a usage reset: every paid tier. A reset is a one-time
 * payment of the tier's monthly price that sets the current period's used
 * box-hours back to zero and the included hours to the full allowance of the
 * tier paid for. The period end does not move, and included hours that were
 * left are not added on top.
 */
export const USAGE_RESET_TIERS = ['pro', 'max', 'legacy_pro'] as const satisfies readonly PaidTier[];
export type UsageResetTier = (typeof USAGE_RESET_TIERS)[number];

export function isUsageResetTier(value: unknown): value is UsageResetTier {
  return typeof value === 'string' && (USAGE_RESET_TIERS as readonly string[]).includes(value);
}

/** What a reset costs: the tier's monthly list price, also for an annual subscriber. */
export function usageResetPriceMicros(tier: UsageResetTier): Micros {
  return PLAN_PRICES[tier].monthlyMicros;
}

/** `BillingStatus.usageReset`: present only when this account can buy a reset now. */
export interface UsageResetOffer {
  tier: UsageResetTier;
  priceMicros: Micros;
  /** The included weighted seconds the period holds after the reset (the tier's full allowance). */
  includedWsec: number;
}

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

export const CREDIT_PACK_IDS = ['25', '100', '500'] as const;
export type CreditPackId = (typeof CREDIT_PACK_IDS)[number];

export function isCreditPackId(value: unknown): value is CreditPackId {
  return typeof value === 'string' && (CREDIT_PACK_IDS as readonly string[]).includes(value);
}

export interface CreditPack {
  readonly id: CreditPackId;
  /** What the buyer pays. */
  readonly priceMicros: Micros;
  /** What lands in the balance: the price plus the bonus. */
  readonly creditMicros: Micros;
  readonly bonusPercent: number;
}

export const CREDIT_PACKS: Record<CreditPackId, CreditPack> = {
  '25': { id: '25', priceMicros: 25 * MICROS_PER_DOLLAR, creditMicros: 25 * MICROS_PER_DOLLAR, bonusPercent: 0 },
  '100': { id: '100', priceMicros: 100 * MICROS_PER_DOLLAR, creditMicros: 105 * MICROS_PER_DOLLAR, bonusPercent: 5 },
  '500': { id: '500', priceMicros: 500 * MICROS_PER_DOLLAR, creditMicros: 550 * MICROS_PER_DOLLAR, bonusPercent: 10 },
};

export function creditPackBonusMicros(id: CreditPackId): Micros {
  return CREDIT_PACKS[id].creditMicros - CREDIT_PACKS[id].priceMicros;
}

/** Credits expire this many months after purchase. */
export const CREDIT_EXPIRY_MONTHS = 12;

/** The instant a lot bought at `purchasedAt` expires (clamped like {@link addMonthsUtc}). */
export function creditExpiresAt(purchasedAt: Date): Date {
  return addMonthsUtc(purchasedAt, CREDIT_EXPIRY_MONTHS);
}

export type CreditLotSource = 'purchase' | 'auto_topup' | 'grant' | 'refund_reversal';

/** A credit lot as the API shows it. */
export interface CreditLot {
  id: string;
  totalMicros: Micros;
  remainingMicros: Micros;
  source: CreditLotSource;
  purchasedAt: string; // ISO
  expiresAt: string; // ISO
}

type LotLike = Pick<CreditLot, 'remainingMicros' | 'expiresAt'>;

/** A lot counts while it has credit left and `now` is before its expiry. */
export function isCreditLotLive(lot: LotLike, now: Date): boolean {
  return lot.remainingMicros > 0 && new Date(lot.expiresAt).getTime() > now.getTime();
}

export function creditBalanceMicros(lots: readonly LotLike[], now: Date): Micros {
  return lots.reduce((sum, lot) => (isCreditLotLive(lot, now) ? sum + lot.remainingMicros : sum), 0);
}

/** The window "expiring soon" covers in the UI. */
export const CREDIT_EXPIRING_SOON_DAYS = 30;

export function expiringSoonMicros(lots: readonly LotLike[], now: Date, withinDays = CREDIT_EXPIRING_SOON_DAYS): Micros {
  const horizon = now.getTime() + withinDays * 86_400_000;
  return lots.reduce(
    (sum, lot) => (isCreditLotLive(lot, now) && new Date(lot.expiresAt).getTime() <= horizon ? sum + lot.remainingMicros : sum),
    0,
  );
}

export interface CreditBurn {
  burns: Array<{ lotId: string; micros: Micros }>;
  burnedMicros: Micros;
  /** What the live lots could not cover. */
  shortMicros: Micros;
}

/**
 * The reference burn order: live lots, soonest expiry first (ties by id).
 * Pure; the ledger does the same walk in SQL and its tests pin it to this.
 */
export function burnCreditLots(lots: ReadonlyArray<Pick<CreditLot, 'id' | 'remainingMicros' | 'expiresAt'>>, amountMicros: Micros, now: Date): CreditBurn {
  let left = Math.max(0, amountMicros);
  const burns: CreditBurn['burns'] = [];
  const live = lots
    .filter((lot) => isCreditLotLive(lot, now))
    .sort((a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime() || a.id.localeCompare(b.id));
  for (const lot of live) {
    if (left <= 0) break;
    const take = Math.min(left, lot.remainingMicros);
    burns.push({ lotId: lot.id, micros: take });
    left -= take;
  }
  const want = Math.max(0, amountMicros);
  return { burns, burnedMicros: want - left, shortMicros: left };
}

export function centsToMicros(cents: number): Micros {
  return Math.round(cents) * MICROS_PER_CENT;
}

/** Micro-dollars to whole cents, rounded to the nearest cent (for Polar amounts). */
export function microsToCents(micros: Micros): number {
  return Math.round(micros / MICROS_PER_CENT);
}

// ---------------------------------------------------------------------------
// Auto top-up
// ---------------------------------------------------------------------------

export const AUTO_TOPUP_DEFAULT_TRIGGER_MICROS: Micros = 5 * MICROS_PER_DOLLAR;
export const AUTO_TOPUP_DEFAULT_PACK: CreditPackId = '25';
export const AUTO_TOPUP_DEFAULT_MONTHLY_LIMIT_MICROS: Micros = 100 * MICROS_PER_DOLLAR;

/** What a user sets: below `triggerMicros`, buy `pack`, at most `monthlyLimitMicros` a calendar month (UTC). */
export interface AutoTopupConfig {
  enabled: boolean;
  triggerMicros: Micros;
  pack: CreditPackId;
  monthlyLimitMicros: Micros;
}

/** The settings plus their state, as `GET /billing/auto-topup` and `BillingStatus` show them. */
export interface AutoTopupSettings extends AutoTopupConfig {
  /** Spent by auto top-up in the current UTC month. */
  monthSpentMicros: Micros;
  lastFailure: string | null;
  lastFailureAt: string | null; // ISO
}

export const AUTO_TOPUP_DEFAULTS: AutoTopupConfig = {
  enabled: false,
  triggerMicros: AUTO_TOPUP_DEFAULT_TRIGGER_MICROS,
  pack: AUTO_TOPUP_DEFAULT_PACK,
  monthlyLimitMicros: AUTO_TOPUP_DEFAULT_MONTHLY_LIMIT_MICROS,
};

/** The key the monthly spend counter belongs to: `YYYY-MM` in UTC. */
export function autoTopupMonthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Problems with a settings update, empty when valid. User-facing sentences. */
export function validateAutoTopupConfig(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['Auto top-up settings must be an object.'];
  const v = input as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof v.enabled !== 'boolean') errors.push('enabled must be true or false.');
  if (!isCreditPackId(v.pack)) errors.push(`pack must be one of ${CREDIT_PACK_IDS.join(', ')}.`);
  if (!isNonNegativeInteger(v.triggerMicros)) errors.push('triggerMicros must be a whole number of micro-dollars, 0 or more.');
  if (!isNonNegativeInteger(v.monthlyLimitMicros)) {
    errors.push('monthlyLimitMicros must be a whole number of micro-dollars, 0 or more.');
  } else if (isCreditPackId(v.pack) && v.monthlyLimitMicros < CREDIT_PACKS[v.pack].priceMicros) {
    errors.push('The monthly limit must cover at least one top-up.');
  }
  return errors;
}

/**
 * Whether an auto top-up should run now: on, the balance is below the
 * trigger, and one more pack fits in this month's limit. `monthSpentMicros`
 * must belong to the current {@link autoTopupMonthKey}; pass 0 for a new month.
 */
export function shouldAutoTopUp(config: AutoTopupConfig, input: { balanceMicros: Micros; monthSpentMicros: Micros }): boolean {
  if (!config.enabled) return false;
  if (input.balanceMicros >= config.triggerMicros) return false;
  return input.monthSpentMicros + CREDIT_PACKS[config.pack].priceMicros <= config.monthlyLimitMicros;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// ---------------------------------------------------------------------------
// API shapes
// ---------------------------------------------------------------------------

export type UsageSubjectKind = 'task' | 'review_unit' | 'workbench';

/** The current period's usage, in `BillingStatus.usage`. */
export interface UsageSummary {
  periodStart: string; // ISO
  periodEnd: string; // ISO
  includedWsec: number;
  usedWsec: number;
  /** Floored, 0..100. See {@link usagePercent}. */
  percent: number;
  /** Included hours and credits are both spent; new boxes are refused. */
  exhausted: boolean;
  /** Usage resets bought in this period. Absent on a backend without resets. */
  resets?: number;
}

/** Credit balance, in `BillingStatus.credits` and `GET /billing/credits`. */
export interface CreditSummary {
  balanceMicros: Micros;
  expiringSoonMicros: Micros;
  lots: CreditLot[];
}

export interface ConcurrentBoxUsage {
  used: number;
  limit: number;
}

/** Plan prices the clients draw, so no front end hard-codes a dollar amount. */
export interface BillingPricing {
  proMonthlyMicros: Micros;
  proAnnualMicros: Micros;
  legacyProMonthlyMicros: Micros;
  boxHourMicros: Micros;
  /**
   * Max's price. Max is sold monthly only. Sent only when this deployment
   * sells Max (the Max product is set) or the account already holds it.
   * Absent means "do not offer Max", which is also how a client reads an
   * older backend.
   */
  maxMonthlyMicros?: Micros;
}

/** One metered box interval, as `GET /billing/usage` lists it. */
export interface UsageIntervalPublic {
  id: string;
  subjectKind: UsageSubjectKind;
  subjectId: string;
  workspaceId: string | null;
  size: SandboxSize;
  startedAt: string; // ISO
  endedAt: string | null; // ISO; null while running
  wsec: number;
}

export interface UsageDay {
  date: string; // YYYY-MM-DD (UTC)
  wsec: number;
  byKind: Partial<Record<UsageSubjectKind, number>>;
}

/** `GET /billing/usage`. */
export interface BillingUsageResponse {
  days: UsageDay[];
  intervals: UsageIntervalPublic[];
}

/** `billing:usage_alert` WS payload. */
export interface UsageAlertEvent {
  thresholdPct: UsageAlertThreshold;
  usedWsec: number;
  includedWsec: number;
  tier: PlanTier;
  periodEnd: string; // ISO
}

/** `billing:exhausted` WS payload. */
export interface UsageExhaustedEvent {
  tier: PlanTier;
  periodEnd: string; // ISO
  creditsAllowed: boolean;
}

// ---------------------------------------------------------------------------
// Formatting (both front ends)
// ---------------------------------------------------------------------------

/**
 * "$25.00", "-$1.50". Rounds half away from zero at `fractionDigits` (0..6).
 */
export function formatUsd(micros: Micros, fractionDigits = 2): string {
  const digits = Math.min(6, Math.max(0, Math.trunc(fractionDigits)));
  const step = 10 ** (6 - digits);
  const units = Math.round(Math.abs(micros) / step);
  const whole = Math.floor(units / 10 ** digits);
  const frac = units % 10 ** digits;
  const sign = micros < 0 && units > 0 ? '-' : '';
  const wholeText = whole.toLocaleString('en-US');
  return digits ? `${sign}$${wholeText}.${String(frac).padStart(digits, '0')}` : `${sign}$${wholeText}`;
}

/** "$0.22/h", "$0.275/h": two decimals, or three when the price needs them. */
export function formatPricePerHour(micros: Micros): string {
  const needsThree = Math.round(micros / 1000) % 10 !== 0;
  return `${formatUsd(micros, needsThree ? 3 : 2)}/h`;
}

export function formatSizePrice(size: SandboxSize): string {
  return formatPricePerHour(SIZE_PRICE_MICROS_PER_HOUR[size]);
}

/**
 * Box-hours as text, floored to one decimal so the UI never claims more use
 * than happened: "37.5", "200", "1,000", "0".
 */
export function formatBoxHours(wsec: number): string {
  const tenths = Math.floor((Math.max(0, wsec) * 10) / BOX_HOUR_SECONDS);
  const whole = Math.floor(tenths / 10).toLocaleString('en-US');
  return tenths % 10 === 0 ? whole : `${whole}.${tenths % 10}`;
}

/**
 * Box-hours to three decimals, floored, for the operator console: "0.016",
 * "2.905", "1,000". An amount above zero and below 0.001 shows as "<0.001",
 * so a short run never reads as free.
 */
export function formatBoxHoursPrecise(wsec: number): string {
  const safe = Math.max(0, wsec);
  const thousandths = Math.floor((safe * 1000) / BOX_HOUR_SECONDS);
  if (thousandths === 0) return safe > 0 ? '<0.001' : '0';
  const whole = Math.floor(thousandths / 1000).toLocaleString('en-US');
  const fraction = String(thousandths % 1000).padStart(3, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** "1 box-hour", "2.5 box-hours". */
export function formatBoxHoursLabel(wsec: number): string {
  const text = formatBoxHours(wsec);
  return `${text} box-hour${text === '1' ? '' : 's'}`;
}

/** "37.5 of 200 box-hours". */
export function formatBoxHoursUsage(usedWsec: number, includedWsec: number): string {
  return `${formatBoxHours(usedWsec)} of ${formatBoxHoursLabel(includedWsec)}`;
}

/** "$25", "$100 (+5% bonus)". */
export function formatCreditPack(id: CreditPackId): string {
  const pack = CREDIT_PACKS[id];
  const price = formatUsd(pack.priceMicros, 0);
  return pack.bonusPercent ? `${price} (+${pack.bonusPercent}% bonus)` : price;
}

/** What a monthly Pro subscriber saves a year by paying annually, in micro-dollars (never negative). */
export function annualSavingsMicros(pricing: Pick<BillingPricing, 'proMonthlyMicros' | 'proAnnualMicros'>): Micros {
  return Math.max(0, pricing.proMonthlyMicros * 12 - pricing.proAnnualMicros);
}

/**
 * The prices of a sellable tier, or null when the pricing does not offer it.
 * `annualMicros` is null for a tier sold monthly only (Max).
 */
export function sellableTierPrices(
  tier: SellableTier,
  pricing: BillingPricing,
): { monthlyMicros: Micros; annualMicros: Micros | null } | null {
  if (tier === 'pro') return { monthlyMicros: pricing.proMonthlyMicros, annualMicros: pricing.proAnnualMicros };
  if (pricing.maxMonthlyMicros == null) return null;
  return { monthlyMicros: pricing.maxMonthlyMicros, annualMicros: null };
}

/** Whether a sellable tier can be bought annually. */
export function tierSoldAnnually(tier: SellableTier): boolean {
  return PLAN_PRICES[tier].annualMicros != null;
}

export const BILLING_PERIOD_LABELS = { monthly: 'Monthly', annual: 'Annual' } as const;

/**
 * "Pro · Monthly · $40/month": the plan card's line for a paid subscriber.
 * Null when the period is unknown or the tier is free, so the caller can keep
 * its older wording.
 */
export function formatPlanPeriodLine(
  tier: PlanTier,
  period: 'monthly' | 'annual' | null | undefined,
  pricing: Pick<BillingPricing, 'proMonthlyMicros' | 'proAnnualMicros' | 'legacyProMonthlyMicros' | 'maxMonthlyMicros'>
): string | null {
  if (tier === 'free' || !period) return null;
  const micros =
    tier === 'legacy_pro'
      ? period === 'monthly'
        ? pricing.legacyProMonthlyMicros
        : PLAN_PRICES.legacy_pro.annualMicros
      : tier === 'max'
        ? period === 'monthly'
          ? (pricing.maxMonthlyMicros ?? PLAN_PRICES.max.monthlyMicros)
          : PLAN_PRICES.max.annualMicros
        : period === 'monthly'
          ? pricing.proMonthlyMicros
          : pricing.proAnnualMicros;
  if (micros == null) return null;
  return `${PLAN_TIER_LABELS[tier]} · ${BILLING_PERIOD_LABELS[period]} · ${formatUsd(micros, 0)}/${period === 'monthly' ? 'month' : 'year'}`;
}
