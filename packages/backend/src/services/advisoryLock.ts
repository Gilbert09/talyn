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
 * **Why the lock has its own deadline (the 2026-09-16 incident):** `fn()` runs
 * INSIDE the lock transaction, so a tick whose await never settles keeps that
 * transaction open and the xact lock held for as long as the process lives.
 * The loop's own `TickGuard` watchdog force-releases its in-process flag after
 * `maxTickMs` and then ticks again — but every one of those ticks fails
 * `pg_try_advisory_xact_lock` against its OWN zombie transaction and skips,
 * logging "held by another instance". The result is a loop that is permanently
 * dead while reporting healthy contention: task dispatch and the cloud poller
 * both stopped for good on 2026-09-16 this way, and only a redeploy cleared it.
 * So the lock enforces `maxHoldMs` itself, in two independent layers:
 *   1. a JS deadline that rejects, unwinding the transaction so the lock frees
 *      on the very next tick;
 *   2. `SET LOCAL idle_in_transaction_session_timeout`, so Postgres kills the
 *      session even if Node is too wedged to roll back. This is set per
 *      transaction with `set_config`, NOT relied on from the connection's
 *      startup parameters — those do not survive every pooler (see the NOTE in
 *      db/client.ts), which is why the pool-level twin did not save us. Note
 *      this RAISES the pool's 30s setting for the lock transaction alone, on
 *      purpose: that transaction is idle for the whole tick by design, and a
 *      tick legitimately runs for minutes. The ceiling is now the loop's real
 *      budget instead of a number that was never reaching the server anyway.
 * Callers pass their `TickGuard`'s own budget, so the two watchdogs cannot
 * disagree about how long a tick is allowed to take.
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
 * Default ceiling on how long one tick may hold its lock. Matches
 * `TickGuard`'s default `maxTickMs` — callers with a different budget pass
 * their guard's own value so the two watchdogs agree by construction.
 */
export const DEFAULT_MAX_LOCK_HOLD_MS = 5 * 60_000;

/**
 * Extra time the Postgres-side backstop allows over the JS deadline, so the
 * clean unwind normally wins the race and the DB kill really is a last resort.
 */
const DB_BACKSTOP_GRACE_MS = 30_000;

/** Thrown when a tick overran `maxHoldMs` and had its lock taken back. */
export class AdvisoryLockWedgedError extends Error {
  constructor(
    readonly lockName: string,
    readonly heldMs: number
  ) {
    super(
      `[advisoryLock] "${lockName}" tick exceeded ${heldMs}ms and was abandoned — ` +
        'rolling back to release the lock so the loop can run again'
    );
    this.name = 'AdvisoryLockWedgedError';
  }
}

/**
 * Lock names whose transaction this process currently holds open.
 *
 * Purely diagnostic, and it earns its keep: a skip on a name in this set is
 * proof that the holder is one of OUR OWN wedged ticks, not a second replica.
 * The whole 2026-09-16 outage looked like ordinary contention because nothing
 * could tell those apart.
 */
const heldLocks = new Set<string>();

/** Reject `promise` once `ms` elapses; the abandoned work keeps running, but
 *  the caller (and the transaction it sits in) is free of it. */
async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  name: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AdvisoryLockWedgedError(name, ms)), ms);
    // Never hold the event loop open just to police a tick.
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export interface AdvisoryLockOptions {
  /** Hard ceiling on the tick's runtime. See DEFAULT_MAX_LOCK_HOLD_MS. */
  maxHoldMs?: number;
}

/**
 * Run `fn` while holding the transaction-scoped advisory lock for `name`;
 * skip it (acquired: false) when another session already holds the lock.
 * The lock transaction is a pure mutex — `fn`'s own queries run on whatever
 * connection/scope they normally use, NOT inside this transaction.
 *
 * A tick that overruns `maxHoldMs` is abandoned with an
 * `AdvisoryLockWedgedError`, which unwinds the transaction and hands the lock
 * back. That is deliberately LOUDER than skipping: the tick's work is
 * half-done, and every loop here is written to be re-run.
 */
export async function tryWithAdvisoryLock<T>(
  db: Database,
  name: string,
  fn: () => Promise<T>,
  opts: AdvisoryLockOptions = {}
): Promise<LockOutcome<T>> {
  const key = advisoryLockKey(name).toString();
  const maxHoldMs = opts.maxHoldMs ?? DEFAULT_MAX_LOCK_HOLD_MS;
  return db.transaction(async (tx) => {
    // Postgres-side backstop, set per transaction rather than trusted from the
    // connection's startup parameters (a pooler may drop those). `set_config`
    // rather than a bare SET because SET takes no bind parameters. The
    // transaction sits IDLE in transaction for the whole tick — `fn`'s queries
    // run on other connections — so this, not statement_timeout, is the
    // setting that can reach it.
    await tx.execute(
      sql`select set_config('idle_in_transaction_session_timeout', ${String(
        maxHoldMs + DB_BACKSTOP_GRACE_MS
      )}, true)`
    );
    const res = await tx.execute(
      sql`select pg_try_advisory_xact_lock(${key}::bigint) as acquired`
    );
    if (!firstRow(res)?.acquired) {
      if (heldLocks.has(name)) {
        console.error(
          `[advisoryLock] "${name}" is held by a tick in THIS process that has not ` +
            'finished — the loop is wedged, not contended by another replica'
        );
      }
      return { acquired: false };
    }
    heldLocks.add(name);
    try {
      return { acquired: true, result: await withDeadline(fn(), maxHoldMs, name) };
    } finally {
      heldLocks.delete(name);
    }
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
  fn: () => Promise<T>,
  opts: AdvisoryLockOptions = {}
): Promise<LockOutcome<T>> {
  if (!isRealPostgres()) {
    return { acquired: true, result: await fn() };
  }
  return tryWithAdvisoryLock(getPoolDbClient(), name, fn, opts);
}
