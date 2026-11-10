import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import type { AutoTopupSettings, BillingUsageResponse, CreditSummary } from '@talyn/shared';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { autoTopupSettings, creditLots, usageIntervals, users as usersTable } from '../../db/schema.js';

const polar = vi.hoisted(() => ({
  createCheckoutUrl: vi.fn(async (userId: string, period: string) => `https://polar.test/checkout/pro/${period}/${userId}`),
  createCreditCheckoutUrl: vi.fn(async (userId: string, pack: string) => `https://polar.test/checkout/credits/${pack}/${userId}`),
  changeSubscriptionProduct: vi.fn(async () => undefined),
}));
vi.mock('../../services/billing/polar.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/billing/polar.js')>();
  return { ...actual, ...polar };
});

const { billingRoutes, buildUsageDays, parseUsageRange, usageDaysQuery, usageIntervalsReportQuery } = await import(
  '../../routes/billing.js'
);
const { autoTopupSettingsQuery } = await import('../../services/billing/autoTopup.js');

const OTHER = 'user-other';
const headers = { ...internalProxyHeaders(TEST_USER_ID), 'content-type': 'application/json' };
const POLAR_ENV = {
  POLAR_ACCESS_TOKEN: 'polar-test-token',
  POLAR_WEBHOOK_SECRET: 'whsec_x',
  POLAR_ENVIRONMENT: 'sandbox',
  POLAR_PRODUCT_ID_PRO_MONTHLY: 'prod-pro-m',
  POLAR_PRODUCT_ID_PRO_ANNUAL: 'prod-pro-a',
  POLAR_PRODUCT_ID_CREDITS_25: 'prod-c25',
  POLAR_PRODUCT_ID_CREDITS_100: 'prod-c100',
  POLAR_PRODUCT_ID_CREDITS_500: 'prod-c500',
} as const;
const MAX_ENV = {
  POLAR_PRODUCT_ID_MAX_MONTHLY: 'prod-max-m',
} as const;
const ENV_KEYS = [...Object.keys(POLAR_ENV), ...Object.keys(MAX_ENV)];
const savedEnv: Record<string, string | undefined> = {};

let db: Database;
let cleanup: () => Promise<void>;
let url: string;
let close: () => Promise<void>;

function setPolarEnv() {
  for (const [k, v] of Object.entries(POLAR_ENV)) process.env[k] = v;
}

/** Billing plus the Max product. */
function setMaxEnv(overrides: Partial<Record<keyof typeof MAX_ENV, string>> = {}) {
  setPolarEnv();
  for (const [k, v] of Object.entries({ ...MAX_ENV, ...overrides })) {
    if (v) process.env[k] = v;
    else delete process.env[k];
  }
}

async function call(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = headers) {
  const res = await fetch(`${url}/billing${path}`, {
    method,
    headers: extraHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { data?: unknown } };
}

const setUser = (values: Partial<typeof usersTable.$inferInsert>, id = TEST_USER_ID) =>
  db.update(usersTable).set(values).where(eq(usersTable.id, id));

const subscribed = (productId: string | null = 'prod-legacy-m') =>
  setUser({ plan: 'unlimited', polarSubscriptionId: 'sub-1', subscriptionStatus: 'active', polarProductId: productId });

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  await seedUser(db);
  await seedUser(db, { id: OTHER });

  const app = express();
  app.use(express.json());
  app.use('/billing', requireAuth, wrapAsyncRoutes(billingRoutes()));
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise<void>((res) => {
      server.closeAllConnections();
      server.close(() => res());
    });
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const fn of Object.values(polar)) fn.mockClear();
  await close();
  await cleanup();
});

describe('auth', () => {
  it.each([
    ['GET', '/usage'],
    ['GET', '/credits'],
    ['POST', '/credits/checkout'],
    ['POST', '/change-plan'],
    ['GET', '/auto-topup'],
    ['PUT', '/auto-topup'],
  ])('%s %s needs a signed-in user', async (method, path) => {
    const res = await fetch(`${url}/billing${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'GET' ? {} : { body: '{}' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /billing/credits', () => {
  it("returns only the caller's live lots, balance and what expires soon", async () => {
    const now = Date.now();
    const lot = (id: string, ownerId: string, remaining: number, expiresInDays: number) =>
      db.insert(creditLots).values({
        id,
        ownerId,
        totalMicros: 25_000_000,
        remainingMicros: remaining,
        source: 'purchase',
        purchasedAt: new Date(now - 86_400_000),
        expiresAt: new Date(now + expiresInDays * 86_400_000),
      });
    await lot('mine-soon', TEST_USER_ID, 1_000_000, 10);
    await lot('mine-later', TEST_USER_ID, 20_000_000, 200);
    await lot('mine-spent', TEST_USER_ID, 0, 200);
    await lot('mine-expired', TEST_USER_ID, 5_000_000, -1);
    await lot('theirs', OTHER, 24_000_000, 200);

    const { status, body } = await call('GET', '/credits');
    expect(status).toBe(200);
    const data = body.data as CreditSummary;
    expect(data.balanceMicros).toBe(21_000_000);
    expect(data.expiringSoonMicros).toBe(1_000_000);
    expect(data.lots.map((l) => l.id)).toEqual(['mine-soon', 'mine-later']);
  });
});

describe('GET /billing/usage', () => {
  const interval = (id: string, ownerId: string, startedAt: string, wsec: number, kind = 'task', endedAt: string | null = null) =>
    db.insert(usageIntervals).values({
      id,
      ownerId,
      subjectKind: kind,
      subjectId: `s-${id}`,
      sandboxId: `sb-${id}`,
      size: 'standard',
      weight: '1.00',
      startedAt: new Date(startedAt),
      endedAt: endedAt ? new Date(endedAt) : null,
      endReason: endedAt ? 'terminal' : null,
      billedThrough: new Date(endedAt ?? startedAt),
      billedWsec: wsec,
    });

  it("zero-fills the days and lists the caller's intervals only, newest first", async () => {
    await interval('a', TEST_USER_ID, '2026-11-02T10:00:00Z', 3600, 'task', '2026-11-02T11:00:00Z');
    await interval('b', TEST_USER_ID, '2026-11-02T20:00:00Z', 1800, 'workbench', '2026-11-02T20:30:00Z');
    await interval('c', TEST_USER_ID, '2026-11-04T08:00:00Z', 900, 'review_unit');
    await interval('theirs', OTHER, '2026-11-03T08:00:00Z', 7200);
    await interval('before', TEST_USER_ID, '2026-10-20T08:00:00Z', 100, 'task', '2026-10-20T09:00:00Z');

    const { status, body } = await call('GET', '/usage?from=2026-11-01T00:00:00Z&to=2026-11-05T00:00:00Z');
    expect(status).toBe(200);
    const data = body.data as BillingUsageResponse;
    expect(data.days).toEqual([
      { date: '2026-11-01', wsec: 0, byKind: {} },
      { date: '2026-11-02', wsec: 5400, byKind: { task: 3600, workbench: 1800 } },
      { date: '2026-11-03', wsec: 0, byKind: {} },
      { date: '2026-11-04', wsec: 900, byKind: { review_unit: 900 } },
    ]);
    expect(data.intervals.map((i) => i.id)).toEqual(['c', 'b', 'a']);
    expect(data.intervals[0]).toMatchObject({ subjectKind: 'review_unit', endedAt: null, wsec: 900, size: 'standard' });
  });

  it('lists a box still running that started before the window', async () => {
    await interval('long', TEST_USER_ID, '2026-10-30T00:00:00Z', 7200);
    const { body } = await call('GET', '/usage?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z');
    expect((body.data as BillingUsageResponse).intervals.map((i) => i.id)).toEqual(['long']);
  });

  it.each([
    ['?from=yesterday', /ISO/],
    ['?from=2026-11-05T00:00:00Z&to=2026-11-01T00:00:00Z', /before/],
    ['?from=2025-01-01T00:00:00Z&to=2026-11-01T00:00:00Z', /at most 366 days/],
  ])('400 for %s', async (query, message) => {
    const { status, body } = await call('GET', `/usage${query}`);
    expect(status).toBe(400);
    expect(body.error).toMatch(message);
  });
});

describe('POST /billing/credits/checkout', () => {
  it('400 when billing is not configured', async () => {
    expect((await call('POST', '/credits/checkout', { pack: '25' })).status).toBe(400);
  });

  it.each([[{}], [{ pack: '50' }], [{ pack: 25 }]])('400 for a bad pack %j', async (body) => {
    setPolarEnv();
    await setUser({ planOverride: 'pro' });
    expect((await call('POST', '/credits/checkout', body)).status).toBe(400);
  });

  it('402 on the free plan', async () => {
    setPolarEnv();
    const { status, body } = await call('POST', '/credits/checkout', { pack: '25' });
    expect(status).toBe(402);
    expect(body.code).toBe('credits_require_paid_plan');
    expect(polar.createCreditCheckoutUrl).not.toHaveBeenCalled();
  });

  it.each(['pro', 'legacy_pro'])('returns the checkout for the caller on %s', async (override) => {
    setPolarEnv();
    await setUser({ planOverride: override });
    const { status, body } = await call('POST', '/credits/checkout', { pack: '100' });
    expect(status).toBe(200);
    expect(body.data).toEqual({ url: `https://polar.test/checkout/credits/100/${TEST_USER_ID}` });
    expect(polar.createCreditCheckoutUrl).toHaveBeenCalledWith(TEST_USER_ID, '100', null);
  });
});

describe('POST /billing/checkout', () => {
  it.each([
    [{}, 'annual'],
    [{ period: 'monthly' }, 'monthly'],
    [{ period: 'annual', plan: 'pro' }, 'annual'],
  ])('sells Pro: %j → %s', async (body, period) => {
    setPolarEnv();
    const res = await call('POST', '/checkout', body);
    expect(res.status).toBe(200);
    expect(polar.createCheckoutUrl).toHaveBeenCalledWith(TEST_USER_ID, period, 'pro', null);
  });

  it('passes an allowed mobile return target to the checkout', async () => {
    setPolarEnv();
    const res = await call('POST', '/checkout', { returnTo: 'talyn-mobile://' });
    expect(res.status).toBe(200);
    expect(polar.createCheckoutUrl).toHaveBeenCalledWith(TEST_USER_ID, 'annual', 'pro', 'talyn-mobile://');
  });

  it.each([['https://evil.test/'], ['talyn-mobile://x'], ['javascript:']])('400 for return target %s', async (returnTo) => {
    setPolarEnv();
    const { status, body } = await call('POST', '/checkout', { returnTo });
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_return_to');
    expect(polar.createCheckoutUrl).not.toHaveBeenCalled();
  });

  it.each([['unlimited'], ['legacy_pro'], ['free'], ['Max']])('400 for plan %s', async (plan) => {
    setMaxEnv();
    expect((await call('POST', '/checkout', { period: 'monthly', plan })).status).toBe(400);
  });

  it.each([
    ['monthly', 'monthly'],
    [undefined, 'monthly'],
  ])('sells Max (period %s → %s) when it is offered', async (period, expected) => {
    setMaxEnv();
    const res = await call('POST', '/checkout', { plan: 'max', ...(period ? { period } : {}) });
    expect(res.status).toBe(200);
    expect(polar.createCheckoutUrl).toHaveBeenCalledWith(TEST_USER_ID, expected, 'max', null);
  });

  it('403 for Max when the Max product is not set', async () => {
    setMaxEnv({ POLAR_PRODUCT_ID_MAX_MONTHLY: '' });
    const { status, body } = await call('POST', '/checkout', { period: 'monthly', plan: 'max' });
    expect(status).toBe(403);
    expect(body.code).toBe('max_plan_unavailable');
    expect(polar.createCheckoutUrl).not.toHaveBeenCalled();
  });

  it('400 for annual Max: it is sold monthly only', async () => {
    setMaxEnv();
    const { status, body } = await call('POST', '/checkout', { period: 'annual', plan: 'max' });
    expect(status).toBe(400);
    expect(body.code).toBe('monthly_only');
    expect(polar.createCheckoutUrl).not.toHaveBeenCalled();
  });

  it('an unset Max product never blocks Pro', async () => {
    setMaxEnv({ POLAR_PRODUCT_ID_MAX_MONTHLY: '' });
    expect((await call('POST', '/checkout', { period: 'monthly', plan: 'pro' })).status).toBe(200);
  });

  it('409 when a granting subscription exists: change it instead', async () => {
    setPolarEnv();
    await subscribed();
    const { status, body } = await call('POST', '/checkout', { period: 'monthly' });
    expect(status).toBe(409);
    expect(body.code).toBe('already_subscribed');
    expect(polar.createCheckoutUrl).not.toHaveBeenCalled();
  });

  it('a canceled subscription may buy again', async () => {
    setPolarEnv();
    await setUser({ plan: 'free', polarSubscriptionId: 'sub-1', subscriptionStatus: 'canceled' });
    expect((await call('POST', '/checkout', { period: 'monthly' })).status).toBe(200);
  });
});

describe('POST /billing/change-plan', () => {
  it('400 when billing is not configured', async () => {
    expect((await call('POST', '/change-plan', { to: 'pro', period: 'monthly' })).status).toBe(400);
  });

  it.each([[{}], [{ to: 'pro' }], [{ to: 'legacy_pro', period: 'monthly' }], [{ to: 'pro', period: 'weekly' }]])(
    '400 for %j',
    async (body) => {
      setPolarEnv();
      await subscribed();
      expect((await call('POST', '/change-plan', body)).status).toBe(400);
      expect(polar.changeSubscriptionProduct).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['no subscription', { plan: 'free' }],
    ['a canceled subscription', { plan: 'free', polarSubscriptionId: 'sub-1', subscriptionStatus: 'canceled' }],
  ])('409 with %s', async (_name, values) => {
    setPolarEnv();
    await setUser(values);
    const { status, body } = await call('POST', '/change-plan', { to: 'pro', period: 'monthly' });
    expect(status).toBe(409);
    expect(body.code).toBe('no_subscription');
  });

  it.each([
    ['monthly', 'prod-pro-m'],
    ['annual', 'prod-pro-a'],
  ])("moves the caller's subscription to Pro %s", async (period, productId) => {
    setPolarEnv();
    await subscribed('prod-legacy-m');
    await setUser({ polarSubscriptionId: 'sub-mine' });
    await setUser({ plan: 'unlimited', polarSubscriptionId: 'sub-theirs', subscriptionStatus: 'active' }, OTHER);
    const { status, body } = await call('POST', '/change-plan', { to: 'pro', period });
    expect(status).toBe(200);
    expect(body.data).toEqual({ ok: true });
    expect(polar.changeSubscriptionProduct).toHaveBeenCalledWith('sub-mine', productId);
  });

  it('already on that product: ok, no Polar call', async () => {
    setPolarEnv();
    await subscribed('prod-pro-a');
    expect((await call('POST', '/change-plan', { to: 'pro', period: 'annual' })).status).toBe(200);
    expect(polar.changeSubscriptionProduct).not.toHaveBeenCalled();
  });

  it('Pro monthly → annual calls Polar with the annual product', async () => {
    setPolarEnv();
    await subscribed('prod-pro-m');
    await setUser({ polarSubscriptionId: 'sub-mine' });
    const { status } = await call('POST', '/change-plan', { to: 'pro', period: 'annual' });
    expect(status).toBe(200);
    expect(polar.changeSubscriptionProduct).toHaveBeenCalledWith('sub-mine', 'prod-pro-a');
  });

  it('Pro annual → monthly is refused: the portal does that', async () => {
    setPolarEnv();
    await subscribed('prod-pro-a');
    const { status, body } = await call('POST', '/change-plan', { to: 'pro', period: 'monthly' });
    expect(status).toBe(409);
    expect(body.code).toBe('annual_to_monthly_via_portal');
    expect(polar.changeSubscriptionProduct).not.toHaveBeenCalled();
  });

  it.each([
    ['Pro monthly → Max', 'prod-pro-m', 'monthly', 'prod-max-m'],
    ['Legacy Pro → Max', 'prod-legacy-m', 'monthly', 'prod-max-m'],
  ])('upgrades %s', async (_name, from, period, productId) => {
    setMaxEnv();
    await subscribed(from);
    const { status } = await call('POST', '/change-plan', { to: 'max', period });
    expect(status).toBe(200);
    expect(polar.changeSubscriptionProduct).toHaveBeenCalledWith('sub-1', productId);
  });

  it.each([
    ['Max monthly → Pro monthly', 'prod-max-m', 'pro', 'monthly', 'downgrade_via_portal'],
    ['Max monthly → Pro annual', 'prod-max-m', 'pro', 'annual', 'downgrade_via_portal'],
    ['Pro annual → Max', 'prod-pro-a', 'max', 'monthly', 'annual_to_monthly_via_portal'],
  ])('refuses %s: the portal does that', async (_name, from, to, period, code) => {
    setMaxEnv();
    await subscribed(from);
    const { status, body } = await call('POST', '/change-plan', { to, period });
    expect(status).toBe(409);
    expect(body.code).toBe(code);
    expect(polar.changeSubscriptionProduct).not.toHaveBeenCalled();
  });

  it('400 for an annual Max upgrade: it is sold monthly only', async () => {
    setMaxEnv();
    await subscribed('prod-pro-m');
    const { status, body } = await call('POST', '/change-plan', { to: 'max', period: 'annual' });
    expect(status).toBe(400);
    expect(body.code).toBe('monthly_only');
    expect(polar.changeSubscriptionProduct).not.toHaveBeenCalled();
  });

  it('a Max subscriber moves to Pro in the portal', async () => {
    setMaxEnv();
    await subscribed('prod-max-m');
    const { status, body } = await call('POST', '/change-plan', { to: 'pro', period: 'monthly' });
    expect(status).toBe(409);
    expect(body.code).toBe('downgrade_via_portal');
  });

  it('403 for an upgrade to Max when the Max product is not set', async () => {
    setMaxEnv({ POLAR_PRODUCT_ID_MAX_MONTHLY: '' });
    await subscribed('prod-pro-m');
    const { status, body } = await call('POST', '/change-plan', { to: 'max', period: 'monthly' });
    expect(status).toBe(403);
    expect(body.code).toBe('max_plan_unavailable');
    expect(polar.changeSubscriptionProduct).not.toHaveBeenCalled();
  });

  it('502 when Polar refuses', async () => {
    setPolarEnv();
    await subscribed();
    polar.changeSubscriptionProduct.mockRejectedValueOnce(new Error('nope'));
    const { status, body } = await call('POST', '/change-plan', { to: 'pro', period: 'monthly' });
    expect(status).toBe(502);
    expect(body.error).toMatch(/Nothing was charged/);
  });
});

describe('/billing/auto-topup', () => {
  const valid = { enabled: true, triggerMicros: 5_000_000, pack: '25', monthlyLimitMicros: 100_000_000 };

  it('GET answers the defaults before anything is saved', async () => {
    const { status, body } = await call('GET', '/auto-topup');
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ enabled: false, pack: '25', monthSpentMicros: 0, lastFailure: null });
  });

  it('PUT 400 when billing is not configured', async () => {
    expect((await call('PUT', '/auto-topup', valid)).status).toBe(400);
  });

  it.each([
    [{ ...valid, pack: '30' }, /pack/],
    [{ ...valid, triggerMicros: -1 }, /triggerMicros/],
    [{ ...valid, monthlyLimitMicros: 10_000_000 }, /monthly limit/],
    [{ ...valid, enabled: 'yes' }, /enabled/],
  ])('PUT 400 for %j', async (body, message) => {
    setPolarEnv();
    await setUser({ planOverride: 'pro' });
    const res = await call('PUT', '/auto-topup', body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
  });

  it('PUT 402 when a free plan turns it on; turning it off is allowed', async () => {
    setPolarEnv();
    const on = await call('PUT', '/auto-topup', valid);
    expect(on.status).toBe(402);
    expect(on.body.code).toBe('credits_require_paid_plan');
    expect((await call('PUT', '/auto-topup', { ...valid, enabled: false })).status).toBe(200);
  });

  it("PUT saves the caller's settings, clears a recorded failure, and leaves other owners alone", async () => {
    setPolarEnv();
    await setUser({ planOverride: 'pro' });
    await db.insert(autoTopupSettings).values([
      { ownerId: TEST_USER_ID, enabled: true, lastFailure: 'Your card was declined.', lastFailureAt: new Date() },
      { ownerId: OTHER, enabled: true, pack: '500', monthlyLimitMicros: 500_000_000, lastFailure: 'theirs' },
    ]);
    const { status, body } = await call('PUT', '/auto-topup', { ...valid, pack: '100', monthlyLimitMicros: 200_000_000 });
    expect(status).toBe(200);
    expect(body.data as AutoTopupSettings).toMatchObject({
      enabled: true,
      pack: '100',
      monthlyLimitMicros: 200_000_000,
      lastFailure: null,
      lastFailureAt: null,
    });
    const [theirs] = await db.select().from(autoTopupSettings).where(eq(autoTopupSettings.ownerId, OTHER));
    expect(theirs).toMatchObject({ pack: '500', lastFailure: 'theirs' });
    expect(((await call('GET', '/auto-topup')).body.data as AutoTopupSettings).pack).toBe('100');
  });
});

describe('pure helpers', () => {
  const now = new Date('2026-11-10T12:00:00.000Z');

  it.each([
    [{}, '2026-10-11T12:00:00.000Z', '2026-11-10T12:00:00.000Z'],
    [{ to: '2026-11-05T00:00:00Z' }, '2026-10-06T00:00:00.000Z', '2026-11-05T00:00:00.000Z'],
    [{ from: '2026-11-01T00:00:00Z' }, '2026-11-01T00:00:00.000Z', '2026-11-10T12:00:00.000Z'],
  ])('parseUsageRange %j', (query, from, to) => {
    const range = parseUsageRange(query, now);
    expect('error' in range).toBe(false);
    if ('error' in range) return;
    expect(range.from.toISOString()).toBe(from);
    expect(range.to.toISOString()).toBe(to);
  });

  it('parseUsageRange accepts exactly 366 days and refuses a non-string', () => {
    expect('error' in parseUsageRange({ from: '2025-11-09T12:00:00Z', to: '2026-11-10T12:00:00Z' }, now)).toBe(false);
    expect('error' in parseUsageRange({ from: ['a'] }, now)).toBe(true);
  });

  it('buildUsageDays starts at the UTC day of from and ignores rows outside the window', () => {
    const days = buildUsageDays(
      [
        { date: '2026-11-01', kind: 'task', wsec: '10' },
        { date: '2026-11-01', kind: 'task', wsec: 5 },
        { date: '2026-12-01', kind: 'task', wsec: 99 },
      ],
      new Date('2026-11-01T18:00:00Z'),
      new Date('2026-11-02T06:00:00Z')
    );
    expect(days).toEqual([
      { date: '2026-11-01', wsec: 15, byKind: { task: 15 } },
      { date: '2026-11-02', wsec: 0, byKind: {} },
    ]);
  });
});

describe('egress', () => {
  const from = new Date('2026-11-01T00:00:00Z');
  const to = new Date('2026-11-02T00:00:00Z');
  it.each([
    ['usage intervals', () => usageIntervalsReportQuery(TEST_USER_ID, from, to).toSQL().sql],
    ['usage days', () => usageDaysQuery(TEST_USER_ID, from, to).toSQL().sql],
    ['auto top-up settings', () => autoTopupSettingsQuery(TEST_USER_ID).toSQL().sql],
  ])('%s: an explicit projection, scoped to the owner', (_name, build) => {
    const text = build();
    expect(text).not.toMatch(/select \*/i);
    expect(text).toContain('"owner_id" = $1');
  });

  it('the usage queries never pass a Date to the driver', () => {
    for (const query of [usageIntervalsReportQuery(TEST_USER_ID, from, to), usageDaysQuery(TEST_USER_ID, from, to)]) {
      for (const param of query.toSQL().params) expect(param).not.toBeInstanceOf(Date);
    }
  });
});
