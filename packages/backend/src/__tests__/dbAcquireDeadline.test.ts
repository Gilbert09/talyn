import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import {
  DB_ACQUIRE_TIMEOUT_CODE,
  DB_ACQUIRE_TIMEOUT_MS,
  DbAcquireTimeoutError,
  instrumentEgress,
} from '../db/client.js';
import { _resetInflight, inflightSize } from '../db/inflight.js';
import { debugBus } from '../services/debugBus.js';

/**
 * The pool acquire deadline. The scripted pool copies how postgres-js 3.4.9
 * hands a query off (src/index.js `handler`, `cancel`): a query with a free
 * connection starts at once (`state` set), a query with none waits in the pool
 * queue (`state` null, handler returns undefined), and a query that a new
 * connection is opened for waits as that connection's first query (`state`
 * null, handler returns the connection). `cancel()` on a waiting query removes
 * it and rejects with 57014; on a started one it would send a server cancel.
 */

type Mode = 'start' | 'queue' | 'connect';

interface FakeQuery {
  text: string;
  state: unknown;
  cancelled: unknown;
  executed: boolean;
  handler: (q: FakeQuery) => unknown;
  cancel: () => void;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  execute: () => FakeQuery;
  values: () => FakeQuery;
  then: (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise<unknown>;
}

function scriptedPool() {
  let mode: Mode = 'queue';
  const queue: FakeQuery[] = [];
  const serverCancels: FakeQuery[] = [];
  const created: FakeQuery[] = [];

  function handler(q: FakeQuery): unknown {
    if (mode === 'start') {
      q.state = { pid: 1 };
      return { id: 'open' };
    }
    if (mode === 'connect') return { id: 'connecting' };
    queue.push(q);
    return undefined;
  }

  function cancel(q: FakeQuery): void {
    if (q.state) {
      serverCancels.push(q);
      return;
    }
    const i = queue.indexOf(q);
    if (i >= 0) queue.splice(i, 1);
    q.cancelled = true;
    q.reject(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
  }

  function makeQuery(text: string, queryHandler: (q: FakeQuery) => unknown = handler): FakeQuery {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((a, b) => {
      resolve = a;
      reject = b;
    });
    promise.catch(() => undefined);
    const q: FakeQuery = {
      text,
      state: null,
      cancelled: null,
      executed: false,
      handler: queryHandler,
      cancel: () => cancel(q),
      resolve: (v) => resolve(v),
      reject: (e) => reject(e),
      execute: () => {
        void handle();
        return q;
      },
      values: () => q,
      then: (f, r) => {
        void handle();
        return promise.then(f, r);
      },
    };
    async function handle(): Promise<void> {
      if (q.executed) return;
      q.executed = true;
      await 1;
      q.handler(q);
    }
    created.push(q);
    return q;
  }

  /** Queries inside a transaction queue on its own connection, forever here. */
  const txQueued: FakeQuery[] = [];
  const sql = {
    unsafe: vi.fn((text: string) => makeQuery(text)),
    begin: async (fn: (inner: postgres.Sql) => unknown) => {
      await (sql.unsafe('begin') as unknown as PromiseLike<unknown>);
      const inner = {
        unsafe: vi.fn((text: string) =>
          makeQuery(text, (q) => {
            txQueued.push(q);
            return undefined;
          }),
        ),
      };
      return fn(inner as unknown as postgres.Sql);
    },
  };

  return {
    sql: sql as unknown as postgres.Sql,
    queue,
    serverCancels,
    created,
    txQueued,
    setMode: (m: Mode) => {
      mode = m;
    },
    /** A connection frees up and takes the head of the queue. */
    startHead: (): FakeQuery => {
      const q = queue.shift()!;
      q.state = { pid: 2 };
      return q;
    },
  };
}

const query = (sql: postgres.Sql, text = 'select "id" from "tasks"') =>
  (sql.unsafe(text) as unknown as PromiseLike<unknown>);

let baseTimers = 0;

beforeEach(() => {
  vi.useFakeTimers();
  debugBus._reset();
  debugBus.setEnabled(true);
  _resetInflight();
  baseTimers = vi.getTimerCount();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('pool acquire deadline', () => {
  it('cancels a query still in the pool queue after the deadline and records it', async () => {
    const pool = scriptedPool();
    instrumentEgress(pool.sql);
    const record = vi.spyOn(debugBus, 'recordDbQuery');
    const result = Promise.resolve(query(pool.sql)).then(
      () => 'resolved',
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(DB_ACQUIRE_TIMEOUT_MS - 1);
    expect(pool.queue).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    const err = await result;
    expect(err).toBeInstanceOf(DbAcquireTimeoutError);
    expect(err).toMatchObject({
      code: DB_ACQUIRE_TIMEOUT_CODE,
      message: `db pool: no connection within ${DB_ACQUIRE_TIMEOUT_MS}ms`,
      cause: { code: '57014' },
    });
    expect(pool.queue).toHaveLength(0);
    expect(pool.serverCancels).toHaveLength(0);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ ok: false, table: 'tasks' });
    expect(record.mock.calls[0][0].error).toBe(err);
    expect(inflightSize()).toBe(0);
    expect(vi.getTimerCount()).toBe(baseTimers);
  });

  it('gives a cancelled pool query the same error on every then', async () => {
    const pool = scriptedPool();
    instrumentEgress(pool.sql);
    const pending = query(pool.sql);
    const a = Promise.resolve(pending).catch((e: unknown) => e);
    const b = Promise.resolve(pending).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DB_ACQUIRE_TIMEOUT_MS);
    expect(await a).toBeInstanceOf(DbAcquireTimeoutError);
    expect(await b).toBe(await a);
  });

  it('never cancels a query that started at once, and clears its timer', async () => {
    const pool = scriptedPool();
    pool.setMode('start');
    instrumentEgress(pool.sql);
    const result = Promise.resolve(query(pool.sql));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(baseTimers);
    await vi.advanceTimersByTimeAsync(DB_ACQUIRE_TIMEOUT_MS * 6);
    pool.created[0].resolve([{ id: 1 }]);
    await expect(result).resolves.toEqual([{ id: 1 }]);
    expect(pool.serverCancels).toHaveLength(0);
    expect(pool.created[0].cancelled).toBeNull();
  });

  it('clears the timer when a queued query starts, and never cancels it', async () => {
    const pool = scriptedPool();
    instrumentEgress(pool.sql);
    const result = Promise.resolve(query(pool.sql));
    await vi.advanceTimersByTimeAsync(DB_ACQUIRE_TIMEOUT_MS / 2);
    expect(vi.getTimerCount()).toBe(baseTimers + 1);
    const started = pool.startHead();
    expect(vi.getTimerCount()).toBe(baseTimers);
    await vi.advanceTimersByTimeAsync(DB_ACQUIRE_TIMEOUT_MS * 6);
    started.resolve([]);
    await expect(result).resolves.toEqual([]);
    expect(pool.serverCancels).toHaveLength(0);
    expect(started.cancelled).toBeNull();
  });

  it('never cancels a query that a new connection is opening for', async () => {
    const pool = scriptedPool();
    pool.setMode('connect');
    instrumentEgress(pool.sql);
    const result = Promise.resolve(query(pool.sql));
    await vi.advanceTimersByTimeAsync(DB_ACQUIRE_TIMEOUT_MS * 6);
    expect(pool.created[0].cancelled).toBeNull();
    pool.created[0].state = { pid: 3 };
    pool.created[0].resolve('late');
    await expect(result).resolves.toBe('late');
    expect(vi.getTimerCount()).toBe(baseTimers);
  });

  it('never cancels the queries that waited when a connection closed', async () => {
    const pool = scriptedPool();
    const hooks = instrumentEgress(pool.sql);
    const before = Promise.resolve(query(pool.sql));
    await vi.advanceTimersByTimeAsync(1_000);
    hooks.connectionClosed();
    const after = Promise.resolve(query(pool.sql)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DB_ACQUIRE_TIMEOUT_MS);

    expect(await after).toBeInstanceOf(DbAcquireTimeoutError);
    expect(pool.created[0].cancelled).toBeNull();
    const head = pool.startHead();
    expect(head).toBe(pool.created[0]);
    head.resolve('kept');
    await expect(before).resolves.toBe('kept');
  });

  it('never cancels a query inside a transaction', async () => {
    const pool = scriptedPool();
    pool.setMode('start');
    instrumentEgress(pool.sql);
    let inner: Promise<unknown> | null = null;
    void pool.sql.begin(async (tx) => {
      inner = Promise.resolve(tx.unsafe('select 1') as unknown as PromiseLike<unknown>);
      return inner;
    });
    await vi.advanceTimersByTimeAsync(0);
    pool.created[0].resolve([]);
    await vi.advanceTimersByTimeAsync(DB_ACQUIRE_TIMEOUT_MS * 6);
    expect(pool.txQueued).toHaveLength(1);
    expect(pool.txQueued[0].cancelled).toBeNull();
    expect(vi.getTimerCount()).toBe(baseTimers);
    pool.txQueued[0].resolve('done');
    await expect(inner).resolves.toBe('done');
  });

  it('rejects a begin that got no connection with the deadline error', async () => {
    const pool = scriptedPool();
    instrumentEgress(pool.sql);
    const body = vi.fn();
    const begun = pool.sql.begin(body).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DB_ACQUIRE_TIMEOUT_MS);
    expect(await begun).toBeInstanceOf(DbAcquireTimeoutError);
    expect(body).not.toHaveBeenCalled();
    expect(pool.queue).toHaveLength(0);
  });

  it('applies to a query handed off by execute() before the first then', async () => {
    const pool = scriptedPool();
    instrumentEgress(pool.sql);
    const pending = pool.sql.unsafe('begin') as unknown as FakeQuery;
    const result = Promise.resolve(pending.execute()).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(DB_ACQUIRE_TIMEOUT_MS);
    expect(await result).toBeInstanceOf(DbAcquireTimeoutError);
  });
});
