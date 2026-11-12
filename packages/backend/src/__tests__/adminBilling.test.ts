/**
 * The operator console's usage-billing routes: the gate, the reason, the audit
 * row, grant idempotency and the egress of every read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { adminRoutes } from '../routes/admin/index.js';
import {
  autoTopupViewQuery,
  grantMicrosFromUsd,
  lotsQuery,
  MAX_GRANT_USD,
  openBoxesQuery,
  periodViewQuery,
  recentIntervalsQuery,
  RECENT_INTERVAL_LIMIT,
} from '../routes/admin/billing.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { adminAuditLog, autoTopupSettings, creditLots, usageIntervals, usagePeriods } from '../db/schema.js';
import { grantCreditLot } from '../services/billing/usage/credits.js';
import { usagePeriodFor } from '@talyn/shared';

const TARGET = 'user-target';
const REASON = 'goodwill after the Nov outage';

function stubAuth(req: Request, _res: Response, next: NextFunction): void {
  const who = req.headers['x-test-user'];
  if (who === 'admin') req.user = { id: 'user-admin', email: 'op@talyn.dev', isAdmin: true };
  else if (who === 'self') req.user = { id: TARGET, email: 'target@example.test', isAdmin: true };
  else if (who === 'member') req.user = { id: 'user-member', email: 'customer@example.test', isAdmin: false };
  next();
}

let db: Database;
let cleanup: () => Promise<void>;
let url: string;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  await seedUser(db, { id: 'user-admin', email: 'op@talyn.dev' });
  await seedUser(db, { id: TARGET, email: 'target@example.test' });
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin', stubAuth, adminRoutes());
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/admin`;
  closeServer = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
});

afterEach(async () => {
  await closeServer();
  await cleanup();
});

function call(method: string, path: string, who: string | null, body?: unknown) {
  return fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { 'x-test-user': who } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const audit = () => db.select().from(adminAuditLog);

describe('gate', () => {
  it.each([
    ['GET', `/users/${TARGET}/billing`],
    ['GET', '/billing/summary'],
    ['POST', `/users/${TARGET}/billing/grant`],
    ['POST', `/users/${TARGET}/billing/lots/x/reverse`],
  ])('%s %s refuses a non-admin and an anonymous caller', async (method, path) => {
    const body = method === 'POST' ? { amountUsd: 5, reason: REASON } : undefined;
    expect((await call(method, path, 'member', body)).status).toBe(403);
    expect((await call(method, path, null, body)).status).toBe(403);
    expect(await audit()).toHaveLength(0);
  });
});

describe('GET billing view', () => {
  it('404s for an unknown user', async () => {
    expect((await call('GET', '/users/nobody/billing', 'admin')).status).toBe(404);
  });

  it('reports an empty account without writing a period row', async () => {
    const res = await call('GET', `/users/${TARGET}/billing`, 'admin');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.tier).toBe('free');
    expect(data.usage).toBeNull();
    expect(data.lots).toEqual([]);
    expect(data.creditBalanceMicros).toBe(0);
    expect(data.openBoxes).toEqual([]);
    expect(await db.select().from(usagePeriods)).toHaveLength(0);
  });

  it('reports usage, boxes, lots, intervals and the top-up failure', async () => {
    const now = new Date();
    const period = usagePeriodFor({ now, anchor: null });
    // A grant clears exhaustion, so it goes in before the exhausted row.
    await grantCreditLot({ ownerId: TARGET, micros: 5_000_000, source: 'grant', polarOrderId: 'o-1' });
    await db.insert(usagePeriods).values({
      ownerId: TARGET, periodStart: period.start, periodEnd: period.end, tier: 'free',
      includedWsec: 36_000, usedWsec: 18_000, exhaustedAt: now,
    });
    await db.insert(usageIntervals).values({
      id: 'i-open', ownerId: TARGET, subjectKind: 'task', subjectId: 't1', sandboxId: 'sb-1',
      size: 'small', weight: '0.50', startedAt: now, billedThrough: now,
    });
    await db.insert(autoTopupSettings).values({ ownerId: TARGET, enabled: true, lastFailure: 'card declined', lastFailureAt: now });

    const { data } = await (await call('GET', `/users/${TARGET}/billing`, 'admin')).json();
    expect(data.usage).toMatchObject({ includedWsec: 36_000, usedWsec: 18_000 });
    expect(data.usage.exhaustedAt).toBeTruthy();
    expect(data.openBoxes).toHaveLength(1);
    expect(data.recentIntervals[0]).toMatchObject({ sandboxId: 'sb-1', endedAt: null });
    expect(data.lots[0]).toMatchObject({ source: 'grant', remainingMicros: 5_000_000, live: true });
    expect(data.creditBalanceMicros).toBe(5_000_000);
    expect(data.autoTopup).toMatchObject({ enabled: true, lastFailure: 'card declined' });
  });

  it('bounds the interval history', async () => {
    const now = Date.now();
    await db.insert(usageIntervals).values(
      Array.from({ length: RECENT_INTERVAL_LIMIT + 10 }, (_, i) => ({
        id: `i-${i}`, ownerId: TARGET, subjectKind: 'task', subjectId: `t${i}`, sandboxId: `sb-${i}`,
        size: 'small', weight: '0.50', startedAt: new Date(now - i * 1000), endedAt: new Date(now - i * 1000 + 500),
        billedThrough: new Date(now), billedWsec: 1,
      }))
    );
    const { data } = await (await call('GET', `/users/${TARGET}/billing`, 'admin')).json();
    expect(data.recentIntervals).toHaveLength(RECENT_INTERVAL_LIMIT);
  });
});

describe('POST grant', () => {
  const grant = (body: Record<string, unknown>, who = 'admin') => call('POST', `/users/${TARGET}/billing/grant`, who, body);

  it('requires a reason', async () => {
    for (const reason of [undefined, '', '   ']) {
      const res = await grant({ amountUsd: 5, reason });
      expect(res.status).toBe(400);
    }
    expect(await db.select().from(creditLots)).toHaveLength(0);
    expect(await audit()).toHaveLength(0);
  });

  it.each([[0], [-5], ['5'], [null], [5.005], [MAX_GRANT_USD + 1], [Number.NaN]])('refuses amount %s', async (amountUsd) => {
    const res = await grant({ amountUsd, reason: REASON });
    expect(res.status).toBe(400);
    expect(await db.select().from(creditLots)).toHaveLength(0);
  });

  it('grants credits to the operator themselves, with an audit row', async () => {
    const res = await grant({ amountUsd: 5, reason: REASON }, 'self');
    expect(res.status).toBe(200);
    const lots = await db.select().from(creditLots);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ ownerId: TARGET, source: 'grant', totalMicros: 5_000_000 });
    const [row] = await audit();
    expect(row).toMatchObject({ action: 'billing.grant_credits', targetId: TARGET, reason: REASON, outcome: 'ok' });
  });

  it('404s for an unknown user', async () => {
    const res = await call('POST', '/users/nobody/billing/grant', 'admin', { amountUsd: 5, reason: REASON });
    expect(res.status).toBe(404);
  });

  it('creates a 12-month grant lot and an audit row with the reason', async () => {
    const res = await grant({ amountUsd: 12.5, reason: REASON });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ created: true, micros: 12_500_000 });
    const [lot] = await db.select().from(creditLots).where(eq(creditLots.id, data.lotId));
    expect(lot).toMatchObject({ ownerId: TARGET, source: 'grant', totalMicros: 12_500_000, remainingMicros: 12_500_000 });
    const months = (lot!.expiresAt.getUTCFullYear() - lot!.purchasedAt.getUTCFullYear()) * 12 + lot!.expiresAt.getUTCMonth() - lot!.purchasedAt.getUTCMonth();
    expect(months).toBe(12);
    const [row] = await audit();
    expect(row).toMatchObject({
      action: 'billing.grant_credits', targetKind: 'user', targetId: TARGET, reason: REASON,
      actorEmail: 'op@talyn.dev', outcome: 'ok',
    });
    expect(row!.params).toMatchObject({ micros: 12_500_000 });
  });

  it('grants once for a repeated idempotency key', async () => {
    const body = { amountUsd: 5, reason: REASON, idempotencyKey: 'key-12345678' };
    const first = (await (await grant(body)).json()).data;
    const second = (await (await grant(body)).json()).data;
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.lotId).toBe(first.lotId);
    expect(await db.select().from(creditLots)).toHaveLength(1);
  });

  it('grants twice when no key is sent', async () => {
    await grant({ amountUsd: 5, reason: REASON });
    await grant({ amountUsd: 5, reason: REASON });
    expect(await db.select().from(creditLots)).toHaveLength(2);
  });

  it('refuses a malformed idempotency key', async () => {
    expect((await grant({ amountUsd: 5, reason: REASON, idempotencyKey: 'x' })).status).toBe(400);
  });
});

describe('POST reverse lot', () => {
  const reverse = (lotId: string, body: Record<string, unknown>) =>
    call('POST', `/users/${TARGET}/billing/lots/${lotId}/reverse`, 'admin', body);

  it('requires a reason and leaves the lot alone without one', async () => {
    const { lotId } = await grantCreditLot({ ownerId: TARGET, micros: 5_000_000, source: 'grant', polarOrderId: 'o-1' });
    expect((await reverse(lotId, {})).status).toBe(400);
    const [lot] = await db.select().from(creditLots).where(eq(creditLots.id, lotId));
    expect(lot!.remainingMicros).toBe(5_000_000);
    expect(await audit()).toHaveLength(0);
  });

  it('zeroes the lot and writes the audit row', async () => {
    const { lotId } = await grantCreditLot({ ownerId: TARGET, micros: 5_000_000, source: 'grant', polarOrderId: 'o-1' });
    const res = await reverse(lotId, { reason: REASON });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ lotId, reversedMicros: 5_000_000 });
    const [lot] = await db.select().from(creditLots).where(eq(creditLots.id, lotId));
    expect(lot!.remainingMicros).toBe(0);
    const [row] = await audit();
    expect(row).toMatchObject({ action: 'billing.reverse_credit_lot', reason: REASON, outcome: 'ok' });
  });

  it('409s on a spent lot and 404s on another account\'s lot', async () => {
    const { lotId } = await grantCreditLot({ ownerId: TARGET, micros: 5_000_000, source: 'grant', polarOrderId: 'o-1' });
    await reverse(lotId, { reason: REASON });
    expect((await reverse(lotId, { reason: REASON })).status).toBe(409);
    const other = await grantCreditLot({ ownerId: 'user-admin', micros: 1_000_000, source: 'grant', polarOrderId: 'o-2' });
    expect((await reverse(other.lotId, { reason: REASON })).status).toBe(404);
    expect((await reverse('missing', { reason: REASON })).status).toBe(404);
  });

  it('refuses a lot with no order id', async () => {
    await db.insert(creditLots).values({
      id: 'lot-x', ownerId: TARGET, totalMicros: 1_000_000, remainingMicros: 1_000_000, source: 'grant',
      purchasedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect((await reverse('lot-x', { reason: REASON })).status).toBe(409);
  });
});

describe('GET summary', () => {
  it('totals the current periods and this month\'s credits', async () => {
    const now = new Date();
    const period = usagePeriodFor({ now, anchor: null });
    await grantCreditLot({ ownerId: TARGET, micros: 5_000_000, source: 'grant', polarOrderId: 'o-1' });
    await grantCreditLot({ ownerId: TARGET, micros: 25_000_000, source: 'purchase', polarOrderId: 'o-2' });
    await grantCreditLot({ ownerId: TARGET, micros: 25_000_000, source: 'auto_topup', polarOrderId: 'o-3' });
    await db.insert(usagePeriods).values([
      { ownerId: TARGET, periodStart: period.start, periodEnd: period.end, tier: 'free', includedWsec: 36_000, usedWsec: 7_200, exhaustedAt: now },
      { ownerId: 'user-admin', periodStart: period.start, periodEnd: period.end, tier: 'pro', includedWsec: 720_000, usedWsec: 3_600 },
    ]);
    const { data } = await (await call('GET', '/billing/summary', 'admin')).json();
    expect(data).toEqual({
      periodBoxWsec: 10_800, ownersWithUsage: 2, ownersExhausted: 1,
      creditsSoldMicros: 50_000_000, creditsGrantedMicros: 5_000_000,
    });
  });
});

describe('grantMicrosFromUsd', () => {
  it.each([[1, 1_000_000], [0.01, 10_000], [19.99, 19_990_000], [MAX_GRANT_USD, MAX_GRANT_USD * 1_000_000]])('%s USD', (usd, micros) => {
    expect(grantMicrosFromUsd(usd)).toBe(micros);
  });
});

describe('projection egress', () => {
  it('no read selects *, and none reaches for identifiers it does not show', () => {
    const queries = [
      openBoxesQuery(TARGET).toSQL().sql,
      recentIntervalsQuery(TARGET).toSQL().sql,
      lotsQuery(TARGET).toSQL().sql,
      autoTopupViewQuery(TARGET).toSQL().sql,
      periodViewQuery(TARGET, new Date()).toSQL().sql,
    ];
    for (const sql of queries) {
      expect(sql).not.toMatch(/select\s+\*/i);
      expect(sql).not.toContain('polar_order_id');
      expect(sql).not.toContain('inflight_order_id');
      expect(sql).not.toContain('created_at');
    }
    expect(queries[0]).toContain('limit');
    expect(queries[1]).toContain('limit');
    expect(queries[2]).toContain('limit');
  });
});
