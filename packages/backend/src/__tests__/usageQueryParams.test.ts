import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { users, workspaces } from '../db/schema.js';
import * as websocketModule from '../services/websocket.js';
import { chargeOwnerAt, readBudget } from '../services/billing/usage/charge.js';
import { burnCredits, creditBalance, expireCreditLots, grantCreditLot, liveLots, reverseCreditLot } from '../services/billing/usage/credits.js';
import { insertOpenInterval, markIntervalClosed } from '../services/billing/usage/intervals.js';
import { clearExhausted, ensurePeriod, stampAlert, stampExhausted } from '../services/billing/usage/periods.js';
import { UsageSweep } from '../services/billing/usage/sweep.js';

/**
 * Every date the usage ledger sends must reach the driver ENCODED.
 *
 * A Date interpolated into a raw `sql` fragment carries no column type, so
 * drizzle hands it to postgres-js as is, and postgres-js throws before
 * Postgres is asked. pglite encodes the Date itself, so running the query
 * here proves nothing; what lands in the driver's parameter list does. See
 * `loopQueryParams.test.ts` for the incident.
 */
describe('usage ledger queries: no unencoded Date reaches the driver', () => {
  let db: Database;
  let pglite: PGlite;
  let cleanup: () => Promise<void>;
  let params: unknown[][];
  const OWNER = 'owner-a';
  const T0 = new Date('2026-11-10T12:00:00.000Z');
  const later = new Date(T0.getTime() + 3_600_000);

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    pglite = t.pglite;
    cleanup = t.cleanup;
    await seedUser(db, { id: OWNER });
    await db.insert(workspaces).values({ id: 'ws', ownerId: OWNER, name: 'W' });
    vi.spyOn(websocketModule, 'emitUsageAlert').mockImplementation(() => {});
    vi.spyOn(websocketModule, 'emitUsageExhausted').mockImplementation(() => {});
    vi.spyOn(websocketModule, 'emitSubscriptionUpdated').mockImplementation(() => {});
    process.env.POLAR_ACCESS_TOKEN = 'test-token';
    params = [];
    const original = pglite.query.bind(pglite) as (query: string, p?: unknown[], o?: unknown) => Promise<unknown>;
    (pglite as unknown as { query: typeof original }).query = (query, p, o) => {
      if (p) params.push(p);
      return original(query, p, o);
    };
  });

  afterEach(async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    vi.restoreAllMocks();
    await cleanup();
  });

  const dates = () => params.flat().filter((p) => p instanceof Date);
  const open = () =>
    insertOpenInterval({ ownerId: OWNER, workspaceId: 'ws', subjectKind: 'task', subjectId: 't', sandboxId: 'box', size: 'standard', startedAt: T0 });
  const period = { start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z') };

  it.each<[string, () => Promise<unknown>]>([
    ['insertOpenInterval', open],
    ['markIntervalClosed', async () => { await open(); await markIntervalClosed('box', later, 'terminal'); }],
    ['chargeOwnerAt (with overage, alerts and exhaustion)', async () => {
      await db.update(users).set({ planOverride: 'free' });
      await open();
      await chargeOwnerAt(OWNER, new Date(T0.getTime() + 20 * 3_600_000));
    }],
    ['readBudget', () => readBudget(OWNER, later)],
    ['ensurePeriod + stamps', async () => {
      await ensurePeriod(OWNER, 'pro', period);
      await stampAlert(OWNER, period.start, 50, later);
      await stampExhausted(OWNER, period.start, later);
      await clearExhausted(OWNER);
    }],
    ['credits', async () => {
      await grantCreditLot({ ownerId: OWNER, micros: 5_000_000, source: 'purchase', polarOrderId: 'o1', purchasedAt: T0 });
      await burnCredits(OWNER, 1_000_000, later, { periodStart: period.start });
      await creditBalance(OWNER, later);
      await liveLots(OWNER, later);
      await reverseCreditLot('o1');
      await expireCreditLots(later);
    }],
    ['sweep', async () => {
      await open();
      await new UsageSweep(async () => []).run(later);
      await new UsageSweep(async () => []).run(later);
    }],
  ])('%s encodes every date parameter', async (_name, run) => {
    await run();
    expect(params.length).toBeGreaterThan(0);
    expect(dates()).toEqual([]);
  });

  it('proves the assertion can fail', async () => {
    const { sql } = await import('drizzle-orm');
    const { usageIntervals } = await import('../db/schema.js');
    await db.select({ id: usageIntervals.id }).from(usageIntervals).where(sql`${usageIntervals.startedAt} < ${T0}`);
    expect(dates()).toHaveLength(1);
  });
});
