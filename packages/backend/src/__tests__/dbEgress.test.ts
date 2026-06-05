import { describe, it, expect, beforeEach, vi } from 'vitest';
import type postgres from 'postgres';
import { instrumentEgress, summarizeSql } from '../db/client.js';
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
