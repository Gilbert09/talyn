import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Router } from 'express';
import {
  MICROS_PER_CENT,
  MICROS_PER_DOLLAR,
  usagePeriodFor,
  type AdminBillingBox,
  type AdminBillingInterval,
  type AdminBillingLot,
  type AdminBillingView,
  type AdminGrantCreditsResult,
  type AdminReverseLotResult,
  type AdminUsageSummary,
  type ApiResponse,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { autoTopupSettings, creditLots, usageIntervals, usagePeriods } from '../../db/schema.js';
import { auditActor, withRemoteAudit } from '../../services/admin/audit.js';
import { getAdminUserEmail } from '../../services/admin/queries.js';
import { deriveTier } from '../../services/billing/entitlements.js';
import { creditBalance, grantCreditLot, reverseCreditLot } from '../../services/billing/usage/index.js';
import { LOT_COLUMNS } from '../../services/billing/usage/credits.js';
import { PERIOD_COLUMNS } from '../../services/billing/usage/periods.js';
import { AdminGuardError, adminMutationLimit, adminReason, notSelf, requireReason, withGuards } from './guards.js';

/**
 * Usage billing on the operator console: read one account's meter, grant
 * credits, reverse a lot.
 *
 * Reads never write. The ledger's own `getBudget` charges the owner and
 * creates the period row, which is right for a gate and wrong for a page an
 * operator opens to look. So the view reads the period row as it stands.
 *
 * Every read is an explicit projection with a bound. The tables are small per
 * row but `usage_intervals` grows without limit, so the interval lists are
 * capped, and none of these queries selects `*`.
 */

/** Rows of recent history on the user page. A page to skim, not an export. */
export const RECENT_INTERVAL_LIMIT = 25;
/** Open boxes shown. An owner is capped far below this, so it only bounds a runaway. */
export const OPEN_BOX_LIMIT = 100;
/** Lots shown, newest first. */
export const LOT_LIMIT = 50;

/**
 * A grant above this is refused. It catches a typo of extra zeros and nothing
 * else: a larger grant is two requests, each with its own reason and audit row.
 */
export const MAX_GRANT_USD = 10_000;

export const OPEN_BOX_COLUMNS = {
  id: usageIntervals.id,
  subjectKind: usageIntervals.subjectKind,
  subjectId: usageIntervals.subjectId,
  sandboxId: usageIntervals.sandboxId,
  size: usageIntervals.size,
  startedAt: usageIntervals.startedAt,
} as const;

export const INTERVAL_VIEW_COLUMNS = {
  ...OPEN_BOX_COLUMNS,
  endedAt: usageIntervals.endedAt,
  endReason: usageIntervals.endReason,
  billedWsec: usageIntervals.billedWsec,
} as const;

export const TOPUP_VIEW_COLUMNS = {
  enabled: autoTopupSettings.enabled,
  triggerMicros: autoTopupSettings.triggerMicros,
  pack: autoTopupSettings.pack,
  monthlyLimitMicros: autoTopupSettings.monthlyLimitMicros,
  monthKey: autoTopupSettings.monthKey,
  monthSpentMicros: autoTopupSettings.monthSpentMicros,
  lastFailure: autoTopupSettings.lastFailure,
  lastFailureAt: autoTopupSettings.lastFailureAt,
} as const;

const db = () => getPoolDbClient();

export function openBoxesQuery(ownerId: string) {
  return db()
    .select(OPEN_BOX_COLUMNS)
    .from(usageIntervals)
    .where(and(eq(usageIntervals.ownerId, ownerId), isNull(usageIntervals.endedAt)))
    .orderBy(desc(usageIntervals.startedAt))
    .limit(OPEN_BOX_LIMIT);
}

export function recentIntervalsQuery(ownerId: string) {
  return db()
    .select(INTERVAL_VIEW_COLUMNS)
    .from(usageIntervals)
    .where(eq(usageIntervals.ownerId, ownerId))
    .orderBy(desc(usageIntervals.startedAt))
    .limit(RECENT_INTERVAL_LIMIT);
}

export function lotsQuery(ownerId: string) {
  return db()
    .select(LOT_COLUMNS)
    .from(creditLots)
    .where(eq(creditLots.ownerId, ownerId))
    .orderBy(desc(creditLots.purchasedAt), desc(creditLots.id))
    .limit(LOT_LIMIT);
}

export function autoTopupViewQuery(ownerId: string) {
  return db().select(TOPUP_VIEW_COLUMNS).from(autoTopupSettings).where(eq(autoTopupSettings.ownerId, ownerId)).limit(1);
}

export function periodViewQuery(ownerId: string, periodStart: Date) {
  return db()
    .select(PERIOD_COLUMNS)
    .from(usagePeriods)
    .where(and(eq(usagePeriods.ownerId, ownerId), eq(usagePeriods.periodStart, periodStart)))
    .limit(1);
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toBox(r: { id: string; subjectKind: string; subjectId: string; sandboxId: string; size: string; startedAt: Date }): AdminBillingBox {
  return {
    id: r.id,
    subjectKind: r.subjectKind,
    subjectId: r.subjectId,
    sandboxId: r.sandboxId,
    size: r.size,
    startedAt: r.startedAt.toISOString(),
  };
}

export async function buildAdminBillingView(ownerId: string, now = new Date()): Promise<AdminBillingView> {
  const { tier, source, periodAnchor } = await deriveTier(ownerId);
  const period = usagePeriodFor({ now, anchor: periodAnchor });
  const [periodRows, boxes, intervals, lots, balance, topupRows] = await Promise.all([
    periodViewQuery(ownerId, period.start),
    openBoxesQuery(ownerId),
    recentIntervalsQuery(ownerId),
    lotsQuery(ownerId),
    creditBalance(ownerId, now),
    autoTopupViewQuery(ownerId),
  ]);
  const p = periodRows[0];
  const t = topupRows[0];
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return {
    tier,
    source,
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    usage: p
      ? {
          tier: p.tier,
          includedWsec: Number(p.includedWsec),
          usedWsec: Number(p.usedWsec),
          creditMicrosUsed: Number(p.creditMicrosUsed),
          uncoveredMicros: Number(p.uncoveredMicros),
          exhaustedAt: iso(p.exhaustedAt),
        }
      : null,
    openBoxes: boxes.map(toBox),
    lots: lots.map(
      (l): AdminBillingLot => ({
        id: l.id,
        source: l.source,
        totalMicros: Number(l.totalMicros),
        remainingMicros: Number(l.remainingMicros),
        purchasedAt: l.purchasedAt.toISOString(),
        expiresAt: l.expiresAt.toISOString(),
        live: Number(l.remainingMicros) > 0 && l.expiresAt.getTime() > now.getTime(),
      })
    ),
    creditBalanceMicros: balance,
    autoTopup: t
      ? {
          enabled: t.enabled,
          triggerMicros: Number(t.triggerMicros),
          pack: t.pack,
          monthlyLimitMicros: Number(t.monthlyLimitMicros),
          monthSpentMicros: t.monthKey === monthKey ? Number(t.monthSpentMicros) : 0,
          lastFailure: t.lastFailure,
          lastFailureAt: iso(t.lastFailureAt),
        }
      : null,
    recentIntervals: intervals.map(
      (r): AdminBillingInterval => ({
        ...toBox(r),
        endedAt: iso(r.endedAt),
        endReason: r.endReason,
        billedWsec: Number(r.billedWsec),
      })
    ),
  };
}

/** The Ops tile: one statement, two small tables, both read through an index or a short scan. */
export function usageSummaryQuery(now: Date) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const at = now.toISOString();
  return db().execute(sql`
    SELECT
      (SELECT COALESCE(SUM(used_wsec), 0) FROM usage_periods
        WHERE period_start <= ${at}::timestamptz AND period_end > ${at}::timestamptz) AS period_wsec,
      (SELECT COUNT(*) FROM usage_periods
        WHERE period_start <= ${at}::timestamptz AND period_end > ${at}::timestamptz AND used_wsec > 0) AS owners_with_usage,
      (SELECT COUNT(*) FROM usage_periods
        WHERE period_start <= ${at}::timestamptz AND period_end > ${at}::timestamptz AND exhausted_at IS NOT NULL) AS owners_exhausted,
      (SELECT COALESCE(SUM(total_micros), 0) FROM credit_lots
        WHERE purchased_at >= ${monthStart}::timestamptz AND source IN ('purchase', 'auto_topup')) AS sold_micros,
      (SELECT COALESCE(SUM(total_micros), 0) FROM credit_lots
        WHERE purchased_at >= ${monthStart}::timestamptz AND source = 'grant') AS granted_micros
  `);
}

export async function buildUsageSummary(now = new Date()): Promise<AdminUsageSummary> {
  const result = (await usageSummaryQuery(now)) as unknown;
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  const r = (rows[0] ?? {}) as Record<string, string | number | null>;
  const n = (v: string | number | null | undefined) => Number(v ?? 0);
  return {
    periodBoxWsec: n(r.period_wsec),
    ownersWithUsage: n(r.owners_with_usage),
    ownersExhausted: n(r.owners_exhausted),
    creditsSoldMicros: n(r.sold_micros),
    creditsGrantedMicros: n(r.granted_micros),
  };
}

/** Whole US cents to micros, or a refusal. */
export function grantMicrosFromUsd(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new AdminGuardError(400, 'invalid_amount', 'amountUsd must be a positive number.');
  }
  const cents = Math.round(raw * 100);
  if (Math.abs(raw * 100 - cents) > 1e-6) {
    throw new AdminGuardError(400, 'invalid_amount', 'amountUsd must be a whole number of cents.');
  }
  if (raw > MAX_GRANT_USD) {
    throw new AdminGuardError(
      400,
      'invalid_amount',
      `A single grant is capped at $${MAX_GRANT_USD.toLocaleString('en-US')} to catch typos. Make two grants for more.`
    );
  }
  return cents * MICROS_PER_CENT;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

export function adminBillingRoutes(): Router {
  const router = Router();
  const limit = adminMutationLimit();

  router.get(
    '/users/:id/billing',
    withGuards(async (req, res) => {
      const email = await getAdminUserEmail(req.params.id);
      if (!email) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }
      const data = await buildAdminBillingView(req.params.id);
      res.json({ success: true, data } as ApiResponse<AdminBillingView>);
    })
  );

  router.get(
    '/billing/summary',
    withGuards(async (_req, res) => {
      res.json({ success: true, data: await buildUsageSummary() } as ApiResponse<AdminUsageSummary>);
    })
  );

  /**
   * Grant credits as a `grant` lot that expires in 12 months.
   *
   * The lot's `polar_order_id` is the idempotency key (`admin-grant:<owner>:<key>`),
   * so a retried request with the same key grants once. The audit row is written
   * `pending` first and settles after, because the ledger write is not part of
   * the audit transaction.
   */
  router.post(
    '/users/:id/billing/grant',
    limit,
    requireReason,
    withGuards(async (req, res) => {
      const body = req.body as { amountUsd?: unknown; idempotencyKey?: unknown };
      const micros = grantMicrosFromUsd(body.amountUsd);
      let key: string;
      if (body.idempotencyKey === undefined) {
        key = randomUUID();
      } else if (typeof body.idempotencyKey === 'string' && KEY_PATTERN.test(body.idempotencyKey)) {
        key = body.idempotencyKey;
      } else {
        throw new AdminGuardError(400, 'invalid_request', 'idempotencyKey must be 8 to 100 letters, digits, - or _.');
      }

      const email = await getAdminUserEmail(req.params.id);
      if (!email) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }
      notSelf(req, req.params.id);

      const result = await withRemoteAudit(
        auditActor(req),
        {
          action: 'billing.grant_credits',
          targetKind: 'user',
          targetId: req.params.id,
          reason: adminReason(req),
          params: { amountUsd: micros / MICROS_PER_DOLLAR, micros, idempotencyKey: key, email },
        },
        async () => {
          const { lotId, created } = await grantCreditLot({
            ownerId: req.params.id,
            micros,
            source: 'grant',
            polarOrderId: `admin-grant:${req.params.id}:${key}`,
          });
          return { lotId, created, micros } satisfies AdminGrantCreditsResult;
        }
      );
      res.json({ success: true, data: result } as ApiResponse<AdminGrantCreditsResult>);
    })
  );

  /** Zero what is left of one lot. The lot must belong to the account in the URL. */
  router.post(
    '/users/:id/billing/lots/:lotId/reverse',
    limit,
    requireReason,
    withGuards(async (req, res) => {
      const [lot] = await db()
        .select({
          id: creditLots.id,
          polarOrderId: creditLots.polarOrderId,
          remainingMicros: creditLots.remainingMicros,
        })
        .from(creditLots)
        .where(and(eq(creditLots.id, req.params.lotId), eq(creditLots.ownerId, req.params.id)))
        .limit(1);
      if (!lot) {
        res.status(404).json({ success: false, error: 'Credit lot not found for this account' });
        return;
      }
      if (!lot.polarOrderId) {
        throw new AdminGuardError(409, 'lot_not_reversible', 'This lot has no order id, so it cannot be reversed here.');
      }
      if (Number(lot.remainingMicros) <= 0) {
        throw new AdminGuardError(409, 'lot_empty', 'Nothing is left in this lot.');
      }
      const orderId = lot.polarOrderId;

      const result = await withRemoteAudit(
        auditActor(req),
        {
          action: 'billing.reverse_credit_lot',
          targetKind: 'user',
          targetId: req.params.id,
          reason: adminReason(req),
          params: { lotId: lot.id, remainingMicros: Number(lot.remainingMicros) },
        },
        async () => {
          const reversedMicros = await reverseCreditLot(orderId);
          return { lotId: lot.id, reversedMicros } satisfies AdminReverseLotResult;
        }
      );
      res.json({ success: true, data: result } as ApiResponse<AdminReverseLotResult>);
    })
  );

  return router;
}
