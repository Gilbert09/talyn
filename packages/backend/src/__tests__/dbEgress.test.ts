import { describe, it, expect, beforeEach, vi } from 'vitest';
import type postgres from 'postgres';
import { instrumentEgress, runInScopedDb, summarizeSql, type Database } from '../db/client.js';
import {
  _resetInflight,
  inflightCounts,
  inflightEntries,
  inflightSize,
  transactionOpened,
} from '../db/inflight.js';
import { debugBus } from '../services/debugBus.js';

/**
 * Unit tests for the DB egress meter that wraps the postgres-js client. The
 * proxy is the delicate part: it must measure a query's result whether it's
 * consumed by a plain `await` or by a chained `.values()` (Drizzle uses both),
 * count each query exactly once, still execute when recording is off (just
 * without measuring), and survive un-serializable rows.
 */

/**
 * Faithful stand-in for a postgres-js PendingQuery: a thenable whose `.then`
 * triggers (and counts) execution, with a chainable `.values()` that returns
 * `this` — exactly the shape `instrumentEgress` relies on.
 */
function fakePending(result: unknown, opts: { rejectWith?: Error } = {}) {
  let executions = 0;
  const pending = {
    get executions() {
      return executions;
    },
    values() {
      return pending; // chainable — returns `this`
    },
    raw() {
      return pending;
    },
    then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      executions += 1;
      const settled = opts.rejectWith
        ? Promise.reject(opts.rejectWith)
        : Promise.resolve(result);
      return settled.then(onFulfilled, onRejected);
    },
  };
  return pending;
}

/** Build a minimal `sql` whose `unsafe` hands back our fake pending query. */
function fakeSql(pending: ReturnType<typeof fakePending>) {
  const sql = { unsafe: vi.fn(() => pending) };
  return sql as unknown as postgres.Sql;
}

beforeEach(() => {
  debugBus._reset();
  debugBus.setEnabled(true);
  _resetInflight();
});

describe('summarizeSql', () => {
  it.each([
    ['select "id" from "tasks" where "status" = $1', 'SELECT', 'tasks'],
    ['SELECT * FROM tasks', 'SELECT', 'tasks'],
    ['insert into "pull_requests" ("id") values ($1)', 'INSERT', 'pull_requests'],
    ['update "tasks" set "status" = $1', 'UPDATE', 'tasks'],
    ['delete from "environments" where "id" = $1', 'DELETE', 'environments'],
    ['  (select 1)', 'SELECT', null],
  ])('parses %s', (sql, operation, table) => {
    expect(summarizeSql(sql)).toEqual({ operation, table });
  });
});

describe('instrumentEgress', () => {
  it('meters a plain awaited query once with row + byte estimates', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const pending = fakePending(rows);
    const sql = fakeSql(pending);
    instrumentEgress(sql);

    const result = await sql.unsafe('select "id" from "tasks"', []);

    expect(result).toBe(rows); // wrapping is transparent to the caller
    expect(pending.executions).toBe(1);
    const stats = debugBus.snapshot().dbStats;
    expect(stats.requests).toBe(1);
    expect(stats.egressBytes).toBe(Buffer.byteLength(JSON.stringify(rows)));
    const [e] = debugBus.getEvents();
    expect(e.category).toBe('db');
    expect(e.summary).toContain('SELECT tasks');
    expect(e.meta).toMatchObject({ table: 'tasks', rows: 2 });
  });

  it('meters a chained .values() query exactly once', async () => {
    const rows = [['a'], ['b'], ['c']];
    const pending = fakePending(rows);
    const sql = fakeSql(pending);
    instrumentEgress(sql);

    const result = await (sql.unsafe('select 1 from "tasks"', []) as { values(): PromiseLike<unknown> }).values();

    expect(result).toBe(rows);
    expect(pending.executions).toBe(1);
    expect(debugBus.snapshot().dbStats.requests).toBe(1);
  });

  it('still executes — but records nothing — while recording is off', async () => {
    debugBus.setEnabled(false);
    const pending = fakePending([{ id: 'a' }]);
    const sql = fakeSql(pending);
    instrumentEgress(sql);

    await sql.unsafe('select "id" from "tasks"', []);

    expect(pending.executions).toBe(1);
    debugBus.setEnabled(true);
    expect(debugBus.getEvents()).toHaveLength(0);
    expect(debugBus.snapshot().dbStats).toEqual({ requests: 0, egressBytes: 0 });
  });

  it('records a rejected query as a failure with no egress and re-throws', async () => {
    const pending = fakePending(null, { rejectWith: new Error('connection reset') });
    const sql = fakeSql(pending);
    instrumentEgress(sql);

    await expect(sql.unsafe('select 1 from "tasks"', [])).rejects.toThrow('connection reset');
    const stats = debugBus.snapshot().dbStats;
    expect(stats).toEqual({ requests: 1, egressBytes: 0 });
    const [e] = debugBus.getEvents();
    expect(e.ok).toBe(false);
    expect(e.meta?.error).toBe('connection reset');
  });

  it('does not throw on un-serializable rows (e.g. BigInt) — counts 0 bytes', async () => {
    const rows = [{ id: 'a', count: 10n }];
    const pending = fakePending(rows);
    const sql = fakeSql(pending);
    instrumentEgress(sql);

    await sql.unsafe('select count(*) from "tasks"', []);

    // BigInt is coerced to a string by the replacer, so it serializes fine.
    expect(debugBus.snapshot().dbStats.requests).toBe(1);
    expect(debugBus.snapshot().dbStats.egressBytes).toBeGreaterThan(0);
  });
});

/** A pending query that settles only when the test says so. */
function controlledPending() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const settled = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  settled.catch(() => undefined);
  const pending = {
    values() {
      return pending;
    },
    raw() {
      return pending;
    },
    cursor() {
      return 'cursor-handle';
    },
    then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      return settled.then(onFulfilled, onRejected);
    },
  };
  return { pending, resolve, reject };
}

describe('instrumentEgress in-flight registry', () => {
  it.each([
    ['recording on', true],
    ['recording off', false],
  ])('holds an entry from the await until it resolves (%s)', async (_name, recording) => {
    debugBus.setEnabled(recording);
    const { pending, resolve } = controlledPending();
    const sql = fakeSql(pending as never);
    instrumentEgress(sql);

    const q = sql.unsafe('select "id" from "pull_requests" where "id" = $1', ['secret']);
    expect(inflightSize()).toBe(0); // not awaited yet
    const awaited = Promise.resolve(q);
    await Promise.resolve();
    const [entry] = inflightEntries();
    expect(entry).toMatchObject({ kind: 'query', connection: 'pool', ownerScope: false });
    expect(JSON.stringify(entry)).not.toContain('secret');
    resolve([{ id: 1 }]);
    await awaited;
    expect(inflightSize()).toBe(0);
  });

  it('removes the entry when the query rejects', async () => {
    const { pending, reject } = controlledPending();
    const sql = fakeSql(pending as never);
    instrumentEgress(sql);

    const awaited = Promise.resolve(sql.unsafe('select 1 from "tasks"', []));
    await Promise.resolve();
    expect(inflightSize()).toBe(1);
    reject(new Error('connection reset'));
    await expect(awaited).rejects.toThrow('connection reset');
    expect(inflightSize()).toBe(0);
  });

  it.each([
    ['values', (q: Record<string, () => PromiseLike<unknown>>) => q.values()],
    ['raw', (q: Record<string, () => PromiseLike<unknown>>) => q.raw()],
    ['values then raw', (q: Record<string, () => Record<string, () => PromiseLike<unknown>>>) => q.values().raw()],
  ])('a chained .%s() is tracked once and removed', async (_name, chain) => {
    const rows = [['a']];
    const pending = fakePending(rows);
    const sql = fakeSql(pending);
    instrumentEgress(sql);

    const result = await chain(sql.unsafe('select 1 from "tasks"', []) as never);
    expect(result).toBe(rows);
    expect(pending.executions).toBe(1);
    expect(inflightSize()).toBe(0);
  });

  it('passes a non-chainable method result through untouched', () => {
    const { pending } = controlledPending();
    const sql = fakeSql(pending as never);
    instrumentEgress(sql);
    const q = sql.unsafe('select 1', []) as unknown as { cursor(): unknown };
    expect(q.cursor()).toBe('cursor-handle');
    expect(inflightSize()).toBe(0);
  });

  it('a query awaited twice is one entry, removed on settle', async () => {
    const { pending, resolve } = controlledPending();
    const sql = fakeSql(pending as never);
    instrumentEgress(sql);
    const q = sql.unsafe('select 1', []);
    const a = Promise.resolve(q);
    const b = Promise.resolve(q);
    await Promise.resolve();
    expect(inflightSize()).toBe(1);
    resolve([]);
    await Promise.all([a, b]);
    expect(inflightSize()).toBe(0);
  });

  it.each([
    ['inside', true],
    ['outside', false],
  ])('marks a query awaited %s an owner scope', async (_name, scoped) => {
    const { pending, resolve } = controlledPending();
    const sql = fakeSql(pending as never);
    instrumentEgress(sql);
    const start = () => awaitNow(sql.unsafe('select 1 from "tasks"', []));
    const awaited = scoped ? runInScopedDb({} as Database, start) : start();
    expect(inflightEntries()[0]?.ownerScope).toBe(scoped);
    resolve([]);
    await awaited;
    expect(inflightSize()).toBe(0);
  });
});

/** A `sql` with postgres-js-shaped `begin` / `savepoint`: each scope gets a
 *  fresh inner `sql` whose `unsafe` is not instrumented. */
function fakeTxSql(opts: { failBegin?: boolean; failInside?: boolean } = {}) {
  const makeInner = (): Record<string, unknown> => {
    const inner: Record<string, unknown> = {
      unsafe: vi.fn(() => fakePending([{ ok: 1 }])),
    };
    inner.savepoint = vi.fn(async (fn: (s: unknown) => unknown) => fn(makeInner()));
    return inner;
  };
  const root: Record<string, unknown> = {
    unsafe: vi.fn(() => fakePending([])),
    begin: vi.fn(async (...args: unknown[]) => {
      if (opts.failBegin) throw new Error('connect timeout');
      const fn = args[args.length - 1] as (s: unknown) => Promise<unknown>;
      return fn(makeInner());
    }),
  };
  return root as unknown as postgres.Sql & {
    begin: ReturnType<typeof vi.fn>;
  };
}

describe('instrumentEgress transactions', () => {
  it.each([
    ['begin(fn)', [] as string[]],
    ['begin(options, fn)', ['isolation level serializable']],
  ])('%s tracks queries inside the transaction and the open count', async (_name, options) => {
    const sql = fakeTxSql();
    const rawBegin = sql.begin;
    instrumentEgress(sql);
    let during: ReturnType<typeof inflightCounts> | undefined;
    const out = await (sql.begin as (...a: unknown[]) => Promise<unknown>)(
      ...options,
      async (tx: postgres.Sql) => {
        const awaited = awaitNow(tx.unsafe('update "tasks" set "status" = $1', ['x']));
        during = inflightCounts();
        await awaited;
        return 'committed';
      },
    );
    expect(out).toBe('committed');
    expect(during).toMatchObject({ queries: 1, poolQueries: 0, openTransactions: 1 });
    expect(inflightCounts()).toMatchObject({ queries: 0, openTransactions: 0 });
    // The options argument reaches postgres-js unchanged.
    expect(rawBegin.mock.calls[0].slice(0, -1)).toEqual(options);
  });

  it('closes the open count when the transaction callback throws', async () => {
    const sql = fakeTxSql();
    instrumentEgress(sql);
    await expect(
      (sql.begin as (fn: (tx: postgres.Sql) => Promise<unknown>) => Promise<unknown>)(async () => {
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(inflightCounts().openTransactions).toBe(0);
  });

  it('does not count a transaction whose begin failed before it opened', async () => {
    const sql = fakeTxSql({ failBegin: true });
    instrumentEgress(sql);
    transactionOpenedBy(2);
    await expect(
      (sql.begin as (fn: () => Promise<unknown>) => Promise<unknown>)(async () => 1),
    ).rejects.toThrow('connect timeout');
    expect(inflightCounts().openTransactions).toBe(2);
  });

  it('tracks queries inside a savepoint (a nested drizzle transaction)', async () => {
    const sql = fakeTxSql();
    instrumentEgress(sql);
    let during = 0;
    await (sql.begin as (fn: (tx: postgres.Sql) => Promise<unknown>) => Promise<unknown>)(
      async (tx) =>
        (tx as unknown as { savepoint: (fn: (s: postgres.Sql) => Promise<unknown>) => Promise<unknown> }).savepoint(
          async (sp) => {
            const awaited = awaitNow(sp.unsafe('select 1 from "tasks"', []));
            during = inflightEntries().filter((e) => e.connection === 'transaction').length;
            await awaited;
          },
        ),
    );
    expect(during).toBe(1);
    expect(inflightSize()).toBe(0);
    expect(inflightCounts().openTransactions).toBe(0);
  });
});

function transactionOpenedBy(n: number): void {
  for (let i = 0; i < n; i++) transactionOpened();
}

/** Call `then` now, the way `await` does, so the entry exists synchronously. */
function awaitNow(q: unknown): Promise<unknown> {
  return new Promise((res, rej) => (q as PromiseLike<unknown>).then(res, rej));
}
