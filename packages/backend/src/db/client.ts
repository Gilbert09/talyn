import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import { debugBus } from '../services/debugBus.js';

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
 */
export function instrumentEgress(sql: postgres.Sql): void {
  const original = sql.unsafe.bind(sql) as (
    query: string,
    params?: unknown[],
    options?: unknown,
  ) => object;

  const wrapPending = (pending: object, query: string): object => {
    const startedAt = Date.now();
    let counted = false;
    const settle = (result: unknown, ok: boolean, err?: unknown): void => {
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
        error: ok ? undefined : err instanceof Error ? err.message : err ? String(err) : undefined,
      });
    };

    return new Proxy(pending, {
      get(target, prop, receiver) {
        if (prop === 'then') {
          return (
            onFulfilled?: (v: unknown) => unknown,
            onRejected?: (e: unknown) => unknown,
          ) =>
            (target as PromiseLike<unknown>).then(
              (result) => {
                settle(result, true);
                return onFulfilled ? onFulfilled(result) : result;
              },
              (err) => {
                settle(undefined, false, err);
                if (onRejected) return onRejected(err);
                throw err;
              },
            );
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
  const sql = postgres(connectionString, {
    max: 10,
    idle_timeout: 20,
    prepare: !isPooler,
  });
  instrumentEgress(sql);
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
