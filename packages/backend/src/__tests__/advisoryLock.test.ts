import { describe, it, expect, vi, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  advisoryLockKey,
  tryWithAdvisoryLock,
  withBlockingAdvisoryLock,
  guardCrossReplica,
  AdvisoryLockWedgedError,
  DEFAULT_MAX_LOCK_HOLD_MS,
} from '../services/advisoryLock.js';
import { TickGuard } from '../services/tickGuard.js';
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

  it('pins the Postgres-side backstop to the transaction, above the JS deadline', async () => {
    const { db, execute } = mockDb([{ acquired: true }]);
    await tryWithAdvisoryLock(db, 'test:lock', async () => 'ok', { maxHoldMs: 1_000 });
    // First statement in the transaction, before the lock is even attempted —
    // a transaction that dies between the two must not leave the lock held.
    const first = execute.mock.calls[0]?.[0] as { queryChunks?: unknown[] } | undefined;
    const rendered = JSON.stringify(first);
    expect(rendered).toContain('idle_in_transaction_session_timeout');
    // 30s of grace over the JS deadline, so the clean unwind normally wins.
    expect(rendered).toContain('31000');
  });
});

/**
 * The 2026-09-16 regression: a tick that never settles used to keep the lock
 * transaction open forever, so every later tick skipped with "held by another
 * instance" and the loop was dead until a redeploy.
 */
describe('a wedged tick cannot keep the lock', () => {
  it('abandons a tick that overruns maxHoldMs', async () => {
    const { db } = mockDb([{ acquired: true }]);
    const never = new Promise<string>(() => {});
    await expect(
      tryWithAdvisoryLock(db, 'test:wedge', () => never, { maxHoldMs: 20 })
    ).rejects.toBeInstanceOf(AdvisoryLockWedgedError);
  });

  it('names the loop and its budget, so the log says which loop stalled', async () => {
    const { db } = mockDb([{ acquired: true }]);
    await tryWithAdvisoryLock(db, 'cloudPoller:tick', () => new Promise<void>(() => {}), {
      maxHoldMs: 20,
    }).then(
      () => expect.fail('should have rejected'),
      (err: AdvisoryLockWedgedError) => {
        expect(err.lockName).toBe('cloudPoller:tick');
        expect(err.heldMs).toBe(20);
        expect(err.message).toContain('cloudPoller:tick');
      }
    );
  });

  it('does not hold the lock open past the deadline waiting on the tick', async () => {
    const { db } = mockDb([{ acquired: true }]);
    let released = false;
    // Resolves only when the transaction callback has returned/thrown —
    // i.e. when Postgres would COMMIT/ROLLBACK and free the xact lock.
    const wedged = tryWithAdvisoryLock(db, 'test:wedge', () => new Promise<void>(() => {}), {
      maxHoldMs: 20,
    }).catch(() => {
      released = true;
    });
    await wedged;
    expect(released).toBe(true);
  });

  it('a later tick runs normally once the wedged one has been abandoned', async () => {
    const { db } = mockDb([{ acquired: true }]);
    await expect(
      tryWithAdvisoryLock(db, 'test:wedge', () => new Promise<void>(() => {}), { maxHoldMs: 20 })
    ).rejects.toBeInstanceOf(AdvisoryLockWedgedError);

    const fn = vi.fn(async () => 'recovered');
    const outcome = await tryWithAdvisoryLock(db, 'test:wedge', fn, { maxHoldMs: 20 });
    expect(outcome).toEqual({ acquired: true, result: 'recovered' });
  });

  it('says so out loud when the holder is our OWN unfinished tick', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Acquires, then hangs: the name is registered as held by this process.
      const wedged = tryWithAdvisoryLock(
        db_acquire(),
        'test:self',
        () => new Promise<void>(() => {}),
        { maxHoldMs: 500 }
      ).catch(() => {});
      // A concurrent tick on the same name is refused by Postgres.
      await tryWithAdvisoryLock(db_refuse(), 'test:self', async () => 'nope');
      expect(error.mock.calls.flat().join(' ')).toContain('wedged, not contended');
      await wedged;
    } finally {
      error.mockRestore();
    }
  });

  it('reports ordinary cross-replica contention without the wedge warning', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const outcome = await tryWithAdvisoryLock(db_refuse(), 'test:other', async () => 'nope');
      expect(outcome).toEqual({ acquired: false });
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

function db_acquire(): Database {
  return mockDb([{ acquired: true }]).db;
}
function db_refuse(): Database {
  return mockDb([{ acquired: false }]).db;
}

describe('the two watchdogs agree', () => {
  it('TickGuard\'s default budget is the lock\'s default budget', () => {
    expect(new TickGuard('x').maxMs).toBe(DEFAULT_MAX_LOCK_HOLD_MS);
  });

  it('a guard with a custom budget reports it, so a loop can hand it to the lock', () => {
    expect(new TickGuard('x', 10 * 60_000).maxMs).toBe(10 * 60_000);
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

  it('releases the lock when a tick is abandoned, so the next tick re-acquires', async () => {
    const { db, cleanup } = await createTestDb();
    try {
      await expect(
        tryWithAdvisoryLock(db, 'itest:wedge', () => new Promise<void>(() => {}), {
          maxHoldMs: 50,
        })
      ).rejects.toBeInstanceOf(AdvisoryLockWedgedError);

      // The rollback must have taken the advisory lock with it. Before the
      // deadline existed this stayed 1 for the life of the process, and every
      // later tick skipped.
      const res = await db.execute(
        sql`select count(*)::int as held from pg_locks where locktype = 'advisory'`
      );
      const rows = Array.isArray(res) ? res : (res as { rows: unknown[] }).rows;
      expect((rows[0] as { held: number }).held).toBe(0);

      const again = await tryWithAdvisoryLock(db, 'itest:wedge', async () => 'recovered');
      expect(again).toEqual({ acquired: true, result: 'recovered' });
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
