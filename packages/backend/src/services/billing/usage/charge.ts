import { eq } from 'drizzle-orm';
import {
  AUTO_TOPUP_DEFAULTS,
  autoTopupMonthKey,
  consumeBudget,
  CREDIT_PACKS,
  isCreditPackId,
  PLAN_LIMITS,
  shouldAutoTopUp,
  USAGE_ALERT_THRESHOLDS,
  usagePeriodFor,
  weightedSeconds,
  type AutoTopupConfig,
  type Micros,
  type PlanTier,
  type SandboxSize,
  type UsagePeriod,
} from '@talyn/shared';
import { getPoolDbClient } from '../../../db/client.js';
import { autoTopupSettings } from '../../../db/schema.js';
import { tryAutoTopUp } from '../autoTopup.js';
import { billingEnabled, buildBillingStatus } from '../entitlements.js';
import { debugBus } from '../../debugBus.js';
import { emitSubscriptionUpdated } from '../../websocket.js';
import { sendExhaustedNotice, sendUsageAlert } from './alerts.js';
import { burnCredits, creditBalance } from './credits.js';
import { enforceExhaustion } from './exhaustion.js';
import { advanceBilledThrough, unbilledIntervalsQuery, type IntervalRow } from './intervals.js';
import { addCreditUse, addUsage, clearExhausted, ensurePeriod, readPeriod, stampAlert, stampExhausted } from './periods.js';
import { resolveUsageTier, type UsageTier } from './tier.js';

export interface UsageBudget {
  tier: PlanTier;
  period: UsagePeriod;
  includedWsec: number;
  usedWsec: number;
  /** Included weighted seconds left this period, 0 or more. */
  includedLeftWsec: number;
  /** Live (unexpired) credit balance. */
  creditMicros: Micros;
  /** Included hours and credits are spent, and auto top-up cannot cover it. */
  exhausted: boolean;
  /** Auto top-up is on, has room this month, and has not failed since it last worked. */
  autoTopupPossible: boolean;
}

export const AUTO_TOPUP_COLUMNS = {
  enabled: autoTopupSettings.enabled,
  triggerMicros: autoTopupSettings.triggerMicros,
  pack: autoTopupSettings.pack,
  monthlyLimitMicros: autoTopupSettings.monthlyLimitMicros,
  monthKey: autoTopupSettings.monthKey,
  monthSpentMicros: autoTopupSettings.monthSpentMicros,
  lastFailure: autoTopupSettings.lastFailure,
} as const;

interface AutoTopupState {
  config: AutoTopupConfig;
  /** This month's spend (0 when the stored counter belongs to another month). */
  monthSpentMicros: Micros;
  lastFailure: string | null;
}

async function readAutoTopup(ownerId: string, now: Date): Promise<AutoTopupState> {
  const [row] = await getPoolDbClient()
    .select(AUTO_TOPUP_COLUMNS)
    .from(autoTopupSettings)
    .where(eq(autoTopupSettings.ownerId, ownerId))
    .limit(1);
  if (!row) return { config: AUTO_TOPUP_DEFAULTS, monthSpentMicros: 0, lastFailure: null };
  return {
    config: {
      enabled: row.enabled,
      triggerMicros: Number(row.triggerMicros),
      pack: isCreditPackId(row.pack) ? row.pack : AUTO_TOPUP_DEFAULTS.pack,
      monthlyLimitMicros: Number(row.monthlyLimitMicros),
    },
    monthSpentMicros: row.monthKey === autoTopupMonthKey(now) ? Number(row.monthSpentMicros) : 0,
    lastFailure: row.lastFailure,
  };
}

/** Pure: whether auto top-up could still buy a pack for this tier. */
export function autoTopupPossibleFor(tier: PlanTier, state: AutoTopupState): boolean {
  if (!PLAN_LIMITS[tier].creditsAllowed || !state.config.enabled || state.lastFailure) return false;
  return state.monthSpentMicros + CREDIT_PACKS[state.config.pack].priceMicros <= state.config.monthlyLimitMicros;
}

/** Pure: out of budget. */
export function isExhausted(input: { includedLeftWsec: number; creditMicros: Micros; autoTopupPossible: boolean }): boolean {
  return input.includedLeftWsec <= 0 && input.creditMicros <= 0 && !input.autoTopupPossible;
}

/**
 * The owner's budget now. Reads two small rows and one SUM over live lots; it
 * does not charge (call {@link chargeOwnerAt} first for an up-to-the-second
 * figure; the meter charges every minute).
 */
export async function readBudget(ownerId: string, now = new Date(), resolved?: UsageTier): Promise<UsageBudget> {
  const { tier, periodAnchor } = resolved ?? (await resolveUsageTier(ownerId));
  const period = usagePeriodFor({ now, anchor: periodAnchor });
  await ensurePeriod(ownerId, tier, period, now);
  const row = await readPeriod(ownerId, period.start);
  const includedWsec = Number(row?.includedWsec ?? 0);
  const usedWsec = Number(row?.usedWsec ?? 0);
  const [creditMicros, topup] = await Promise.all([creditBalance(ownerId, now), readAutoTopup(ownerId, now)]);
  const includedLeftWsec = Math.max(0, includedWsec - usedWsec);
  const autoTopupPossible = autoTopupPossibleFor(tier, topup);
  return {
    tier,
    period,
    includedWsec,
    usedWsec,
    includedLeftWsec,
    creditMicros,
    autoTopupPossible,
    exhausted: isExhausted({ includedLeftWsec, creditMicros, autoTopupPossible }),
  };
}

/**
 * Split `[from, to)` of an interval at usage-period boundaries, with each
 * piece's weighted seconds computed from cumulative elapsed time (so the
 * pieces add up to exactly the interval's total; see `weightedSecondsDelta`).
 */
export function chargeSegments(
  interval: { size: SandboxSize; startedAt: Date },
  from: Date,
  to: Date,
  anchor: Date | null,
): Array<{ period: UsagePeriod; wsec: number }> {
  const out: Array<{ period: UsagePeriod; wsec: number }> = [];
  const elapsed = (d: Date) => (d.getTime() - interval.startedAt.getTime()) / 1000;
  let cursor = from;
  while (cursor.getTime() < to.getTime()) {
    const period = usagePeriodFor({ now: cursor, anchor });
    const end = period.end.getTime() < to.getTime() ? period.end : to;
    const wsec = weightedSeconds(interval.size, elapsed(end)) - weightedSeconds(interval.size, elapsed(cursor));
    out.push({ period, wsec: Math.max(0, wsec) });
    cursor = end;
  }
  return out;
}

interface PeriodTotals {
  period: UsagePeriod;
  overageMicros: Micros;
  intervalIds: string[];
}

/** Charge one interval up to `now` (or its end). Adds to `totals`; false when another charge won the CAS. */
async function chargeInterval(
  ownerId: string,
  tier: PlanTier,
  anchor: Date | null,
  interval: IntervalRow,
  now: Date,
  totals: Map<number, PeriodTotals>,
): Promise<boolean> {
  const target = interval.endedAt && interval.endedAt.getTime() < now.getTime() ? interval.endedAt : now;
  if (target.getTime() <= interval.billedThrough.getTime()) return false;
  const size = interval.size as SandboxSize;
  const segments = chargeSegments({ size, startedAt: interval.startedAt }, interval.billedThrough, target, anchor);
  const delta = segments.reduce((sum, s) => sum + s.wsec, 0);
  // CAS first: a crash after it loses these seconds (in the owner's favour);
  // the other order would bill them twice.
  if (!(await advanceBilledThrough(interval.id, interval.billedThrough, target, delta))) return false;
  for (const { period, wsec } of segments) {
    if (wsec <= 0) continue;
    await ensurePeriod(ownerId, tier, period, now);
    const after = await addUsage(ownerId, period.start, wsec);
    if (!after) continue;
    const split = consumeBudget({ includedWsec: after.includedWsec, usedBeforeWsec: after.usedWsec - wsec, deltaWsec: wsec });
    const key = period.start.getTime();
    const t = totals.get(key) ?? { period, overageMicros: 0, intervalIds: [] };
    t.overageMicros += split.overageMicros;
    t.intervalIds.push(interval.id);
    totals.set(key, t);
  }
  return true;
}

/** Burn a period's overage from credits, topping up once when short. Returns what stayed uncovered. */
async function payOverage(ownerId: string, tier: PlanTier, totals: PeriodTotals, now: Date): Promise<{ uncovered: Micros; topUpFailed: boolean }> {
  const context = { periodStart: totals.period.start, intervalId: totals.intervalIds.length === 1 ? totals.intervalIds[0] : null };
  const first = await burnCredits(ownerId, totals.overageMicros, now, context);
  let burned = first.burnedMicros;
  let short = first.shortMicros;
  let topUpFailed = false;
  if (PLAN_LIMITS[tier].creditsAllowed) {
    const topup = await readAutoTopup(ownerId, now);
    const balance = short > 0 ? 0 : await creditBalance(ownerId, now);
    const wanted = short > 0 || shouldAutoTopUp(topup.config, { balanceMicros: balance, monthSpentMicros: topup.monthSpentMicros });
    if (wanted && topup.config.enabled) {
      const topped = await tryAutoTopUp(ownerId, short).catch(() => false);
      if (topped && short > 0) {
        const second = await burnCredits(ownerId, short, now, context);
        burned += second.burnedMicros;
        short = second.shortMicros;
      }
      topUpFailed = !topped && short > 0;
    }
  }
  await addCreditUse(ownerId, totals.period.start, burned, short);
  return { uncovered: short, topUpFailed };
}

/** Stamp and send every threshold the period has reached and not yet announced. */
async function announceThresholds(ownerId: string, tier: PlanTier, period: UsagePeriod, now: Date): Promise<void> {
  const row = await readPeriod(ownerId, period.start);
  if (!row) return;
  const used = Number(row.usedWsec);
  const included = Number(row.includedWsec);
  if (included <= 0) return;
  const stamped = { 50: row.alert50At, 80: row.alert80At, 100: row.alert100At } as const;
  for (const pct of USAGE_ALERT_THRESHOLDS) {
    if (stamped[pct] || used * 100 < included * pct) continue;
    if (!(await stampAlert(ownerId, period.start, pct, now))) continue;
    await sendUsageAlert(ownerId, {
      thresholdPct: pct,
      usedWsec: used,
      includedWsec: included,
      tier,
      periodEnd: period.end.toISOString(),
    });
  }
}

/** Refresh the owner's open apps with the new billing snapshot. Best effort. */
async function pushBillingStatus(ownerId: string): Promise<void> {
  try {
    emitSubscriptionUpdated(ownerId, await buildBillingStatus(ownerId));
  } catch (error) {
    debugBus.recordEvent({ service: 'billing', action: 'usage_status_push', summary: 'Could not push the billing status', ok: false, error });
  }
}

export interface ChargeResult {
  chargedIntervals: number;
  exhausted: boolean;
  /** The budget after this step. */
  budget: UsageBudget;
}

/**
 * One owner's charge step. Idempotent and safe on every replica at once:
 *
 * 1. Each owed interval moves its `billed_through` cursor by CAS; the loser of
 *    a race skips it, so no second is billed twice.
 * 2. The period counter takes an atomic `+=`; `consumeBudget` splits each
 *    step into included hours and overage from the totals that add returned.
 * 3. Overage burns credits soonest-expiry first; a shortfall tries auto top-up
 *    once.
 * 4. Thresholds and exhaustion are stamped `WHERE ... IS NULL`, so each alert
 *    and the exhaustion notice fire once.
 *
 * No advisory lock. Alerts and exhaustion only run when billing is
 * configured (the POLAR_* env group), like every other enforcement.
 */
export async function chargeOwnerAt(ownerId: string, now: Date): Promise<ChargeResult> {
  const resolved = await resolveUsageTier(ownerId);
  const { tier, periodAnchor } = resolved;
  const owed = await unbilledIntervalsQuery(ownerId);
  const totals = new Map<number, PeriodTotals>();
  let chargedIntervals = 0;
  for (const interval of owed) {
    if (await chargeInterval(ownerId, tier, periodAnchor, interval, now, totals)) chargedIntervals += 1;
  }

  let topUpFailed = false;
  for (const t of totals.values()) {
    if (t.overageMicros <= 0) continue;
    const paid = await payOverage(ownerId, tier, t, now);
    topUpFailed ||= paid.topUpFailed;
  }

  const current = usagePeriodFor({ now, anchor: periodAnchor });
  const enforce = billingEnabled();
  if (enforce) {
    for (const t of totals.values()) await announceThresholds(ownerId, tier, t.period, now);
  }

  const read = await readBudget(ownerId, now, resolved);
  // A top-up that just failed outranks settings that say one is possible.
  const exhausted = read.exhausted || (topUpFailed && read.includedLeftWsec <= 0 && read.creditMicros <= 0);
  const budget: UsageBudget = exhausted ? { ...read, exhausted, autoTopupPossible: false } : read;
  if (!enforce) return { chargedIntervals, exhausted, budget };

  if (exhausted) {
    if (await stampExhausted(ownerId, current.start, now)) {
      await sendExhaustedNotice(ownerId, tier, current.end);
      await pushBillingStatus(ownerId);
    }
    await enforceExhaustion(ownerId, now);
  } else {
    const row = await readPeriod(ownerId, current.start);
    if (row?.exhaustedAt) await clearExhausted(ownerId);
  }
  return { chargedIntervals, exhausted, budget };
}
