import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getPoolDbClient, isRealPostgres, type Database } from '../db/client.js';

/**
 * Postgres advisory-lock guards for the side-effectful poll loops.
 *
 * Every Railway deploy briefly runs TWO backend instances (old draining, new
 * booting). The in-process TickGuard only prevents re-entry within one
 * process, so during that overlap the dispatch/merge/auto-merge/poller/sweep
 * loops all double-fire — double task dispatches, double merge attempts.
 * A `pg_try_advisory_xact_lock` per tick makes the database the arbiter:
 * whichever instance grabs the lock runs the tick, the other skips it.
 *
 * **Why xact-scoped (not session-scoped) locks:** production connects through
 * Supabase's transaction-mode pooler, where consecutive statements on one
 * client connection can land on different server sessions — a session-level
 * `pg_advisory_lock` acquired by one statement is untouchable (and leaks) by
 * the next. Transaction-scoped locks are pinned to the transaction, which the
 * pooler binds to a single server connection until commit, so they are the
 * only advisory flavour that is safe here. The cost: the guard holds an
 * otherwise-idle transaction open for the tick's duration (one pooled
 * connection out of 20 — fine for five slow loops).
 *
 * **Why the pass-through off real Postgres:** the pglite test harness runs a
 * single WASM connection whose `transaction()` takes an exclusive mutex —
 * wrapping a tick (whose inner queries go through `getDbClient()`, i.e. the
 * same client) would self-deadlock. Cross-replica exclusion is meaningless in
 * a single-process test anyway, so `guardCrossReplica` simply runs the tick.
 * The SQL path itself is unit-tested against a scripted Database.
 */

/** Stable signed-64-bit lock key derived from a loop name. */
export function advisoryLockKey(name: string): bigint {
  return createHash('sha256').update(name).digest().readBigInt64BE(0);
}

export interface LockOutcome<T> {
  acquired: boolean;
  result?: T;
}

/** Normalize `db.execute` results across drivers (postgres-js returns an
 *  array-like RowList, pglite returns `{ rows }`). */
function firstRow(res: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(res)) return res[0] as Record<string, unknown> | undefined;
  const rows = (res as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows[0] as Record<string, unknown>) : undefined;
}

/**
 * Run `fn` while holding the transaction-scoped advisory lock for `name`;
 * skip it (acquired: false) when another session already holds the lock.
 * The lock transaction is a pure mutex — `fn`'s own queries run on whatever
 * connection/scope they normally use, NOT inside this transaction.
 */
export async function tryWithAdvisoryLock<T>(
  db: Database,
  name: string,
  fn: () => Promise<T>
): Promise<LockOutcome<T>> {
  const key = advisoryLockKey(name).toString();
  return db.transaction(async (tx) => {
    const res = await tx.execute(
      sql`select pg_try_advisory_xact_lock(${key}::bigint) as acquired`
    );
    if (!firstRow(res)?.acquired) return { acquired: false };
    return { acquired: true, result: await fn() };
  });
}

/**
 * Blocking variant: WAIT for the lock instead of skipping. Used by the boot
 * migrator, where the second instance must queue behind the first's
 * migration run (then no-op), never race it or skip it.
 */
export async function withBlockingAdvisoryLock<T>(
  db: Database,
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = advisoryLockKey(name).toString();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${key}::bigint)`);
    return fn();
  });
}

/**
 * Loop-tick entry point: cross-replica try-lock against real Postgres,
 * plain pass-through everywhere else (tests / pglite — see module docs).
 */
export async function guardCrossReplica<T>(
  name: string,
  fn: () => Promise<T>
): Promise<LockOutcome<T>> {
  if (!isRealPostgres()) {
    return { acquired: true, result: await fn() };
  }
  return tryWithAdvisoryLock(getPoolDbClient(), name, fn);
}
