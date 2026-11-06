import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { adminRoutes } from '../routes/admin/index.js';
import type { ComputeUsageRow, ComputeUsageTotals } from '../routes/admin/computeUsage.js';
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

function get(query = '', who = 'admin'): Promise<{
  status: number;
  body: { data: { items: ComputeUsageRow[]; totals: ComputeUsageTotals } };
}> {
  return new Promise((resolve, reject) => {
    const req = {
      method: 'GET',
      url: '/usage/compute',
      originalUrl: `/api/v1/admin/usage/compute${query}`,
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
