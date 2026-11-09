import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { billingPublicRoutes, billingRoutes } from '../../routes/billing.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import { users as usersTable } from '../../db/schema.js';
import * as polar from '../../services/billing/polar.js';
import type { Database } from '../../db/client.js';

/**
 * `returnTo` on the billing routes the mobile app opens in a browser:
 * checkout, credit checkout and the portal validate it (400
 * `invalid_return_to`) and pass it on, and the public bounce route turns
 * Polar's https redirect into the app's deep link.
 */

vi.mock('../../services/billing/polar.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/billing/polar.js')>();
  return {
    ...actual,
    createCheckoutUrl: vi.fn(async () => 'https://polar.test/checkout'),
    createCreditCheckoutUrl: vi.fn(async () => 'https://polar.test/credits'),
    createPortalUrl: vi.fn(async () => 'https://polar.test/portal'),
  };
});

const headers = { ...internalProxyHeaders(TEST_USER_ID), 'content-type': 'application/json' };
const ENV_KEYS = [
  'POLAR_ACCESS_TOKEN',
  'POLAR_WEBHOOK_SECRET',
  'POLAR_ENVIRONMENT',
  'POLAR_PRODUCT_ID_MONTHLY',
  'POLAR_PRODUCT_ID_ANNUAL',
  'MOBILE_RETURN_SCHEMES',
];
const savedEnv: Record<string, string | undefined> = {};

let db: Database;
let cleanup: () => Promise<void>;
let url: string;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
  process.env.POLAR_WEBHOOK_SECRET = 'whsec_x';
  process.env.POLAR_ENVIRONMENT = 'sandbox';
  process.env.POLAR_PRODUCT_ID_MONTHLY = 'prod-m';
  process.env.POLAR_PRODUCT_ID_ANNUAL = 'prod-a';
  vi.mocked(polar.createCheckoutUrl).mockClear();
  vi.mocked(polar.createCreditCheckoutUrl).mockClear();
  vi.mocked(polar.createPortalUrl).mockClear();
  await seedUser(db);

  const app = express();
  app.use(express.json());
  // Mounted the way routes/index.ts does: the public router first, at the
  // same prefix, and the authed router behind requireAuth.
  app.use('/billing', wrapAsyncRoutes(billingPublicRoutes()));
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
  await close();
  await cleanup();
});

function post(path: string, body: Record<string, unknown>) {
  return fetch(`${url}/billing/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function makePro() {
  await db.update(usersTable).set({ planOverride: 'pro' }).where(eq(usersTable.id, TEST_USER_ID));
}

const ROUTES = [
  { path: 'checkout', body: { period: 'monthly' } },
  { path: 'credits/checkout', body: { pack: '25' } },
  { path: 'portal', body: {} },
] as const;

describe('returnTo validation', () => {
  const INVALID: Array<[string, unknown]> = [
    ['https', 'https://evil.example.com'],
    ['a host after the scheme', 'talyn-mobile://evil'],
    ['no slashes', 'talyn-mobile-development:'],
    ['uppercase', 'TALYN-MOBILE://'],
    ['javascript', 'javascript:alert(1)'],
    ['empty', ''],
    ['a number', 3],
  ];

  for (const route of ROUTES) {
    it.each(INVALID)(`${route.path}: 400 invalid_return_to for %s`, async (_label, returnTo) => {
      const res = await post(route.path, { ...route.body, returnTo });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ success: false, code: 'invalid_return_to' });
    });
  }

  it('nothing reaches Polar for a refused returnTo', async () => {
    await makePro();
    for (const route of ROUTES) await post(route.path, { ...route.body, returnTo: 'https://evil' });
    expect(polar.createCheckoutUrl).not.toHaveBeenCalled();
    expect(polar.createCreditCheckoutUrl).not.toHaveBeenCalled();
    expect(polar.createPortalUrl).not.toHaveBeenCalled();
  });
});

describe('returnTo pass-through', () => {
  it.each([
    ['talyn-mobile://', 'talyn-mobile://'],
    ['null', null],
    ['absent', undefined],
  ])('checkout with %s', async (_label, returnTo) => {
    const res = await post('checkout', { period: 'monthly', ...(returnTo === undefined ? {} : { returnTo }) });
    expect(res.status).toBe(200);
    expect(polar.createCheckoutUrl).toHaveBeenCalledWith(TEST_USER_ID, 'monthly', 'pro', returnTo ?? null);
  });

  it.each([
    ['talyn-mobile-preview://', 'talyn-mobile-preview://'],
    ['absent', undefined],
  ])('credit checkout with %s', async (_label, returnTo) => {
    await makePro();
    const res = await post('credits/checkout', { pack: '100', ...(returnTo ? { returnTo } : {}) });
    expect(res.status).toBe(200);
    expect(polar.createCreditCheckoutUrl).toHaveBeenCalledWith(TEST_USER_ID, '100', returnTo ?? null);
  });

  it.each([
    ['talyn-mobile-development://', 'talyn-mobile-development://'],
    ['absent', undefined],
  ])('portal with %s', async (_label, returnTo) => {
    const res = await post('portal', returnTo ? { returnTo } : {});
    expect(res.status).toBe(200);
    expect(polar.createPortalUrl).toHaveBeenCalledWith(TEST_USER_ID, returnTo ?? null);
  });

  it('portal with no body at all (older clients) still works', async () => {
    const res = await fetch(`${url}/billing/portal`, { method: 'POST', headers: internalProxyHeaders(TEST_USER_ID) });
    expect(res.status).toBe(200);
    expect(polar.createPortalUrl).toHaveBeenCalledWith(TEST_USER_ID, null);
  });

  it('honours a MOBILE_RETURN_SCHEMES override', async () => {
    process.env.MOBILE_RETURN_SCHEMES = 'myapp://';
    expect((await post('portal', { returnTo: 'myapp://' })).status).toBe(200);
    expect((await post('portal', { returnTo: 'talyn-mobile://' })).status).toBe(400);
  });
});

describe('GET /billing/mobile-return (public bounce)', () => {
  function bounce(params: Record<string, string>) {
    return fetch(`${url}/billing/mobile-return?${new URLSearchParams(params)}`, { redirect: 'manual' });
  }

  it.each([
    ['talyn-mobile://', 'checkout', 'success'],
    ['talyn-mobile://', 'checkout', 'cancel'],
    ['talyn-mobile-preview://', 'credits', 'success'],
    ['talyn-mobile-preview://', 'credits', 'cancel'],
    ['talyn-mobile-development://', 'portal', 'success'],
  ])('302s %s with kind=%s result=%s to the app', async (to, kind, result) => {
    const res = await bounce({ to, kind, result });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${to}billing/return?kind=${kind}&result=${result}`);
  });

  it('needs no auth header', async () => {
    const res = await bounce({ to: 'talyn-mobile://', kind: 'checkout', result: 'success' });
    expect(res.status).toBe(302);
  });

  it.each<[string, Record<string, string>]>([
    ['an https target', { to: 'https://evil.example.com', kind: 'checkout', result: 'success' }],
    ['a target with a host', { to: 'talyn-mobile://evil', kind: 'checkout', result: 'success' }],
    ['a target with a path', { to: 'talyn-mobile://x/y', kind: 'checkout', result: 'success' }],
    ['a javascript target', { to: 'javascript:alert(1)', kind: 'checkout', result: 'success' }],
    ['no target', { kind: 'checkout', result: 'success' }],
    ['an unknown kind', { to: 'talyn-mobile://', kind: 'refund', result: 'success' }],
    ['no kind', { to: 'talyn-mobile://', result: 'success' }],
    ['an unknown result', { to: 'talyn-mobile://', kind: 'checkout', result: 'paid' }],
    ['no result', { to: 'talyn-mobile://', kind: 'checkout' }],
  ])('400 and no redirect for %s', async (_label, params) => {
    const res = await bounce(params);
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('a repeated query parameter is refused, not joined', async () => {
    const res = await fetch(
      `${url}/billing/mobile-return?to=talyn-mobile://&to=https://evil&kind=checkout&result=success`,
      { redirect: 'manual' }
    );
    expect(res.status).toBe(400);
  });

  it('honours a MOBILE_RETURN_SCHEMES override', async () => {
    process.env.MOBILE_RETURN_SCHEMES = 'myapp://';
    expect((await bounce({ to: 'myapp://', kind: 'portal', result: 'success' })).status).toBe(302);
    expect((await bounce({ to: 'talyn-mobile://', kind: 'portal', result: 'success' })).status).toBe(400);
  });

  it('does not shadow the authenticated billing routes', async () => {
    const res = await fetch(`${url}/billing/status`, { headers });
    expect(res.status).toBe(200);
  });
});
