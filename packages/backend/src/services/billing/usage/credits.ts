import { randomUUID } from 'crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { creditExpiresAt, type CreditBurn, type CreditLot, type CreditLotSource, type Micros } from '@talyn/shared';
import { getPoolDbClient } from '../../../db/client.js';
import { creditLedger, creditLots } from '../../../db/schema.js';
import { domainEvents } from '../../events.js';
import { clearExhausted } from './periods.js';

export const LOT_COLUMNS = {
  id: creditLots.id,
  totalMicros: creditLots.totalMicros,
  remainingMicros: creditLots.remainingMicros,
  source: creditLots.source,
  purchasedAt: creditLots.purchasedAt,
  expiresAt: creditLots.expiresAt,
} as const;

export type LotRow = Pick<typeof creditLots.$inferSelect, keyof typeof LOT_COLUMNS>;

const db = () => getPoolDbClient();

export function toPublicLot(row: LotRow): CreditLot {
  return {
    id: row.id,
    totalMicros: Number(row.totalMicros),
    remainingMicros: Number(row.remainingMicros),
    source: row.source as CreditLotSource,
    purchasedAt: row.purchasedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** Live lots (credit left, not expired), in burn order. */
export function liveLotsQuery(ownerId: string, now: Date) {
  return db()
    .select(LOT_COLUMNS)
    .from(creditLots)
    .where(and(eq(creditLots.ownerId, ownerId), gt(creditLots.remainingMicros, 0), gt(creditLots.expiresAt, now)))
    .orderBy(asc(creditLots.expiresAt), asc(creditLots.id));
}

export async function liveLots(ownerId: string, now: Date): Promise<CreditLot[]> {
  return (await liveLotsQuery(ownerId, now)).map(toPublicLot);
}

export function creditBalanceQuery(ownerId: string, now: Date) {
  return db()
    .select({ micros: sql<string | number | null>`COALESCE(SUM(${creditLots.remainingMicros}), 0)` })
    .from(creditLots)
    .where(and(eq(creditLots.ownerId, ownerId), gt(creditLots.remainingMicros, 0), gt(creditLots.expiresAt, now)));
}

/** The live (unexpired) credit balance. */
export async function creditBalance(ownerId: string, now: Date): Promise<Micros> {
  const [row] = await creditBalanceQuery(ownerId, now);
  return Number(row?.micros ?? 0);
}

/**
 * The balance when the current credit draw started: the balance now plus the
 * credit burned since the latest of the period start, the latest credit
 * added, and the latest usage reset in this period. A top-up therefore starts
 * a new draw at the new, larger balance. Reads the ledger, so call it only
 * while the owner draws on credit.
 */
export async function creditDrawStartMicros(ownerId: string, periodStart: Date, balanceMicros: Micros): Promise<Micros> {
  const start = periodStart.toISOString();
  const result = await db().execute(sql`
    SELECT COALESCE(SUM(-delta_micros), 0) AS burned FROM credit_ledger
    WHERE owner_id = ${ownerId} AND reason = 'burn'
      AND created_at >= GREATEST(
        ${start}::timestamptz,
        (SELECT MAX(created_at) FROM credit_ledger WHERE owner_id = ${ownerId} AND delta_micros > 0),
        (SELECT MAX(created_at) FROM usage_resets
          WHERE owner_id = ${ownerId} AND period_start = ${start}::timestamptz AND refunded_at IS NULL)
      )
  `);
  const [row] = rowsOf<{ burned: string | number | null }>(result);
  return balanceMicros + Math.max(0, Number(row?.burned ?? 0));
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Take up to `wantMicros` from the owner's soonest-expiring live lot, in ONE
 * statement. The CTE's `FOR UPDATE` locks the lot for the statement only (no
 * transaction, no advisory lock), and re-reads it if a concurrent burn changed
 * it, so `before` is the value this statement decremented. Null when the
 * owner has no live lot, or a concurrent burn emptied the one picked.
 */
async function burnOneLot(ownerId: string, wantMicros: Micros, now: Date): Promise<{ lotId: string; micros: Micros } | null> {
  const result = await db().execute(sql`
    WITH target AS (
      SELECT id, remaining_micros FROM credit_lots
      WHERE owner_id = ${ownerId} AND remaining_micros > 0 AND expires_at > ${now.toISOString()}::timestamptz
      ORDER BY expires_at, id
      LIMIT 1
      FOR UPDATE
    )
    UPDATE credit_lots c
    SET remaining_micros = c.remaining_micros - LEAST(c.remaining_micros, ${wantMicros}::bigint)
    FROM target
    WHERE c.id = target.id
    RETURNING c.id AS id, target.remaining_micros AS before, c.remaining_micros AS after
  `);
  const [row] = rowsOf<{ id: string; before: string | number; after: string | number }>(result);
  if (!row) return null;
  const micros = Number(row.before) - Number(row.after);
  return micros > 0 ? { lotId: row.id, micros } : null;
}

/** A concurrent burn can empty the picked lot between pick and lock; this bounds the re-picks. */
const BURN_REPICKS = 5;

/**
 * Burn `amountMicros` from the owner's live lots, soonest expiry first (the
 * order `burnCreditLots` in shared defines). Writes one `burn` ledger row per
 * lot touched. Safe under concurrency: every take is an atomic decrement of
 * one locked row.
 */
export async function burnCredits(
  ownerId: string,
  amountMicros: Micros,
  now: Date,
  context: { intervalId?: string | null; periodStart?: Date | null } = {},
): Promise<CreditBurn> {
  const want = Math.max(0, Math.round(amountMicros));
  let left = want;
  let repicks = 0;
  const burns: CreditBurn['burns'] = [];
  while (left > 0) {
    const taken = await burnOneLot(ownerId, left, now);
    if (!taken) {
      if (repicks++ >= BURN_REPICKS || (await creditBalance(ownerId, now)) <= 0) break;
      continue;
    }
    burns.push(taken);
    left -= taken.micros;
  }
  if (burns.length > 0) {
    await db()
      .insert(creditLedger)
      .values(
        burns.map((b) => ({
          ownerId,
          lotId: b.lotId,
          deltaMicros: -b.micros,
          reason: 'burn',
          intervalId: context.intervalId ?? null,
          periodStart: context.periodStart ?? null,
        })),
      );
  }
  return { burns, burnedMicros: want - left, shortMicros: left };
}

export interface GrantCreditLotInput {
  ownerId: string;
  micros: Micros;
  source: CreditLotSource;
  /** Idempotency: a second grant with the same order id is a no-op. */
  polarOrderId?: string | null;
  /** Defaults to now. The lot expires `CREDIT_EXPIRY_MONTHS` later. */
  purchasedAt?: Date;
}

/**
 * Add a credit lot (a purchase, an auto top-up, an operator grant). Clears the
 * owner's exhaustion, so the next gate admits new boxes. Returns the lot id
 * and whether this call created it (false for a duplicate order id).
 */
export async function grantCreditLot(input: GrantCreditLotInput): Promise<{ lotId: string; created: boolean }> {
  const purchasedAt = input.purchasedAt ?? new Date();
  const micros = Math.max(0, Math.round(input.micros));
  const id = randomUUID();
  const inserted = await db()
    .insert(creditLots)
    .values({
      id,
      ownerId: input.ownerId,
      totalMicros: micros,
      remainingMicros: micros,
      source: input.source,
      polarOrderId: input.polarOrderId ?? null,
      purchasedAt,
      expiresAt: creditExpiresAt(purchasedAt),
    })
    .onConflictDoNothing({ target: creditLots.polarOrderId })
    .returning({ id: creditLots.id });
  if (inserted.length === 0) {
    const [existing] = await db()
      .select({ id: creditLots.id })
      .from(creditLots)
      .where(eq(creditLots.polarOrderId, input.polarOrderId ?? ''))
      .limit(1);
    return { lotId: existing?.id ?? id, created: false };
  }
  await db().insert(creditLedger).values({
    ownerId: input.ownerId,
    lotId: id,
    deltaMicros: micros,
    reason: input.source === 'refund_reversal' ? 'refund' : input.source,
  });
  // Credits can arrive before exhaustion was ever stamped (a gate refused on
  // its own reading), so the budget is announced even when nothing cleared.
  if (!(await clearExhausted(input.ownerId))) domainEvents.emit('billing:budget_restored', { ownerId: input.ownerId });
  return { lotId: id, created: true };
}

/**
 * Take back what is left of the lot an order bought (a refund). Returns the
 * micro-dollars reversed; 0 when the order granted nothing or is spent.
 */
export async function reverseCreditLot(polarOrderId: string): Promise<Micros> {
  const result = await db().execute(sql`
    WITH target AS (
      SELECT id, owner_id, remaining_micros FROM credit_lots
      WHERE polar_order_id = ${polarOrderId} AND remaining_micros > 0
      FOR UPDATE
    )
    UPDATE credit_lots c SET remaining_micros = 0
    FROM target WHERE c.id = target.id
    RETURNING c.id AS id, target.owner_id AS owner_id, target.remaining_micros AS before
  `);
  const [row] = rowsOf<{ id: string; owner_id: string; before: string | number }>(result);
  if (!row) return 0;
  const micros = Number(row.before);
  await db().insert(creditLedger).values({ ownerId: row.owner_id, lotId: row.id, deltaMicros: -micros, reason: 'refund' });
  return micros;
}

/**
 * Zero lots past their expiry and write an `expire` ledger row for each. The
 * budget already ignores an expired lot; this keeps the ledger and the live
 * index honest. Idempotent; the meter runs it once a day.
 */
export async function expireCreditLots(now: Date): Promise<number> {
  const result = await db().execute(sql`
    WITH target AS (
      SELECT id, owner_id, remaining_micros FROM credit_lots
      WHERE remaining_micros > 0 AND expires_at <= ${now.toISOString()}::timestamptz
      FOR UPDATE SKIP LOCKED
    )
    UPDATE credit_lots c SET remaining_micros = 0
    FROM target WHERE c.id = target.id
    RETURNING c.id AS id, target.owner_id AS owner_id, target.remaining_micros AS before
  `);
  const rows = rowsOf<{ id: string; owner_id: string; before: string | number }>(result);
  if (rows.length === 0) return 0;
  await db()
    .insert(creditLedger)
    .values(rows.map((r) => ({ ownerId: r.owner_id, lotId: r.id, deltaMicros: -Number(r.before), reason: 'expire' })));
  return rows.length;
}
