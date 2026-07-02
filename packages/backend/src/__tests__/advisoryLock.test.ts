import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  advisoryLockKey,
  tryWithAdvisoryLock,
  withBlockingAdvisoryLock,
  guardCrossReplica,
} from '../services/advisoryLock.js';
import { createTestDb } from './helpers/testDb.js';
import { resetDbClient, type Database } from '../db/client.js';

afterEach(() => {
  resetDbClient();
});

describe('advisoryLockKey', () => {
  it('is stable for the same name', () => {
    expect(advisoryLockKey('taskQueue:dispatch')).toBe(advisoryLockKey('taskQueue:dispatch'));
  });

  it('differs across loop names', () => {
    const names = [
      'taskQueue:dispatch',
      'mergeQueue:tick',
      'prAutoMergeWatcher:tick',
      'cloudPoller:tick',
      'prReconcileSweep:tick',
      'db:migrate',
    ];
    const keys = new Set(names.map((n) => advisoryLockKey(n).toString()));
    expect(keys.size).toBe(names.length);
  });

  it('fits in a signed 64-bit bigint (Postgres advisory key range)', () => {
    for (const name of ['a', 'taskQueue:dispatch', 'x'.repeat(200)]) {
      const key = advisoryLockKey(name);
      expect(key >= -(2n ** 63n)).toBe(true);
      expect(key < 2n ** 63n).toBe(true);
    }
  });
});

/** A scripted Database double: transaction() hands fn a tx whose execute
 *  returns the canned lock result. */
function mockDb(lockResult: unknown): { db: Database; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => lockResult);
  const db = {
    transaction: async <T>(fn: (tx: { execute: typeof execute }) => Promise<T>) =>
      fn({ execute }),
  } as unknown as Database;
  return { db, execute };
}

describe('tryWithAdvisoryLock', () => {
  it('runs fn and returns its result when the lock is acquired (array rows)', async () => {
    const { db } = mockDb([{ acquired: true }]);
    const fn = vi.fn(async () => 'did-work');
    const outcome = await tryWithAdvisoryLock(db, 'test:lock', fn);
    expect(outcome).toEqual({ acquired: true, result: 'did-work' });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('handles pglite-style { rows } results', async () => {
    const { db } = mockDb({ rows: [{ acquired: true }] });
    const outcome = await tryWithAdvisoryLock(db, 'test:lock', async () => 42);
    expect(outcome).toEqual({ acquired: true, result: 42 });
  });

  it('skips fn entirely when another session holds the lock', async () => {
    const { db } = mockDb([{ acquired: false }]);
    const fn = vi.fn(async () => 'should-not-run');
    const outcome = await tryWithAdvisoryLock(db, 'test:lock', fn);
    expect(outcome).toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it('propagates fn errors (rolling back the lock transaction)', async () => {
    const { db } = mockDb([{ acquired: true }]);
    await expect(
      tryWithAdvisoryLock(db, 'test:lock', async () => {
        throw new Error('tick failed');
      })
    ).rejects.toThrow('tick failed');
  });
});

describe('guardCrossReplica', () => {
  it('passes straight through off real Postgres (single-process tests)', async () => {
    // No DB registered at all — isRealPostgres() is false, fn must still run.
    const fn = vi.fn(async () => 'ran');
    const outcome = await guardCrossReplica('test:lock', fn);
    expect(outcome).toEqual({ acquired: true, result: 'ran' });
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('against real (pglite) Postgres — SQL validity', () => {
  it('tryWithAdvisoryLock acquires, runs fn, and releases on commit', async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const outcome = await tryWithAdvisoryLock(db, 'itest:lock', async () => 'ok');
      expect(outcome).toEqual({ acquired: true, result: 'ok' });

      // xact-scoped locks release at commit — nothing may linger.
      const res = await db.execute(
        sql`select count(*)::int as held from pg_locks where locktype = 'advisory'`
      );
      const rows = Array.isArray(res) ? res : (res as { rows: unknown[] }).rows;
      expect((rows[0] as { held: number }).held).toBe(0);

      // And a subsequent tick can re-acquire.
      const again = await tryWithAdvisoryLock(db, 'itest:lock', async () => 'ok-again');
      expect(again).toEqual({ acquired: true, result: 'ok-again' });
    } finally {
      await cleanup();
    }
  });

  it('withBlockingAdvisoryLock waits for the lock and returns fn result', async () => {
    const { db, cleanup } = await createTestDb();
    try {
      const result = await withBlockingAdvisoryLock(db, 'itest:migrate', async () => 'migrated');
      expect(result).toBe('migrated');
    } finally {
      await cleanup();
    }
  });
});
