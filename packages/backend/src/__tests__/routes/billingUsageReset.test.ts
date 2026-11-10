import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { includedWeightedSeconds, usagePeriodFor, type BillingStatus, type PlanTier } from '@talyn/shared';
import { billingRoutes } from '../../routes/billing.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { usagePeriods, usageResets, users as usersTable } from '../../db/schema.js';

const polarMocks = vi.hoisted(() => ({
  createUsageResetCheckoutUrl: vi.fn(async (_userId: string, tier: string, _returnTo?: string | null) => `https://polar.test/reset/${tier}`),
}));

vi.mock('../../services/billing/polar.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/billing/polar.js')>();
  return { ...actual, createUsageResetCheckoutUrl: polarMocks.createUsageResetCheckoutUrl };
});

const headers = { ...internalProxyHeaders(TEST_USER_ID), 'content-type': 'application/json' };
const ENV: Record<string, string> = {
  POLAR_ACCESS_TOKEN: 'polar-test-token',
  POLAR_WEBHOOK_SECRET: 'whsec_x',
  POLAR_ENVIRONMENT: 'sandbox',
  POLAR_PRODUCT_ID_RESET_PRO: 'prod-reset-pro',
  POLAR_PRODUCT_ID_RESET_MAX: 'prod-reset-max',
  POLAR_PRODUCT_ID_RESET_LEGACY_PRO: 'prod-reset-legacy',
};
const TOUCHED = [...Object.keys(ENV), 'TALYN_PUBLIC_API_URL', 'WEB_APP_URL'];
const savedEnv: Record<string, string | undefined> = {};

let db: Database;
let cleanup: () => Promise<void>;
let url: string;
let close: () => Promise<void>;

const HOUR = 3600;
const currentPeriod = () => usagePeriodFor({ now: new Date(), anchor: null });

async function seedPeriod(tier: PlanTier, usedWsec: number) {
  const period = currentPeriod();
  await db.insert(usagePeriods).values({
    ownerId: TEST_USER_ID,
    periodStart: period.start,
    periodEnd: period.end,
    tier,
    includedWsec: includedWeightedSeconds(tier),
    usedWsec,
  });
}

const setOverride = (planOverride: string | null) =>
  db.update(usersTable).set({ planOverride }).where(eq(usersTable.id, TEST_USER_ID));

async function getStatus(): Promise<BillingStatus> {
  const res = await fetch(`${url}/billing/status`, { headers });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: BillingStatus }).data;
}

const checkout = () => fetch(`${url}/billing/usage-reset/checkout`, { method: 'POST', headers, body: '{}' });

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  for (const k of TOUCHED) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, ENV);
  await seedUser(db);

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
  for (const k of TOUCHED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  polarMocks.createUsageResetCheckoutUrl.mockClear();
  await close();
  await cleanup();
});

describe('GET /billing/status: the usage reset offer', () => {
  it.each<[string, PlanTier, number]>([
    ['pro', 'pro', 40_000_000],
    ['max', 'max', 100_000_000],
    ['legacy_pro', 'legacy_pro', 15_000_000],
  ])('offers a %s reset at the monthly price with the full allowance', async (override, tier, price) => {
    await setOverride(override);
    await seedPeriod(tier, 5 * HOUR);
    const status = await getStatus();
    expect(status.usageReset).toEqual({ tier, priceMicros: price, includedWsec: includedWeightedSeconds(tier) });
    expect(status.usage?.resets).toBe(0);
  });

  it.each<[string, () => Promise<void>]>([
    ['the tier has no reset product', async () => void delete process.env.POLAR_PRODUCT_ID_RESET_PRO],
    ['nothing is used yet', async () => void (await db.update(usagePeriods).set({ usedWsec: 0 }))],
    ['the account is free', async () => void (await setOverride(null))],
  ])('no offer when %s', async (_label, arrange) => {
    await setOverride('pro');
    await seedPeriod('pro', 5 * HOUR);
    await arrange();
    const status = await getStatus();
    expect(status.usageReset).toBeUndefined();
  });

  it('counts the resets applied in this period', async () => {
    await setOverride('pro');
    await seedPeriod('pro', 5 * HOUR);
    const period = currentPeriod();
    await db.insert(usageResets).values([
      { id: 'r1', ownerId: TEST_USER_ID, polarOrderId: 'o1', tier: 'pro', periodStart: period.start },
      { id: 'r2', ownerId: TEST_USER_ID, polarOrderId: 'o2', tier: 'pro', periodStart: period.start },
      // A refund tombstone (no period) and an older period do not count.
      { id: 'r3', ownerId: TEST_USER_ID, polarOrderId: 'o3', tier: 'pro', periodStart: null, refundedAt: new Date() },
      { id: 'r4', ownerId: TEST_USER_ID, polarOrderId: 'o4', tier: 'pro', periodStart: new Date('2020-01-01T00:00:00Z') },
    ]);
    expect((await getStatus()).usage?.resets).toBe(2);
  });
});

describe('POST /billing/usage-reset/checkout', () => {
  it("opens the checkout for the caller's own tier", async () => {
    await setOverride('max');
    await seedPeriod('max', 10 * HOUR);
    const res = await checkout();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { url: 'https://polar.test/reset/max' } });
    expect(polarMocks.createUsageResetCheckoutUrl).toHaveBeenCalledWith(TEST_USER_ID, 'max', null);
  });

  it.each<[string, () => Promise<void>, number, string]>([
    ['a free account', async () => void (await setOverride(null)), 402, 'usage_reset_requires_paid_plan'],
    ['nothing used', async () => void (await db.update(usagePeriods).set({ usedWsec: 0 })), 409, 'nothing_to_reset'],
    ['no product for the tier', async () => void delete process.env.POLAR_PRODUCT_ID_RESET_PRO, 404, 'usage_reset_unavailable'],
  ])('refuses %s', async (_label, arrange, status, code) => {
    await setOverride('pro');
    await seedPeriod('pro', 5 * HOUR);
    await arrange();
    const res = await checkout();
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ success: false, code });
    expect(polarMocks.createUsageResetCheckoutUrl).not.toHaveBeenCalled();
  });

  it('passes the mobile returnTo through to the checkout', async () => {
    await setOverride('pro');
    await seedPeriod('pro', 5 * HOUR);
    const res = await fetch(`${url}/billing/usage-reset/checkout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ returnTo: 'talyn-mobile://' }),
    });
    expect(res.status).toBe(200);
    expect(polarMocks.createUsageResetCheckoutUrl).toHaveBeenCalledWith(TEST_USER_ID, 'pro', 'talyn-mobile://');
  });

  it('refuses a returnTo that is not an allowed app scheme', async () => {
    await setOverride('pro');
    await seedPeriod('pro', 5 * HOUR);
    const res = await fetch(`${url}/billing/usage-reset/checkout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ returnTo: 'https://evil.test/' }),
    });
    expect(res.status).toBe(400);
    expect(polarMocks.createUsageResetCheckoutUrl).not.toHaveBeenCalled();
  });

  it('400s when billing is not configured', async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    const res = await checkout();
    expect(res.status).toBe(400);
  });
});
