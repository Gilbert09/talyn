import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { adminRoutes } from '../routes/admin/index.js';
import { computeDailyStats, type ComputeUsageRow, type ComputeUsageTotals } from '../routes/admin/computeUsage.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { adminAuditLog, usageIntervals, usagePeriods, users, workbenches, workspaces } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const ALICE = 'user-alice';
const BOB = 'user-bob';

let db: Database;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  await seedUser(db, { id: ALICE, email: 'Alice@example.test' });
  await seedUser(db, { id: BOB, email: 'bob@example.test' });
  await seedUser(db, { id: 'unused', email: 'unused@example.test' });
  await db.update(users).set({ planOverride: 'unlimited' }).where(eq(users.id, ALICE));

  const now = Date.now();
  const recent = new Date(now - 60 * 60 * 1000);
  const old = new Date(now - 10 * 24 * 60 * 60 * 1000);
  const periodStart = new Date(now - 24 * 60 * 60 * 1000);
  const periodEnd = new Date(now + 24 * 60 * 60 * 1000);
  await db.insert(usagePeriods).values([
    { ownerId: ALICE, periodStart, periodEnd, tier: 'pro', includedWsec: 36_000, usedWsec: 10_800, creditMicrosUsed: 2_500_000 },
    { ownerId: BOB, periodStart, periodEnd, tier: 'free', includedWsec: 7_200, usedWsec: 3_600, creditMicrosUsed: 0 },
  ]);
  await db.insert(usageIntervals).values([
    { id: 'a-open', ownerId: ALICE, subjectKind: 'session', subjectId: 'a1', sandboxId: 'box-a1', size: 'small', weight: '1.00', startedAt: recent, billedThrough: recent, billedWsec: 14_400 },
    { id: 'a-old', ownerId: ALICE, subjectKind: 'task', subjectId: 't1', sandboxId: 'box-a2', size: 'small', weight: '1.00', startedAt: old, endedAt: old, billedThrough: old, billedWsec: 7_200 },
    { id: 'b-closed', ownerId: BOB, subjectKind: 'session', subjectId: 'b1', sandboxId: 'box-b1', size: 'small', weight: '1.00', startedAt: recent, endedAt: recent, billedThrough: recent, billedWsec: 3_600 },
  ]);
  await db.insert(workspaces).values([
    { id: 'ws-a', ownerId: ALICE, name: 'Alice' },
    { id: 'ws-b', ownerId: BOB, name: 'Bob' },
    { id: 'ws-unused', ownerId: 'unused', name: 'Unused' },
  ]);
  const bench = (id: string, workspaceId: string, archivedAt: Date | null = null, kind = 'session') => ({
    id, workspaceId, archivedAt, kind, repoFullName: '', name: id,
    branch: id, baseBranch: 'main', runtime: 'cloud', agent: 'codex',
  });
  await db.insert(workbenches).values([
    bench('a1', 'ws-a'),
    bench('a2', 'ws-a', old, 'thread'),
    bench('b1', 'ws-b'),
    bench('b2', 'ws-b'),
    bench('b3', 'ws-b', old),
    bench('unused1', 'ws-unused'),
  ]);

});

afterEach(async () => {
  await cleanup();
});

function get(query = '', who = 'admin', path = '/usage/compute'): Promise<{
  status: number;
  body: { data: { items: ComputeUsageRow[]; totals: ComputeUsageTotals } };
}> {
  return new Promise((resolve, reject) => {
    const req = {
      method: 'GET',
      url: path,
      originalUrl: `/api/v1/admin${path}${query}`,
      headers: {},
      query: Object.fromEntries(new URLSearchParams(query)),
      user: who === 'member'
        ? { id: BOB, email: 'bob@example.test', isAdmin: false }
        : { id: 'operator', email: 'op@talyn.dev', isAdmin: true },
    } as unknown as Request;
    const res = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) {
        resolve({ status: this.statusCode, body: body as { data: { items: ComputeUsageRow[]; totals: ComputeUsageTotals } } });
        return this;
      },
    } as unknown as Response;
    adminRoutes().handle(req, res, reject);
  });
}

describe('compute usage', () => {
  it('shows each account and the totals in period order', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.data.items.map((row) => row.user_id)).toEqual([ALICE, BOB, 'unused']);
    expect(body.data.items[0]).toMatchObject({
      email: 'Alice@example.test', tier: 'pro', plan_override: 'unlimited',
      period_used_hours: 3, period_included_hours: 10, credits_used_usd: 2.5,
      all_time_hours: 6, hours_last_7_days: 4,
      sessions_total: 2, sessions_active: 1, boxes_running: 1,
    });
    expect(body.data.items[0].period_start).toBeTruthy();
    expect(body.data.items[0].period_end).toBeTruthy();
    expect(body.data.items[0].last_active_at).toBeTruthy();
    expect(body.data.items[2]).toMatchObject({
      tier: null, period_start: null, period_end: null,
      all_time_hours: 0, sessions_total: 1, sessions_active: 1,
    });
    expect(body.data.totals).toEqual({
      users: 3, period_used_hours: 4, all_time_hours: 7,
      sessions_total: 6, boxes_running: 1,
    });
    expect(await db.select().from(adminAuditLog)).toHaveLength(0);
  });

  it('sorts by session count', async () => {
    const { body } = await get('?sort=sessions');
    expect(body.data.items.map((row) => row.user_id)).toEqual([BOB, ALICE, 'unused']);
  });

  it('filters email without case sensitivity', async () => {
    const { body } = await get('?q=ALIC');
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].user_id).toBe(ALICE);
    expect(body.data.totals.users).toBe(1);
  });

  it('returns zero totals when no email matches', async () => {
    const { body } = await get('?q=nobody');
    expect(body.data.items).toEqual([]);
    expect(body.data.totals).toEqual({
      users: 0, period_used_hours: 0, all_time_hours: 0,
      sessions_total: 0, boxes_running: 0,
    });
  });

  it('applies ascending order and the limit', async () => {
    const { body } = await get('?sort=all_time_hours&order=asc&limit=1');
    expect(body.data.items.map((row) => row.user_id)).toEqual(['unused']);
    expect(body.data.totals.users).toBe(3);
  });

  it('refuses a non-admin', async () => {
    expect((await get('', 'member')).status).toBe(403);
  });

  it.each(['?sort=email', '?sort=toString', '?order=up', '?limit=501', '?limit=0'])('rejects invalid parameters: %s', async (query) => {
    expect((await get(query)).status).toBe(400);
  });
});

describe('daily compute hours', () => {
  // Far before the shared fixtures, which sit near the real clock, so only these intervals count.
  const NOW = new Date('2020-01-10T12:00:00.000Z');
  const at = (iso: string) => new Date(`2020-01-${iso}Z`);

  beforeEach(async () => {
    const interval = (id: string, ownerId: string, subjectKind: string, size: string, weight: string, startedAt: Date, endedAt: Date | null) => ({
      id, ownerId, subjectKind, subjectId: id, sandboxId: `box-${id}`, size, weight,
      startedAt, endedAt, billedThrough: startedAt, billedWsec: 0,
    });
    await db.insert(usageIntervals).values([
      // Crosses midnight: two hours on each day.
      interval('x1', ALICE, 'workbench', 'small', '1.00', at('08T22:00:00'), at('09T02:00:00')),
      // Still open: runs to NOW, at double weight.
      interval('x2', ALICE, 'task', 'large', '2.00', at('10T10:00:00'), null),
      // Started before the range: only the hour inside it counts, and it is not a box started.
      interval('x3', BOB, 'workbench', 'small', '1.00', at('07T23:00:00'), at('08T01:00:00')),
      interval('x4', BOB, 'workbench', 'small', '1.00', at('10T13:00:00'), at('10T14:00:00')),
      interval('x5', BOB, 'workbench', 'small', '1.00', at('01T10:00:00'), at('01T11:00:00')),
    ]);
  });

  it('splits hours across UTC days for every account', async () => {
    const stats = await computeDailyStats(NOW, 3, null);
    expect(stats.start).toBe('2020-01-08T00:00:00.000Z');
    expect(stats.end).toBe(NOW.toISOString());
    expect(stats.user_id).toBeNull();
    expect(stats.user_email).toBeNull();
    expect(stats.days).toEqual([
      { day: '2020-01-08', start: '2020-01-08T00:00:00.000Z', hours: 3, wall_hours: 3, boxes_started: 1 },
      { day: '2020-01-09', start: '2020-01-09T00:00:00.000Z', hours: 2, wall_hours: 2, boxes_started: 0 },
      { day: '2020-01-10', start: '2020-01-10T00:00:00.000Z', hours: 4, wall_hours: 2, boxes_started: 1 },
    ]);
    expect(stats.bucket).toBe('day');
    expect(stats.totals).toEqual({
      hours: 9, wall_hours: 7, boxes_started: 2,
      peak_day: '2020-01-10', peak_start: '2020-01-10T00:00:00.000Z', peak_hours: 4,
    });
    expect(stats.by_kind).toEqual([{ key: 'workbench', hours: 5 }, { key: 'task', hours: 4 }]);
    expect(stats.by_size).toEqual([{ key: 'small', hours: 5 }, { key: 'large', hours: 4 }]);
    expect(stats.users).toEqual([
      { user_id: ALICE, email: 'Alice@example.test', hours: 8 },
      { user_id: BOB, email: 'bob@example.test', hours: 1 },
    ]);
  });

  it('filters to one account but still lists every account', async () => {
    const stats = await computeDailyStats(NOW, 3, ALICE);
    expect(stats.user_id).toBe(ALICE);
    expect(stats.user_email).toBe('Alice@example.test');
    expect(stats.days.map((point) => point.hours)).toEqual([2, 2, 4]);
    expect(stats.totals).toMatchObject({ hours: 8, wall_hours: 6, boxes_started: 2 });
    expect(stats.by_kind).toEqual([{ key: 'task', hours: 4 }, { key: 'workbench', hours: 4 }]);
    expect(stats.users.map((row) => row.user_id)).toEqual([ALICE, BOB]);
  });

  it.each([
    ['an account with no usage', 'unused', 'unused@example.test'],
    ['an unknown account', 'nobody', null],
  ])('returns zero days for %s', async (_label, userId, email) => {
    const stats = await computeDailyStats(NOW, 2, userId);
    expect(stats.user_email).toBe(email);
    expect(stats.days).toEqual([
      { day: '2020-01-09', start: '2020-01-09T00:00:00.000Z', hours: 0, wall_hours: 0, boxes_started: 0 },
      { day: '2020-01-10', start: '2020-01-10T00:00:00.000Z', hours: 0, wall_hours: 0, boxes_started: 0 },
    ]);
    expect(stats.totals).toEqual({ hours: 0, wall_hours: 0, boxes_started: 0, peak_day: null, peak_start: null, peak_hours: 0 });
    expect(stats.by_kind).toEqual([]);
  });

  it('returns one day for a one-day range', async () => {
    const stats = await computeDailyStats(NOW, 1, null);
    expect(stats.days).toEqual([{ day: '2020-01-10', start: '2020-01-10T00:00:00.000Z', hours: 4, wall_hours: 2, boxes_started: 1 }]);
    expect(stats.users).toEqual([{ user_id: ALICE, email: 'Alice@example.test', hours: 4 }]);
  });

  const nonZero = (stats: { days: { start: string; hours: number; wall_hours: number; boxes_started: number }[] }) =>
    stats.days.filter((point) => point.hours > 0).map(({ start, hours, wall_hours, boxes_started }) => ({ start, hours, wall_hours, boxes_started }));

  it('splits today into UTC hours up to now', async () => {
    const stats = await computeDailyStats(NOW, 'today', null);
    expect(stats.bucket).toBe('hour');
    expect(stats.start).toBe('2020-01-10T00:00:00.000Z');
    expect(stats.end).toBe(NOW.toISOString());
    // 00:00 to 12:00 inclusive: the current hour is the last bucket.
    expect(stats.days).toHaveLength(13);
    expect(stats.days.at(-1)?.start).toBe('2020-01-10T12:00:00.000Z');
    expect(nonZero(stats)).toEqual([
      { start: '2020-01-10T10:00:00.000Z', hours: 2, wall_hours: 1, boxes_started: 1 },
      { start: '2020-01-10T11:00:00.000Z', hours: 2, wall_hours: 1, boxes_started: 0 },
    ]);
    expect(stats.totals).toMatchObject({ hours: 4, peak_day: '2020-01-10', peak_start: '2020-01-10T10:00:00.000Z', peak_hours: 2 });
    // x4 starts at 13:00, after NOW.
    expect(stats.users).toEqual([{ user_id: ALICE, email: 'Alice@example.test', hours: 4 }]);
  });

  it('splits yesterday into 24 UTC hours and ignores today', async () => {
    const stats = await computeDailyStats(NOW, 'yesterday', null);
    expect(stats.bucket).toBe('hour');
    expect(stats.start).toBe('2020-01-09T00:00:00.000Z');
    expect(stats.end).toBe('2020-01-10T00:00:00.000Z');
    expect(stats.days).toHaveLength(24);
    expect(stats.days[0].start).toBe('2020-01-09T00:00:00.000Z');
    expect(stats.days.at(-1)?.start).toBe('2020-01-09T23:00:00.000Z');
    // x1 started the day before, so it counts no box started.
    expect(nonZero(stats)).toEqual([
      { start: '2020-01-09T00:00:00.000Z', hours: 1, wall_hours: 1, boxes_started: 0 },
      { start: '2020-01-09T01:00:00.000Z', hours: 1, wall_hours: 1, boxes_started: 0 },
    ]);
    expect(stats.totals).toMatchObject({ hours: 2, boxes_started: 0 });
    expect(stats.users).toEqual([{ user_id: ALICE, email: 'Alice@example.test', hours: 2 }]);
  });

  it('counts an open interval in yesterday only up to midnight', async () => {
    await db.insert(usageIntervals).values({
      id: 'x6', ownerId: BOB, subjectKind: 'task', subjectId: 'x6', sandboxId: 'box-x6', size: 'small', weight: '1.00',
      startedAt: at('09T22:30:00'), endedAt: null, billedThrough: at('09T22:30:00'), billedWsec: 0,
    });
    const stats = await computeDailyStats(NOW, 'yesterday', BOB);
    expect(nonZero(stats)).toEqual([
      { start: '2020-01-09T22:00:00.000Z', hours: 0.5, wall_hours: 0.5, boxes_started: 1 },
      { start: '2020-01-09T23:00:00.000Z', hours: 1, wall_hours: 1, boxes_started: 0 },
    ]);
    expect(stats.users.find((row) => row.user_id === BOB)?.hours).toBe(1.5);
  });

  it.each(['today', 'yesterday'])('serves hourly buckets for range=%s', async (range) => {
    const { status, body } = await get(`?range=${range}`, 'admin', '/usage/compute/daily');
    expect(status).toBe(200);
    expect((body.data as unknown as { bucket: string }).bucket).toBe('hour');
  });

  it('serves 30 days by default and accepts a user filter', async () => {
    const { status, body } = await get(`?userId=${ALICE}`, 'admin', '/usage/compute/daily');
    expect(status).toBe(200);
    const data = body.data as unknown as { days: unknown[]; user_id: string };
    expect(data.days).toHaveLength(30);
    expect(data.user_id).toBe(ALICE);
  });

  it('refuses a non-admin', async () => {
    expect((await get('', 'member', '/usage/compute/daily')).status).toBe(403);
  });

  it.each(['?days=0', '?days=181', '?days=7d', '?days=-1', '?range=week', '?range='])('rejects an invalid days or range: %s', async (query) => {
    expect((await get(query, 'admin', '/usage/compute/daily')).status).toBe(400);
  });
});
