import { randomUUID } from 'crypto';
import { and, count, eq, sql } from 'drizzle-orm';
import {
  includedWeightedSeconds,
  isUsageResetTier,
  usagePeriodFor,
  usageResetPriceMicros,
  type PlanTier,
  type UsageResetOffer,
  type UsageResetTier,
} from '@talyn/shared';
import { getPoolDbClient } from '../../../db/client.js';
import { usageResets } from '../../../db/schema.js';
import { domainEvents } from '../../events.js';
import { isFeatureEnabled, type FlagSubject } from '../../featureFlags.js';
import { billingEnabled } from '../entitlements.js';
import { usageResetProductId } from '../polar.js';
import { chargeOwnerAt } from './charge.js';
import { clearExhausted, ensurePeriod } from './periods.js';
import { resolveUsageTier } from './tier.js';

const db = () => getPoolDbClient();

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}

export interface ApplyUsageResetInput {
  ownerId: string;
  /** Idempotency: a second reset with the same order id is a no-op. */
  polarOrderId: string;
  /** The tier the order paid a reset for. Its full allowance is what the period gets. */
  tier: UsageResetTier;
  now?: Date;
}

export interface ApplyUsageResetResult {
  /** False for a duplicate order id, or an order that a refund overtook. */
  applied: boolean;
  periodStart?: Date;
  usedBeforeWsec?: number;
  includedWsec?: number;
}

/**
 * Apply one paid usage reset to the owner's CURRENT period.
 *
 * First the owner is charged up to now, so seconds that ran before the reset
 * are counted before it. Then ONE statement locks the period row, moves
 * `used_wsec` into `reset_used_wsec`, sets `included_wsec` to the paid tier's
 * full allowance, clears the alert stamps, and records the order. Because it
 * is one statement, a crash cannot leave a recorded order with no reset, or a
 * reset with no record. The order-id check and the unique index stop a second
 * reset for the same order.
 */
export async function applyUsageReset(input: ApplyUsageResetInput): Promise<ApplyUsageResetResult> {
  const now = input.now ?? new Date();
  await chargeOwnerAt(input.ownerId, now);
  const { tier, periodAnchor } = await resolveUsageTier(input.ownerId);
  const period = usagePeriodFor({ now, anchor: periodAnchor });
  await ensurePeriod(input.ownerId, tier, period, now);
  const includedWsec = includedWeightedSeconds(input.tier);
  const periodStart = period.start.toISOString();

  const result = await db().execute(sql`
    WITH target AS (
      SELECT owner_id, period_start, used_wsec FROM usage_periods
      WHERE owner_id = ${input.ownerId} AND period_start = ${periodStart}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM usage_resets WHERE polar_order_id = ${input.polarOrderId})
      FOR UPDATE
    ), moved AS (
      UPDATE usage_periods p
      SET reset_used_wsec = p.reset_used_wsec + p.used_wsec,
          used_wsec = 0,
          included_wsec = ${includedWsec}::bigint,
          alert_50_at = NULL,
          alert_80_at = NULL,
          alert_100_at = NULL,
          updated_at = now()
      FROM target
      WHERE p.owner_id = target.owner_id AND p.period_start = target.period_start
      RETURNING target.used_wsec AS before
    ), recorded AS (
      INSERT INTO usage_resets (id, owner_id, polar_order_id, tier, period_start, used_before_wsec, included_wsec)
      SELECT ${randomUUID()}, ${input.ownerId}, ${input.polarOrderId}, ${input.tier},
        ${periodStart}::timestamptz, moved.before, ${includedWsec}::bigint
      FROM moved
      RETURNING id
    )
    SELECT moved.before AS before FROM moved, recorded
  `);
  const [row] = rowsOf<{ before: string | number }>(result);
  if (!row) return { applied: false };

  // A reset always restores the budget, so the announcement goes out even
  // when no exhaustion stamp was there to clear.
  if (!(await clearExhausted(input.ownerId))) domainEvents.emit('billing:budget_restored', { ownerId: input.ownerId });
  return { applied: true, periodStart: period.start, usedBeforeWsec: Number(row.before), includedWsec };
}

/**
 * Record a refunded reset order. The reset itself stays: the hours may be
 * spent, so what to take back is an operator's judgement. When the refund
 * arrives before `order.paid`, the row it writes makes that late
 * `order.paid` a no-op. Returns true when a reset had been applied.
 */
export async function markUsageResetRefunded(input: {
  ownerId: string;
  polarOrderId: string;
  tier: UsageResetTier;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const [row] = await db()
    .insert(usageResets)
    .values({ id: randomUUID(), ownerId: input.ownerId, polarOrderId: input.polarOrderId, tier: input.tier, refundedAt: now })
    .onConflictDoUpdate({ target: usageResets.polarOrderId, set: { refundedAt: now } })
    .returning({ periodStart: usageResets.periodStart });
  return Boolean(row?.periodStart);
}

/** Resets applied to one period of the owner. */
export function usageResetCountQuery(ownerId: string, periodStart: Date) {
  return db()
    .select({ n: count() })
    .from(usageResets)
    .where(and(eq(usageResets.ownerId, ownerId), eq(usageResets.periodStart, periodStart)));
}

export async function countUsageResets(ownerId: string, periodStart: Date): Promise<number> {
  const [row] = await usageResetCountQuery(ownerId, periodStart);
  return Number(row?.n ?? 0);
}

export type UsageResetRefusal = 'not_enabled' | 'paid_plan_required' | 'nothing_used';

/**
 * Whether the owner can buy a usage reset now, and what it gives. The billing
 * status draws the offer from this and the checkout route enforces it, so the
 * two cannot disagree. The flag is read last: it is the only remote call.
 */
export async function usageResetAvailability(input: {
  subject: FlagSubject;
  tier: PlanTier;
  usedWsec: number;
}): Promise<{ ok: true; offer: UsageResetOffer } | { ok: false; reason: UsageResetRefusal }> {
  if (!billingEnabled()) return { ok: false, reason: 'not_enabled' };
  if (!isUsageResetTier(input.tier)) return { ok: false, reason: 'paid_plan_required' };
  if (!usageResetProductId(input.tier)) return { ok: false, reason: 'not_enabled' };
  if (!(await isFeatureEnabled('usageReset', input.subject))) return { ok: false, reason: 'not_enabled' };
  if (input.usedWsec <= 0) return { ok: false, reason: 'nothing_used' };
  const tier = input.tier;
  return { ok: true, offer: { tier, priceMicros: usageResetPriceMicros(tier), includedWsec: includedWeightedSeconds(tier) } };
}
