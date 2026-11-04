import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PLAN_LIMITS } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { tasks, users, workspaces } from '../db/schema.js';

const { getBudget, harness } = vi.hoisted(() => ({
  getBudget: vi.fn(),
  harness: {
    pool: undefined as unknown,
    poolSize: 3,
    openTx: 0,
    peakTx: 0,
    locked: 0,
    poolQueriesWhileLocked: 0,
    waiters: [] as Array<() => void>,
    lockHolders: new Map<string, Promise<void>>(),
  },
}));

vi.mock('../services/billing/usage/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/billing/usage/index.js')>()),
  getBudget,
}));
vi.mock('../db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/client.js')>()),
  isRealPostgres: () => true,
  getPoolDbClient: () => harness.pool,
}));

import { ConcurrentBoxLimitError, withBoxGate } from '../services/billing/entitlements.js';

const OWNER = 'owner-lock';

/**
 * A pool of `poolSize` connections over one pglite database. Each transaction
 * holds a slot until it ends; `pg_advisory_xact_lock` waits on a per-key
 * mutex that the holder releases at commit. A query run on the pool handle
 * (not the transaction) while a lock is held is counted: that is the second
 * connection the old helper needed, and what deadlocks a small pool.
 */
function buildPool(db: Database): Database {
  const takeSlot = async () => {
    while (harness.openTx >= harness.poolSize) {
      await new Promise<void>((resolve) => harness.waiters.push(resolve));
    }
    harness.openTx++;
    harness.peakTx = Math.max(harness.peakTx, harness.openTx);
  };
  const freeSlot = () => {
    harness.openTx--;
    harness.waiters.shift()?.();
  };
  const tx = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return async (query: { queryChunks?: unknown[] }) => {
          const text = JSON.stringify(query.queryChunks ?? []);
          if (text.includes('pg_advisory_xact_lock')) {
            const key = /\{"value":\["(-?\d+)"\]|"(-?\d+)"/.exec(text)?.[0] ?? text;
            while (harness.lockHolders.has(key)) await harness.lockHolders.get(key);
            let release!: () => void;
            harness.lockHolders.set(key, new Promise<void>((r) => (release = r)));
            (tx as unknown as { release: Array<() => void> }).release.push(() => {
              harness.lockHolders.delete(key);
              release();
            });
            harness.locked++;
            return [];
          }
          return (target as Database).execute(query as never);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  (tx as unknown as { release: Array<() => void> }).release = [];
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return async (cb: (t: Database) => Promise<unknown>) => {
          await takeSlot();
          try {
            return await cb(tx);
          } finally {
            const rel = (tx as unknown as { release: Array<() => void> }).release.splice(0);
            if (rel.length) harness.locked--;
            rel.forEach((r) => r());
            freeSlot();
          }
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (harness.locked > 0) harness.poolQueriesWhileLocked++;
        return value.apply(target, args);
      };
    },
  });
}

describe('the box gate lock (watcher path, small pool)', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const savedPolar = process.env.POLAR_ACCESS_TOKEN;

  beforeAll(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: OWNER });
    await db.insert(workspaces).values({ id: 'ws-lock', ownerId: OWNER, name: 'w', settings: {} });
  });
  afterAll(async () => cleanup());

  beforeEach(async () => {
    process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
    getBudget.mockResolvedValue({
      tier: 'free',
      period: { start: new Date('2026-11-01'), end: new Date('2026-12-01') },
      includedWsec: 3600,
      usedWsec: 0,
      includedLeftWsec: 1800,
      creditMicros: 0,
      autoTopupPossible: false,
      exhausted: false,
    });
    await db.delete(tasks);
    await db.update(users).set({ planOverride: null }).where(eq(users.id, OWNER));
    Object.assign(harness, { openTx: 0, peakTx: 0, locked: 0, poolQueriesWhileLocked: 0, waiters: [] });
    harness.lockHolders.clear();
    harness.pool = buildPool(db);
  });

  afterEach(() => {
    if (savedPolar === undefined) delete process.env.POLAR_ACCESS_TOKEN;
    else process.env.POLAR_ACCESS_TOKEN = savedPolar;
  });

  it.each([
    { callers: 12, poolSize: 3 },
    { callers: 30, poolSize: 2 },
  ])('admits exactly the cap from $callers concurrent calls on a pool of $poolSize', async ({ callers, poolSize }) => {
    harness.poolSize = poolSize;
    const cap = PLAN_LIMITS.free.concurrentBoxes;
    let seq = 0;
    const results = await Promise.allSettled(
      Array.from({ length: callers }, () =>
        withBoxGate(OWNER, { size: 'small', unattended: true, workspaceId: 'ws-lock' }, async () => {
          const { getDbClient } = await import('../db/client.js');
          await getDbClient().insert(tasks).values({
            id: `t-lock-${++seq}-${Math.random()}`,
            workspaceId: 'ws-lock',
            type: 'code_writing',
            status: 'queued',
            title: 't',
            description: 'd',
          });
        })
      )
    );
    const admitted = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof ConcurrentBoxLimitError
    ).length;
    expect(admitted).toBe(cap);
    expect(refused).toBe(callers - cap);
    expect(harness.peakTx).toBeLessThanOrEqual(poolSize);
    expect(harness.poolQueriesWhileLocked).toBe(0);
  }, 20_000);
});
