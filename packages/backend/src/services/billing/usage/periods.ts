import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  includedAfterTierChange,
  includedWeightedSeconds,
  type PlanTier,
  type UsageAlertThreshold,
  type UsagePeriod,
} from '@talyn/shared';
import { getPoolDbClient } from '../../../db/client.js';
import { usagePeriods } from '../../../db/schema.js';
import { domainEvents } from '../../events.js';

export const PERIOD_COLUMNS = {
  ownerId: usagePeriods.ownerId,
  periodStart: usagePeriods.periodStart,
  periodEnd: usagePeriods.periodEnd,
  tier: usagePeriods.tier,
  includedWsec: usagePeriods.includedWsec,
  usedWsec: usagePeriods.usedWsec,
  creditMicrosUsed: usagePeriods.creditMicrosUsed,
  uncoveredMicros: usagePeriods.uncoveredMicros,
  alert50At: usagePeriods.alert50At,
  alert80At: usagePeriods.alert80At,
  alert100At: usagePeriods.alert100At,
  exhaustedAt: usagePeriods.exhaustedAt,
} as const;

export type PeriodRow = Pick<typeof usagePeriods.$inferSelect, keyof typeof PERIOD_COLUMNS>;

const db = () => getPoolDbClient();

/**
 * Create the period row on first use. No cron: the first charge or read of a
 * new period creates it. A tier change inside a period moves the included
 * amount to the new tier's; an upgrade between paid tiers adds only the
 * share of the extra hours left in the period (`includedAfterTierChange`).
 *
 * The common case (the row exists on this tier) is one read. A change is a
 * compare-and-set on the old tier, so two meters that see the change at once
 * add the prorated hours one time only.
 */
export async function ensurePeriod(ownerId: string, tier: PlanTier, period: UsagePeriod, now = new Date()): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await readPeriod(ownerId, period.start);
    if (!row) {
      await db()
        .insert(usagePeriods)
        .values({ ownerId, periodStart: period.start, periodEnd: period.end, tier, includedWsec: includedWeightedSeconds(tier) })
        .onConflictDoNothing({ target: [usagePeriods.ownerId, usagePeriods.periodStart] });
      continue;
    }
    if (row.tier === tier) return;
    const includedWsec = includedAfterTierChange({
      from: row.tier,
      to: tier,
      currentIncludedWsec: Number(row.includedWsec),
      period,
      now,
    });
    const moved = await db()
      .update(usagePeriods)
      .set({ tier, includedWsec, updatedAt: sql`now()` })
      .where(
        and(eq(usagePeriods.ownerId, ownerId), eq(usagePeriods.periodStart, period.start), eq(usagePeriods.tier, row.tier)),
      )
      .returning({ tier: usagePeriods.tier });
    if (moved.length) return;
  }
}

export function readPeriodQuery(ownerId: string, periodStart: Date) {
  return db()
    .select(PERIOD_COLUMNS)
    .from(usagePeriods)
    .where(and(eq(usagePeriods.ownerId, ownerId), eq(usagePeriods.periodStart, periodStart)))
    .limit(1);
}

export async function readPeriod(ownerId: string, periodStart: Date): Promise<PeriodRow | null> {
  const [row] = await readPeriodQuery(ownerId, periodStart);
  return row ?? null;
}

/** Atomic `used_wsec += delta`. Returns the totals after the add. */
export async function addUsage(
  ownerId: string,
  periodStart: Date,
  deltaWsec: number,
): Promise<{ usedWsec: number; includedWsec: number } | null> {
  const [row] = await db()
    .update(usagePeriods)
    .set({ usedWsec: sql`${usagePeriods.usedWsec} + ${deltaWsec}`, updatedAt: sql`now()` })
    .where(and(eq(usagePeriods.ownerId, ownerId), eq(usagePeriods.periodStart, periodStart)))
    .returning({ usedWsec: usagePeriods.usedWsec, includedWsec: usagePeriods.includedWsec });
  return row ? { usedWsec: Number(row.usedWsec), includedWsec: Number(row.includedWsec) } : null;
}

export async function addCreditUse(ownerId: string, periodStart: Date, burnedMicros: number, uncoveredMicros: number): Promise<void> {
  if (burnedMicros <= 0 && uncoveredMicros <= 0) return;
  await db()
    .update(usagePeriods)
    .set({
      creditMicrosUsed: sql`${usagePeriods.creditMicrosUsed} + ${burnedMicros}`,
      uncoveredMicros: sql`${usagePeriods.uncoveredMicros} + ${uncoveredMicros}`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(usagePeriods.ownerId, ownerId), eq(usagePeriods.periodStart, periodStart)));
}

const ALERT_COLUMN = {
  50: usagePeriods.alert50At,
  80: usagePeriods.alert80At,
  100: usagePeriods.alert100At,
} as const;

const ALERT_KEY = { 50: 'alert50At', 80: 'alert80At', 100: 'alert100At' } as const;

/** Stamp a threshold once. True only for the caller whose write landed. */
export async function stampAlert(ownerId: string, periodStart: Date, pct: UsageAlertThreshold, at: Date): Promise<boolean> {
  const rows = await db()
    .update(usagePeriods)
    .set({ [ALERT_KEY[pct]]: at })
    .where(and(eq(usagePeriods.ownerId, ownerId), eq(usagePeriods.periodStart, periodStart), isNull(ALERT_COLUMN[pct])))
    .returning({ ownerId: usagePeriods.ownerId });
  return rows.length > 0;
}

/** Stamp exhaustion once. True only for the caller whose write landed. */
export async function stampExhausted(ownerId: string, periodStart: Date, at: Date): Promise<boolean> {
  const rows = await db()
    .update(usagePeriods)
    .set({ exhaustedAt: at })
    .where(and(eq(usagePeriods.ownerId, ownerId), eq(usagePeriods.periodStart, periodStart), isNull(usagePeriods.exhaustedAt)))
    .returning({ ownerId: usagePeriods.ownerId });
  return rows.length > 0;
}

/**
 * Clear exhaustion on every period of the owner (credits arrived, or the tier
 * changed). A cleared row tells parked unattended runs to look again.
 */
export async function clearExhausted(ownerId: string): Promise<boolean> {
  const rows = await db()
    .update(usagePeriods)
    .set({ exhaustedAt: null })
    .where(and(eq(usagePeriods.ownerId, ownerId), isNotNull(usagePeriods.exhaustedAt)))
    .returning({ ownerId: usagePeriods.ownerId });
  if (rows.length > 0) domainEvents.emit('billing:budget_restored', { ownerId });
  return rows.length > 0;
}
