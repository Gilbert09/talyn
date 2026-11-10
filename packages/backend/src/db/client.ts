import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import { debugBus } from '../services/debugBus.js';
import {
  beginInflight,
  endInflight,
  transactionClosed,
  transactionOpened,
  type QueryConnection,
} from './inflight.js';

/**
 * The Drizzle query builder that every service/route consumes. Both the
 * real postgres-js client and the in-process pglite client used by tests
 * satisfy this shape.
 */
export type Database = PostgresJsDatabase<typeof schema>;

interface Handle {
  db: Database;
  /** Underlying connection. Only defined for real Postgres (postgres-js). */
  close: () => Promise<void>;
}

let singleton: Handle | null = null;

/** Size of the postgres-js client pool. The in-flight reporter compares against it. */
export const DB_POOL_MAX = 20;

/**
 * True once the singleton is a real postgres-js handle (vs a test-injected
 * pglite client). RLS owner-scoping only activates against real Postgres —
 * pglite runs as a superuser and has no Supabase `authenticated` role.
 */
let backedByRealPostgres = false;

/**
 * Holds the owner-scoped transaction handle for the duration of a
 * `withOwnerScope(...)` call (see `db/scope.ts`). When set, `getDbClient()`
 * returns it so every query in the request — including those buried in shared
 * services — runs on the same RLS-scoped connection. Empty in background
 * loops, which therefore keep using the pool.
 */
const scopedDbStore = new AsyncLocalStorage<Database>();

/** How long a pool query or `begin` may wait for a free connection. */
export const DB_ACQUIRE_TIMEOUT_MS = 10_000;
export const DB_ACQUIRE_TIMEOUT_CODE = 'DB_POOL_ACQUIRE_TIMEOUT';

/** A pool query or `begin` got no connection in time, so it never ran. */
export class DbAcquireTimeoutError extends Error {
  readonly code = DB_ACQUIRE_TIMEOUT_CODE;
  constructor(readonly timeoutMs: number, options?: { cause?: unknown }) {
    super(`db pool: no connection within ${timeoutMs}ms`, options);
    this.name = 'DbAcquireTimeoutError';
  }
}

/** The parts of a postgres-js `Query` that the acquire deadline reads. */
interface PgQuery {
  /** Null until the query is given to a connection. */
  state: unknown;
  handler: ((q: unknown) => unknown) & { debug?: unknown };
  cancel: () => unknown;
}

function isPgQuery(x: object): x is PgQuery {
  const q = x as Partial<PgQuery>;
  return 'state' in x && typeof q.handler === 'function' && typeof q.cancel === 'function';
}

/** Hooks for the pool that `instrumentEgress` wraps. */
export interface PoolHooks {
  /** Wire to postgres-js `onclose`. */
  connectionClosed: () => void;
}

/** Pull the operation + target table out of a SQL string for a panel label. */
export function summarizeSql(raw: string): { operation: string; table: string | null } {
  const q = raw.replace(/^[\s(]+/, '');
  const operation = (q.match(/^(\w+)/)?.[1] ?? 'query').toUpperCase();
  const table = q.match(/\b(?:from|into|update|join)\s+"?([a-zA-Z_][\w]*)"?/i)?.[1] ?? null;
  return { operation, table };
}

/**
 * Wrap the postgres-js client so every query's result is metered into the
 * Debug panel's DB egress / request tiles. Every Drizzle query funnels through
 * `client.unsafe(query, params)` (see drizzle-orm/postgres-js session), which
 * returns a chainable, thenable pending query. We proxy it so that the eventual
 * settle — whether via `await` or a `.values()`-style chain — estimates the
 * bytes the result pulled back. Measurement is skipped entirely while the panel
 * isn't recording, so the serialize cost is only paid when someone's watching.
 *
 * The same hook records each awaited query in the in-flight registry
 * (`db/inflight.ts`), always, until it settles. postgres-js gives each
 * transaction and savepoint its own `sql` object, so `begin` and `savepoint`
 * are wrapped too: without that, no query inside a transaction (which is every
 * query of an authenticated request) would pass through here.
 */
export function instrumentEgress(
  sql: postgres.Sql,
  connection: QueryConnection = 'pool',
): PoolHooks {
  const original = sql.unsafe.bind(sql) as (
    query: string,
    params?: unknown[],
    options?: unknown,
  ) => object;

  // Pool queries that wait in the postgres-js queue. When a connection closes,
  // postgres-js opens it again for the head of that queue. A cancel of a query
  // that a connection is opening for leaves that connection stuck, so the
  // queries queued at that moment lose their deadline.
  const queued = new Set<PgQuery>();
  const keep = new WeakSet<PgQuery>();

  /**
   * The acquire deadline. postgres-js has none, so a query waits for a free
   * connection forever. A query is cancelled only while it waits in the pool
   * queue: there `cancel()` removes it and rejects it with 57014. On a started
   * query `cancel()` sends a server cancel, which we never do. Queries in a
   * transaction share its connection and get no deadline.
   *
   * The hand-off is watched from creation, because `execute()` (which `begin`
   * uses) can hand the query to the pool before the first `then`.
   */
  const watchAcquire = (q: PgQuery) => {
    let timer: NodeJS.Timeout | null = null;
    let reachedConnection = false;
    const clear = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      queued.delete(q);
    };
    const handOff = q.handler;
    q.handler = Object.assign(
      (x: unknown) => {
        const out = handOff(x);
        // The pool handler returns undefined when it queues the query, and the
        // connection when it opens one for it.
        if (q.state != null || out !== undefined) {
          reachedConnection = true;
          clear();
          return out;
        }
        queued.add(q);
        try {
          let state: unknown = null;
          Object.defineProperty(q, 'state', {
            configurable: true,
            enumerable: true,
            get: () => state,
            set: (v: unknown) => {
              state = v;
              if (v != null) clear();
            },
          });
        } catch {
          // The timer still checks `state` before it cancels.
        }
        return out;
      },
      { debug: handOff.debug },
    );
    const start = (onTimeout: () => void): void => {
      if (timer || reachedConnection || q.state != null) return;
      timer = setTimeout(() => {
        timer = null;
        if (q.state != null || !queued.has(q) || keep.has(q)) return;
        queued.delete(q);
        onTimeout();
        q.cancel();
      }, DB_ACQUIRE_TIMEOUT_MS);
      timer.unref?.();
    };
    return { start, clear };
  };

  const wrapPending = (pending: object, query: string): object => {
    const startedAt = Date.now();
    let counted = false;
    let inflightId: number | null = null;
    let inflightDone = false;
    const acquire = connection === 'pool' && isPgQuery(pending) ? watchAcquire(pending) : null;
    let timedOut = false;
    let timeoutError: DbAcquireTimeoutError | null = null;
    const failure = (err: unknown): unknown => {
      if (!timedOut) return err;
      timeoutError ??= new DbAcquireTimeoutError(DB_ACQUIRE_TIMEOUT_MS, { cause: err });
      return timeoutError;
    };
    const settle = (result: unknown, ok: boolean, err?: unknown): void => {
      acquire?.clear();
      if (inflightId !== null && !inflightDone) {
        inflightDone = true;
        endInflight(inflightId);
      }
      if (counted || !debugBus.isRecording()) return;
      counted = true;
      const { operation, table } = summarizeSql(query);
      let bytes = 0;
      let rows: number | undefined;
      if (ok) {
        if (Array.isArray(result)) rows = result.length;
        try {
          bytes = Buffer.byteLength(
            JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) ?? '',
          );
        } catch {
          bytes = 0;
        }
      }
      debugBus.recordDbQuery({
        operation,
        table,
        durationMs: Date.now() - startedAt,
        ok,
        bytes,
        rows,
        // The raw error, not its message: a drizzle failure says "Failed query:
        // …" and puts the actual reason in `cause`. debugBus walks the chain.
        error: ok ? undefined : err,
      });
    };

    return new Proxy(pending, {
      get(target, prop, receiver) {
        if (prop === 'then') {
          return (
            onFulfilled?: (v: unknown) => unknown,
            onRejected?: (e: unknown) => unknown,
          ) => {
            if (inflightId === null) {
              inflightId = beginInflight('query', query, {
                connection,
                ownerScope: scopedDbStore.getStore() !== undefined,
              });
              acquire?.start(() => {
                timedOut = true;
              });
            }
            return (target as PromiseLike<unknown>).then(
              (result) => {
                settle(result, true);
                return onFulfilled ? onFulfilled(result) : result;
              },
              (raw) => {
                const err = failure(raw);
                settle(undefined, false, err);
                if (onRejected) return onRejected(err);
                throw err;
              },
            );
          };
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            const out = (value as (...a: unknown[]) => unknown).apply(target, args);
            // Chainable builders (`.values()`, `.raw()`, …) return the pending
            // query itself — keep them wrapped so the await is still metered.
            return out === target ? receiver : out;
          };
        }
        return value;
      },
    });
  };

  (sql as unknown as { unsafe: typeof original }).unsafe = (query, params, options) =>
    wrapPending(original(query, params, options), query);

  type ScopeFn = (inner: postgres.Sql) => unknown;
  const instrumentScope = (fn: ScopeFn): ScopeFn => (inner) => {
    instrumentEgress(inner, 'transaction');
    return fn(inner);
  };
  const target = sql as unknown as {
    begin?: (...args: unknown[]) => Promise<unknown>;
    savepoint?: (...args: unknown[]) => Promise<unknown>;
  };

  // `begin(fn)` or `begin(options, fn)`. The callback runs once the
  // transaction holds its connection, and the promise settles after commit
  // or rollback, so that span is what the open-transaction count covers.
  if (connection === 'pool' && typeof target.begin === 'function') {
    const begin = target.begin.bind(sql);
    target.begin = (...args: unknown[]) => {
      const fnIndex = args.length - 1;
      const fn = args[fnIndex];
      if (typeof fn !== 'function') return begin(...args);
      let opened = false;
      const wrapped = instrumentScope((inner) => {
        opened = true;
        transactionOpened();
        return (fn as ScopeFn)(inner);
      });
      const close = () => {
        if (opened) transactionClosed();
      };
      return begin(...args.slice(0, fnIndex), wrapped).then(
        (v) => {
          close();
          return v;
        },
        (e: unknown) => {
          close();
          throw e;
        },
      );
    };
  }

  // A savepoint (drizzle's nested transaction) gets a fresh `sql` object as well.
  if (connection === 'transaction' && typeof target.savepoint === 'function') {
    const savepoint = target.savepoint.bind(sql);
    target.savepoint = (...args: unknown[]) => {
      const fnIndex = args.length - 1;
      const fn = args[fnIndex];
      if (typeof fn !== 'function') return savepoint(...args);
      return savepoint(...args.slice(0, fnIndex), instrumentScope(fn as ScopeFn));
    };
  }

  return {
    connectionClosed: () => {
      for (const q of queued) keep.add(q);
    },
  };
}

/**
 * Initialize a Drizzle client from a DATABASE_URL. Supabase's transaction-
 * mode pooler (port 6543, `pooler.supabase.com`) disables prepared statements,
 * so we detect that and pass `prepare: false` — otherwise every insert fails
 * with "prepared statement does not exist".
 */
function createPostgresHandle(connectionString: string): Handle {
  const url = new URL(connectionString);
  const isPooler = url.hostname.includes('pooler.supabase.com');
  let pool: PoolHooks | null = null;
  const sql = postgres(connectionString, {
    // Headroom so the webhook worker's concurrent batch can't starve everything
    // else of connections — WS auth (a DB upsert with a 5s handshake budget),
    // HTTP requests, and the pollers all share this pool. The Supabase
    // transaction pooler multiplexes, so a larger client pool is fine.
    max: DB_POOL_MAX,
    idle_timeout: 20,
    prepare: !isPooler,
    // Cap how long any single statement can run. Without this a query stuck on
    // the (cross-region) pooler hangs forever, and since the webhook worker
    // awaits a `Promise.all` over the batch, one stuck query wedges the whole
    // consumer with no error. 30s errors it instead — handleEntry catches it,
    // the delivery stays un-acked, and the loop keeps draining.
    //
    // idle_in_transaction_session_timeout is the transaction-shaped twin, and
    // it's what statement_timeout can NOT catch: the ownerScope middleware
    // (middleware/ownerScope.ts) holds an open transaction for the life of
    // every authenticated request, so a handler awaiting a slow GitHub call —
    // or a stalled client — sits idle-in-transaction with no statement
    // running, pinning one of the Supavisor transaction-pooler's backend
    // connections the entire time. Enough of those and the pooler's pool
    // exhausts: every other query (webhook writes, WS auth, the /health
    // probe) queues behind them and dies with ECHECKOUTTIMEOUT after 60s —
    // the 2026-07-04 and 2026-07-06 prod outages. 30s matches
    // statement_timeout: the HTTP p99 is ~150ms, so any request idle in its
    // transaction for 30s is already failed; killing its session frees the
    // backend instead of wedging the whole service. NOTE: startup parameters
    // may not survive every pooler — the same setting should also be pinned
    // role-level in Supabase (ALTER ROLE ... SET idle_in_transaction_session_timeout)
    // as defense in depth.
    connection: { statement_timeout: 30_000, idle_in_transaction_session_timeout: 30_000 },
    // Don't wait forever to acquire a socket either.
    connect_timeout: 15,
    onclose: () => pool?.connectionClosed(),
  });
  pool = instrumentEgress(sql);
  const db = drizzle(sql, { schema, casing: 'snake_case' }) as Database;
  return {
    db,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/** Initialize (once) and return the underlying pool handle's Drizzle client. */
function ensureSingleton(): Database {
  if (singleton) return singleton.db;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Point it at a Postgres (Supabase) instance.'
    );
  }
  singleton = createPostgresHandle(url);
  backedByRealPostgres = true;
  return singleton.db;
}

/**
 * Get the Drizzle client for the current context. Inside a `withOwnerScope`
 * block this is the RLS-scoped transaction handle; everywhere else it's the
 * process-wide pool. Throws if `DATABASE_URL` isn't set — the backend cannot
 * start without Postgres.
 */
export function getDbClient(): Database {
  return scopedDbStore.getStore() ?? ensureSingleton();
}

/**
 * The underlying pool client, ignoring any active owner scope. For background
 * / cross-owner work (pollers, the global PR monitor) that must NOT be
 * RLS-restricted to a single owner even when reached from a scoped request.
 */
export function getPoolDbClient(): Database {
  return ensureSingleton();
}

/** Whether the active client is a real Postgres (vs test pglite). */
export function isRealPostgres(): boolean {
  return backedByRealPostgres;
}

/** The owner-scoped handle if a scope is active, else undefined. */
export function getScopedDb(): Database | undefined {
  return scopedDbStore.getStore();
}

/** Run `fn` with `db` installed as the owner-scoped handle for its async tree. */
export function runInScopedDb<T>(db: Database, fn: () => T): T {
  return scopedDbStore.run(db, fn);
}

/**
 * Run `fn` OUTSIDE any active owner scope, so `getDbClient()` in its async
 * tree resolves to the pool. REQUIRED wherever a request handler schedules
 * fire-and-forget background work (e.g. the merge-queue triggers):
 * AsyncLocalStorage propagates the request's scoped TRANSACTION handle into
 * detached promises, and by the time they run that transaction has committed —
 * every query on the dead handle then hangs or dies with 25P02 (the
 * 2026-07-16 stuck-queue incident, part two).
 */
export function runWithoutScope<T>(fn: () => T): T {
  return scopedDbStore.exit(fn);
}

/**
 * Close the underlying Postgres connection. No-op for test-injected clients
 * (their lifecycle belongs to the test).
 */
export async function closeDbClient(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = null;
  }
}

/**
 * Inject a Drizzle client for tests. The caller owns the connection — we
 * don't close it. Typically paired with `@electric-sql/pglite`.
 */
export function setDbClient(db: Database): void {
  singleton = { db, close: async () => {} };
  backedByRealPostgres = false;
}

/** Clear the process-wide client. Tests call this in afterEach/afterAll. */
export function resetDbClient(): void {
  singleton = null;
  backedByRealPostgres = false;
}
