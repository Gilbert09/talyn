import { Router, type Response } from 'express';
import { and, desc, eq, gt, gte, isNull, lt, or, sql } from 'drizzle-orm';
import {
  creditBalanceMicros,
  expiringSoonMicros,
  isCreditPackId,
  isSellableTier,
  isTierUpgrade,
  PLAN_LIMITS,
  PLAN_TIER_LABELS,
  tierSoldAnnually,
  validateAutoTopupConfig,
  type ApiResponse,
  type AutoTopupSettings,
  type BillingOrder,
  type BillingStatus,
  type BillingUsageResponse,
  type ChangePlanRequest,
  type CheckoutSessionResponse,
  type CreateCheckoutRequest,
  type CreditCheckoutRequest,
  type CreditSummary,
  type SandboxSize,
  type SellableTier,
  type UpdateAutoTopupRequest,
  type UsageDay,
  type UsageIntervalPublic,
  type UsageSubjectKind,
} from '@talyn/shared';
import { getPoolDbClient } from '../db/client.js';
import { usageIntervals, users as usersTable } from '../db/schema.js';
import { assertUser } from '../middleware/auth.js';
import { readAutoTopupSettings, saveAutoTopupSettings } from '../services/billing/autoTopup.js';
import {
  billingEnabled,
  buildBillingStatus,
  maxPlanOffered,
  subscriptionPeriod,
  subscriptionTier,
} from '../services/billing/entitlements.js';
import {
  changeSubscriptionProduct,
  createCheckoutUrl,
  createCreditCheckoutUrl,
  createPortalUrl,
  getInvoiceUrlForUser,
  listOrdersForUser,
  OrderNotFoundError,
  planProductId,
} from '../services/billing/polar.js';
import { liveLots, resolveUsageTier } from '../services/billing/usage/index.js';
import { teamRoutes } from './teams.js';

/** 402 code when a plan that cannot hold credits asks for credits or auto top-up. */
export const CREDITS_REQUIRE_PAID_PLAN_CODE = 'credits_require_paid_plan';
/** 409 code on checkout when a granting subscription already exists: change it instead. */
export const ALREADY_SUBSCRIBED_CODE = 'already_subscribed';
/** 409 code on change-plan when there is no personal subscription to change. */
export const NO_SUBSCRIPTION_CODE = 'no_subscription';
/** 409 code on change-plan when Pro annual asks for monthly: the portal handles that. */
export const ANNUAL_TO_MONTHLY_CODE = 'annual_to_monthly_via_portal';
/**
 * 409 code on change-plan when the move is not an upgrade (Max → Pro). It goes
 * through the portal, which follows the org's default proration (`prorate`:
 * the change applies at once and the unused part is credited on the next
 * invoice). Tom accepted the abuse this allows (2026-11-09): use the Max hours,
 * then downgrade for the credit. It is bounded by the box concurrency cap and
 * by the prorated hours a mid-period upgrade gets.
 */
export const DOWNGRADE_VIA_PORTAL_CODE = 'downgrade_via_portal';
/** 403 code when this deployment does not sell Max (the Max product is unset). */
export const MAX_PLAN_UNAVAILABLE_CODE = 'max_plan_unavailable';
/** 400 code when a plan sold monthly only (Max) is asked for annually. */
export const MONTHLY_ONLY_CODE = 'monthly_only';

function monthlyOnly(res: Response, plan: SellableTier) {
  return res.status(400).json({
    success: false,
    code: MONTHLY_ONLY_CODE,
    error: `${PLAN_TIER_LABELS[plan]} is sold monthly only.`,
  });
}

/** Subscription statuses that keep paid access (the webhook's GRANTING_STATUSES). */
const GRANTING_STATUSES = new Set(['active', 'trialing', 'past_due']);

const DAY_MS = 86_400_000;
/** Default window of `GET /billing/usage`. */
const DEFAULT_USAGE_DAYS = 30;
/**
 * Longest window one usage request may cover. `days` is zero-filled, one entry
 * per day, so the bound is on the response; a year is the longest anything in
 * billing lives (a credit lot expires after twelve months).
 */
const MAX_USAGE_DAYS = 366;
/**
 * The interval list is the page's "recent boxes" table, newest first. The
 * `days` series carries the totals of the whole window, so no usage is lost
 * from the sums when a busy window has more intervals than this.
 */
const MAX_USAGE_INTERVALS = 200;

function notConfigured(res: Response) {
  return res.status(400).json({ success: false, error: 'Billing is not configured on this backend' });
}

function isPeriod(value: unknown): value is 'monthly' | 'annual' {
  return value === 'monthly' || value === 'annual';
}

/** The caller's personal subscription columns. Pool read, hard-scoped to the id. */
function subscriptionQuery(userId: string) {
  return getPoolDbClient()
    .select({
      plan: usersTable.plan,
      polarSubscriptionId: usersTable.polarSubscriptionId,
      subscriptionStatus: usersTable.subscriptionStatus,
      polarProductId: usersTable.polarProductId,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
}

type SubscriptionRow = Awaited<ReturnType<typeof subscriptionQuery>>[number];

function hasGrantingSubscription(row: SubscriptionRow | undefined): row is SubscriptionRow & { polarSubscriptionId: string } {
  return Boolean(
    row?.polarSubscriptionId && row.plan === 'unlimited' && GRANTING_STATUSES.has(row.subscriptionStatus ?? '')
  );
}

/** Intervals that overlap `[from, to)`, newest first. No large column. */
export function usageIntervalsReportQuery(ownerId: string, from: Date, to: Date) {
  return getPoolDbClient()
    .select({
      id: usageIntervals.id,
      subjectKind: usageIntervals.subjectKind,
      subjectId: usageIntervals.subjectId,
      workspaceId: usageIntervals.workspaceId,
      size: usageIntervals.size,
      startedAt: usageIntervals.startedAt,
      endedAt: usageIntervals.endedAt,
      billedWsec: usageIntervals.billedWsec,
    })
    .from(usageIntervals)
    .where(
      and(
        eq(usageIntervals.ownerId, ownerId),
        lt(usageIntervals.startedAt, to),
        or(isNull(usageIntervals.endedAt), gt(usageIntervals.endedAt, from))
      )
    )
    .orderBy(desc(usageIntervals.startedAt))
    .limit(MAX_USAGE_INTERVALS);
}

const usageDay = sql<string>`to_char(${usageIntervals.startedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

/**
 * Weighted seconds billed per UTC day and subject kind. An interval counts on
 * the day it STARTED: the ledger keeps one running total per interval, not a
 * per-day split, and a box rarely runs across midnight for long.
 */
export function usageDaysQuery(ownerId: string, from: Date, to: Date) {
  return getPoolDbClient()
    .select({
      date: usageDay,
      kind: usageIntervals.subjectKind,
      wsec: sql<string | number>`COALESCE(SUM(${usageIntervals.billedWsec}), 0)`,
    })
    .from(usageIntervals)
    .where(and(eq(usageIntervals.ownerId, ownerId), gte(usageIntervals.startedAt, from), lt(usageIntervals.startedAt, to)))
    .groupBy(usageDay, usageIntervals.subjectKind);
}

/** Pure: zero-filled UTC days of `[from, to)` with the grouped rows folded in. */
export function buildUsageDays(
  rows: ReadonlyArray<{ date: string; kind: string; wsec: string | number }>,
  from: Date,
  to: Date
): UsageDay[] {
  const days = new Map<string, UsageDay>();
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  for (let t = start; t < to.getTime(); t += DAY_MS) {
    const date = new Date(t).toISOString().slice(0, 10);
    days.set(date, { date, wsec: 0, byKind: {} });
  }
  for (const row of rows) {
    const day = days.get(row.date);
    if (!day) continue;
    const wsec = Number(row.wsec);
    day.wsec += wsec;
    const kind = row.kind as UsageSubjectKind;
    day.byKind[kind] = (day.byKind[kind] ?? 0) + wsec;
  }
  return [...days.values()];
}

/** Pure: the `[from, to)` window of a usage request, or the problem with it. */
export function parseUsageRange(
  query: { from?: unknown; to?: unknown },
  now: Date
): { from: Date; to: Date } | { error: string } {
  const parse = (value: unknown): Date | null | undefined => {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const to = parse(query.to);
  const from = parse(query.from);
  if (to === null || from === null) return { error: 'from and to must be ISO dates.' };
  const end = to ?? now;
  const start = from ?? new Date(end.getTime() - DEFAULT_USAGE_DAYS * DAY_MS);
  if (start.getTime() >= end.getTime()) return { error: 'from must be before to.' };
  if (end.getTime() - start.getTime() > MAX_USAGE_DAYS * DAY_MS) {
    return { error: `A usage request covers at most ${MAX_USAGE_DAYS} days. Ask for the rest in a second request.` };
  }
  return { from: start, to: end };
}

/**
 * Billing surface for the calling user. Mounted BEFORE the owner-scope
 * middleware (like /users): checkout/portal calls block on Polar's API, and
 * holding an owner-scoped transaction (= one pooled connection) open across
 * an external HTTP round-trip would drain the pool. Every query is
 * hard-scoped to req.user.id instead: no route reads an owner or user id from
 * the request.
 */
export function billingRoutes(): Router {
  const router = Router();

  router.use('/team', teamRoutes());

  // Current plan + usage. Also the desktop's post-checkout poll target.
  router.get('/status', async (req, res) => {
    const status = await buildBillingStatus(assertUser(req).id);
    res.json({ success: true, data: status } as ApiResponse<BillingStatus>);
  });

  // Create a hosted-checkout session for Pro or Max; the desktop opens the
  // URL in the system browser. Completion arrives via webhook → WS, not this
  // response. A live subscription is CHANGED (POST /change-plan), never
  // bought twice.
  router.post('/checkout', async (req, res) => {
    if (!billingEnabled()) return notConfigured(res);
    const body = (req.body ?? {}) as Partial<CreateCheckoutRequest>;
    if (body.plan !== undefined && !isSellableTier(body.plan)) {
      return res.status(400).json({ success: false, error: "plan must be 'pro' or 'max'." });
    }
    const plan = body.plan ?? 'pro';
    if (plan === 'max' && !maxPlanOffered()) {
      return res.status(403).json({ success: false, code: MAX_PLAN_UNAVAILABLE_CODE, error: 'The Max plan is not available.' });
    }
    const userId = assertUser(req).id;
    const [row] = await subscriptionQuery(userId);
    if (hasGrantingSubscription(row)) {
      return res.status(409).json({
        success: false,
        code: ALREADY_SUBSCRIBED_CODE,
        error: 'You already have a subscription. Change its plan instead of buying a second one.',
      });
    }
    // Annual is the default where a plan has it; monthly is the opt-out.
    // A monthly-only plan (Max) defaults to monthly and refuses annual.
    if (body.period === 'annual' && !tierSoldAnnually(plan)) return monthlyOnly(res, plan);
    const period = body.period === 'monthly' || !tierSoldAnnually(plan) ? 'monthly' : 'annual';
    const url = await createCheckoutUrl(userId, period, plan);
    res.json({ success: true, data: { url } } as ApiResponse<CheckoutSessionResponse>);
  });

  // An upgrade on the live subscription (Legacy Pro → Pro, Legacy Pro or Pro
  // monthly → Max, or Pro monthly → annual), prorated and invoiced now. Max
  // is monthly only, so Pro annual → Max is annual → monthly: the portal. The
  // `subscription.updated` webhook writes the new product and the tier follows.
  router.post('/change-plan', async (req, res) => {
    if (!billingEnabled()) return notConfigured(res);
    const body = (req.body ?? {}) as Partial<ChangePlanRequest>;
    if (!isSellableTier(body.to) || !isPeriod(body.period)) {
      return res.status(400).json({ success: false, error: "Send { to: 'pro' | 'max', period: 'monthly' | 'annual' }." });
    }
    const to = body.to;
    if (body.period === 'annual' && !tierSoldAnnually(to)) return monthlyOnly(res, to);
    if (to === 'max' && !maxPlanOffered()) {
      return res.status(403).json({ success: false, code: MAX_PLAN_UNAVAILABLE_CODE, error: 'The Max plan is not available.' });
    }
    const userId = assertUser(req).id;
    const [row] = await subscriptionQuery(userId);
    if (!hasGrantingSubscription(row)) {
      return res.status(409).json({
        success: false,
        code: NO_SUBSCRIPTION_CODE,
        error: `There is no subscription to change. Start ${PLAN_TIER_LABELS[to]} from checkout.`,
      });
    }
    const productId = planProductId(to, body.period);
    if (!productId) return notConfigured(res);
    if (row.polarProductId === productId) {
      return res.json({ success: true, data: { ok: true } } as ApiResponse<{ ok: true }>);
    }
    // The tier the subscription itself grants. A comp or a team seat on top
    // does not change what the subscription is being moved from.
    const currentTier = subscriptionTier(row.polarProductId);
    if (currentTier !== to && !isTierUpgrade(currentTier, to)) {
      return res.status(409).json({
        success: false,
        code: DOWNGRADE_VIA_PORTAL_CODE,
        error: `Move from ${PLAN_TIER_LABELS[currentTier]} to ${PLAN_TIER_LABELS[to]} in the billing portal.`,
      });
    }
    const fromPaidAnnual = subscriptionPeriod(row.polarProductId) === 'annual' && currentTier !== 'legacy_pro';
    if (body.period === 'monthly' && fromPaidAnnual) {
      return res.status(409).json({
        success: false,
        code: ANNUAL_TO_MONTHLY_CODE,
        error: 'Switch from annual to monthly in the billing portal.',
      });
    }
    try {
      await changeSubscriptionProduct(row.polarSubscriptionId, productId);
    } catch (err) {
      console.error(`[billing] plan change for ${userId} failed:`, err);
      return res.status(502).json({ success: false, error: 'The plan change failed. Nothing was charged. Try again in a moment.' });
    }
    res.json({ success: true, data: { ok: true } } as ApiResponse<{ ok: true }>);
  });

  // Box-hours by day and the recent intervals behind them.
  router.get('/usage', async (req, res) => {
    const range = parseUsageRange(req.query as { from?: unknown; to?: unknown }, new Date());
    if ('error' in range) return res.status(400).json({ success: false, error: range.error });
    const userId = assertUser(req).id;
    const [dayRows, intervalRows] = await Promise.all([
      usageDaysQuery(userId, range.from, range.to),
      usageIntervalsReportQuery(userId, range.from, range.to),
    ]);
    const intervals: UsageIntervalPublic[] = intervalRows.map((row) => ({
      id: row.id,
      subjectKind: row.subjectKind as UsageSubjectKind,
      subjectId: row.subjectId,
      workspaceId: row.workspaceId,
      size: row.size as SandboxSize,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
      wsec: Number(row.billedWsec),
    }));
    const data: BillingUsageResponse = { days: buildUsageDays(dayRows, range.from, range.to), intervals };
    res.json({ success: true, data } as ApiResponse<BillingUsageResponse>);
  });

  // Live credit lots, the balance and what expires soon. Any tier may read
  // it: credits bought on Pro stay readable after a downgrade.
  router.get('/credits', async (req, res) => {
    const now = new Date();
    const lots = await liveLots(assertUser(req).id, now);
    const data: CreditSummary = {
      balanceMicros: creditBalanceMicros(lots, now),
      expiringSoonMicros: expiringSoonMicros(lots, now),
      lots,
    };
    res.json({ success: true, data } as ApiResponse<CreditSummary>);
  });

  // Hosted checkout for one credit pack. `order.paid` grants the credits.
  router.post('/credits/checkout', async (req, res) => {
    if (!billingEnabled()) return notConfigured(res);
    const body = (req.body ?? {}) as Partial<CreditCheckoutRequest>;
    if (!isCreditPackId(body.pack)) {
      return res.status(400).json({ success: false, error: 'pack must be one of 25, 100, 500.' });
    }
    const userId = assertUser(req).id;
    const { tier } = await resolveUsageTier(userId);
    if (!PLAN_LIMITS[tier].creditsAllowed) {
      return res.status(402).json({
        success: false,
        code: CREDITS_REQUIRE_PAID_PLAN_CODE,
        error: 'Credits come with Pro. Upgrade to buy credits.',
      });
    }
    const url = await createCreditCheckoutUrl(userId, body.pack);
    res.json({ success: true, data: { url } } as ApiResponse<CheckoutSessionResponse>);
  });

  router.get('/auto-topup', async (req, res) => {
    const data = await readAutoTopupSettings(assertUser(req).id);
    res.json({ success: true, data } as ApiResponse<AutoTopupSettings>);
  });

  // Save the settings. Saving also clears a recorded charge failure: it is
  // the "try again" after fixing a payment method.
  router.put('/auto-topup', async (req, res) => {
    if (!billingEnabled()) return notConfigured(res);
    const problems = validateAutoTopupConfig(req.body);
    if (problems.length > 0) return res.status(400).json({ success: false, error: problems.join(' ') });
    const body = req.body as UpdateAutoTopupRequest;
    const userId = assertUser(req).id;
    if (body.enabled) {
      const { tier } = await resolveUsageTier(userId);
      if (!PLAN_LIMITS[tier].creditsAllowed) {
        return res.status(402).json({
          success: false,
          code: CREDITS_REQUIRE_PAID_PLAN_CODE,
          error: 'Auto top-up comes with Pro. Upgrade to turn it on.',
        });
      }
    }
    const data = await saveAutoTopupSettings(userId, {
      enabled: body.enabled,
      triggerMicros: body.triggerMicros,
      pack: body.pack,
      monthlyLimitMicros: body.monthlyLimitMicros,
    });
    res.json({ success: true, data } as ApiResponse<AutoTopupSettings>);
  });

  // Past orders, newest first. Empty when billing is off or the user never
  // checked out — the desktop hides the section on [].
  router.get('/orders', async (req, res) => {
    if (!billingEnabled()) {
      return res.json({ success: true, data: [] } as ApiResponse<BillingOrder[]>);
    }
    const orders = await listOrdersForUser(assertUser(req).id);
    res.json({ success: true, data: orders } as ApiResponse<BillingOrder[]>);
  });

  // Hosted invoice URL for one of the caller's orders (generated lazily).
  router.post('/orders/:id/invoice', async (req, res) => {
    if (!billingEnabled()) return notConfigured(res);
    try {
      const url = await getInvoiceUrlForUser(assertUser(req).id, req.params.id);
      res.json({ success: true, data: { url } } as ApiResponse<CheckoutSessionResponse>);
    } catch (err) {
      if (err instanceof OrderNotFoundError) {
        return res.status(404).json({ success: false, error: 'Order not found' });
      }
      throw err;
    }
  });

  // Authenticated customer-portal session (manage / cancel / invoices).
  router.post('/portal', async (req, res) => {
    if (!billingEnabled()) return notConfigured(res);
    try {
      const url = await createPortalUrl(assertUser(req).id);
      res.json({ success: true, data: { url } } as ApiResponse<CheckoutSessionResponse>);
    } catch {
      // Polar has no customer for this user (never checked out) — nothing to
      // manage yet.
      res.status(400).json({
        success: false,
        error: 'No billing profile yet — subscribe first to manage your plan here.',
      });
    }
  });

  return router;
}

