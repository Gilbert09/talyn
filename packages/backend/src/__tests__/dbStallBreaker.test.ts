import type net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { instrumentEgress, runInScopedDb, type Database } from '../db/client.js';
import { _resetInflight, inflightSize } from '../db/inflight.js';
import {
  DB_STALL_MS,
  DB_STATEMENT_TIMEOUT_MS,
  DbQueryStalledError,
  DbTransactionLostError,
  StallBreaker,
  withStallLimit,
} from '../db/stallBreaker.js';
import { debugBus } from '../services/debugBus.js';

/**
 * A scripted stand-in for postgres-js 3.4.9. It copies the parts the breaker
 * relies on: `Query.active`/`handler`/`reject`, a pool handler that returns the
 * connection (or the queued query), connection objects whose `execute` and
 * `connect` index.js calls through the object, sockets from the `socket`
 * option, and `onclose(id)` after a socket closes.
 */
class FakeQuery {
  active = false;
  resolve!: (v: unknown) => void;
  reject!: (e: unknown) => void;
  private readonly promise: Promise<unknown>;
  private handled = false;
  constructor(
    readonly text: string,
    public handler: (q: unknown) => unknown,
  ) {
    this.promise = new Promise((res, rej) => {
      this.resolve = (v) => {
        this.active = false;
        res(v);
      };
      this.reject = (e) => {
        this.active = false;
        rej(e);
      };
    });
    this.promise.catch(() => {});
  }
  then(a?: (v: unknown) => unknown, b?: (e: unknown) => unknown): Promise<unknown> {
    if (!this.handled) {
      this.handled = true;
      this.handler(this);
    }
    return this.promise.then(a, b);
  }
}

class FakeSocket {
  destroyed = false;
  onDestroy: () => void = () => {};
  connect(): this {
    return this;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.onDestroy();
  }
}

class FakeConn {
  static nextId = 1;
  readonly id = FakeConn.nextId++;
  socket: FakeSocket | null = null;
  current: FakeQuery | null = null;
  sent: FakeQuery[] = [];
  reserved = false;
  /** Queries postgres-js would write to a null socket: a process crash in real life. */
  writesAfterClose = 0;
  onclose: ((e: unknown) => void) | null = null;

  constructor(private readonly pool: FakePool) {}

  // Own properties, like the object literal in connection.js.
  connect = (q: FakeQuery): void => {
    this.socket = this.pool.breaker.socket({ host: ['db'], port: [6543] }) as unknown as FakeSocket;
    this.socket.onDestroy = () => this.closed();
    this.write(q);
  };
  execute = (q: FakeQuery): boolean => this.write(q);

  private write(q: FakeQuery): boolean {
    if (!this.socket) {
      this.writesAfterClose += 1;
      return true;
    }
    if (this.current) this.sent.push(q);
    else {
      this.current = q;
      q.active = true;
    }
    return true;
  }

  reply(value: unknown = []): void {
    const q = this.current;
    if (!q) throw new Error('nothing in flight');
    this.current = this.sent.shift() ?? null;
    if (this.current) this.current.active = true;
    q.resolve(value);
  }

  private closed(): void {
    const err = Object.assign(new Error('write CONNECTION_CLOSED db:6543'), {
      code: 'CONNECTION_CLOSED',
    });
    for (const q of [this.current, ...this.sent]) q?.reject(err);
    this.current = null;
    this.sent = [];
    this.socket = null;
    this.reserved = false;
    this.pool.breaker.connectionClosed(this.id);
    this.onclose?.(err);
    this.onclose = null;
    const next = this.pool.queue.shift();
    if (next) this.connect(next);
  }
}

class FakePool {
  conns: FakeConn[] = [];
  queue: FakeQuery[] = [];
  readonly sql: postgres.Sql;
  private readonly connOf = new WeakMap<FakeQuery, FakeConn>();

  constructor(
    readonly breaker: StallBreaker,
    private readonly max = 2,
  ) {
    const handler = (q: unknown): unknown => {
      const query = q as FakeQuery;
      const open = this.conns.find((c) => c.socket && !c.current && !c.reserved);
      if (open) {
        open.execute(query);
        this.connOf.set(query, open);
        return open;
      }
      const closed = this.conns.find((c) => !c.socket);
      if (closed || this.conns.length < this.max) {
        const c = closed ?? new FakeConn(this);
        if (!closed) this.conns.push(c);
        c.connect(query);
        this.connOf.set(query, c);
        return c;
      }
      this.queue.push(query);
      return query;
    };
    const sql = {
      unsafe: (text: string) => new FakeQuery(text, handler),
      // postgres-js `begin`: BEGIN through `sql.unsafe`, then a scope whose
      // own commit/rollback use the scope handler.
      begin: async (fn: (inner: unknown) => unknown) => {
        const bq = sql.unsafe('begin') as unknown as PromiseLike<unknown>;
        await bq;
        const c = this.conns.find((x) => x.socket && x.current === null && !x.reserved)!;
        c.reserved = true;
        const scopeHandler = (q: unknown) => c.execute(q as FakeQuery);
        const inner = { unsafe: (text: string) => new FakeQuery(text, scopeHandler) };
        const scope = (async () => {
          try {
            const result = await fn(inner);
            await new FakeQuery('commit', scopeHandler);
            return result;
          } catch (e) {
            await new FakeQuery('rollback', scopeHandler);
            throw e;
          }
        })();
        try {
          return await Promise.race([
            scope,
            new Promise((_, reject) => {
              c.onclose = reject;
            }),
          ]);
        } finally {
          c.reserved = false;
        }
      },
    };
    this.sql = sql as unknown as postgres.Sql;
  }
}

const flush = () => new Promise((r) => setImmediate(r));

let logs: string[];
let warns: string[];

function setup(opts: { stallMs?: number; max?: number } = {}) {
  const breaker = new StallBreaker({
    stallMs: opts.stallMs,
    log: (l) => logs.push(l),
    warn: (l) => warns.push(l),
    newSocket: () => new FakeSocket() as unknown as net.Socket,
  });
  const pool = new FakePool(breaker, opts.max);
  instrumentEgress(pool.sql, 'pool', { breaker });
  const unsafe = (text: string) => pool.sql.unsafe(text) as unknown as PromiseLike<unknown>;
  return { breaker, pool, unsafe };
}

/** Attach handlers now, so a rejection is never "unhandled" while timers run. */
function settled(p: PromiseLike<unknown>) {
  const out: { value?: unknown; error?: unknown; done: boolean } = { done: false };
  Promise.resolve(p).then(
    (v) => Object.assign(out, { value: v, done: true }),
    (e) => Object.assign(out, { error: e, done: true }),
  );
  return out;
}

beforeEach(() => {
  logs = [];
  warns = [];
  _resetInflight();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('stall limits', () => {
  it('is the role-level statement timeout plus a 15 s margin', () => {
    expect(DB_STATEMENT_TIMEOUT_MS).toBe(120_000);
    expect(DB_STALL_MS).toBe(135_000);
  });
});

describe('StallBreaker on the pool', () => {
  it('closes the connection of a query with no reply after STALL_MS', async () => {
    const record = vi.spyOn(debugBus, 'recordDbQuery');
    vi.spyOn(debugBus, 'isRecording').mockReturnValue(true);
    const { pool, unsafe } = setup();
    const r = settled(unsafe('select "id" from "pr_code_review_runs" where "id" = $1'));
    await flush();
    const conn = pool.conns[0]!;
    const socket = conn.socket!;
    expect(inflightSize()).toBe(1);

    vi.advanceTimersByTime(DB_STALL_MS - 1);
    await flush();
    expect(r.done).toBe(false);
    expect(socket.destroyed).toBe(false);

    vi.advanceTimersByTime(1);
    await flush();
    expect(socket.destroyed).toBe(true);
    expect(r.error).toBeInstanceOf(DbQueryStalledError);
    const err = r.error as DbQueryStalledError;
    expect(err.code).toBe('DB_QUERY_STALLED');
    expect(err.message).toBe(`db: no reply for ${DB_STALL_MS}ms; closed the connection`);
    expect((err.cause as { code: string }).code).toBe('CONNECTION_CLOSED');
    expect(logs).toEqual([
      `[db] connection stalled ${DB_STALL_MS / 1000}s, closed it: select "pr_code_review_runs" (pool)`,
    ]);
    expect(inflightSize()).toBe(0);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, table: 'pr_code_review_runs', error: err }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['at once', 0],
    ['1 ms before the limit', DB_STALL_MS - 1],
  ])('does not trip when the reply arrives %s', async (_name, after) => {
    const { pool, unsafe } = setup();
    const r = settled(unsafe('select 1 from "tasks"'));
    await flush();
    vi.advanceTimersByTime(after);
    pool.conns[0]!.reply([{ x: 1 }]);
    await flush();
    expect(r.value).toEqual([{ x: 1 }]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(DB_STALL_MS * 2);
    await flush();
    expect(pool.conns[0]!.socket!.destroyed).toBe(false);
    expect(logs).toEqual([]);
  });

  it('times a pipelined query from when it becomes active, not from when it was sent', async () => {
    const { pool } = setup();
    let a: ReturnType<typeof settled> | null = null;
    let b: ReturnType<typeof settled> | null = null;
    const p = settled(
      pool.sql.begin(async (tx) => {
        const qa = tx.unsafe('select 1 from "a"') as unknown as PromiseLike<unknown>;
        const qb = tx.unsafe('select 1 from "b"') as unknown as PromiseLike<unknown>;
        a = settled(qa);
        b = settled(qb);
        await Promise.allSettled([qa, qb]);
      }),
    );
    await flush();
    const conn = pool.conns[0]!;
    conn.reply(); // BEGIN
    await flush();
    expect(conn.sent).toHaveLength(1);

    vi.advanceTimersByTime(40_000);
    conn.reply(['a']); // "b" becomes active now
    await flush();
    expect(a!.value).toEqual(['a']);
    vi.advanceTimersByTime(DB_STALL_MS - 1);
    await flush();
    expect(b!.done).toBe(false);
    vi.advanceTimersByTime(1);
    await flush();
    await flush();
    expect(b!.error).toBeInstanceOf(DbQueryStalledError);
    expect(p.error).toBe(b!.error);
  });

  it('opens a new connection for the next query after a trip', async () => {
    const { pool, unsafe } = setup({ max: 1 });
    const r = settled(unsafe('select 1 from "a"'));
    await flush();
    const firstSocket = pool.conns[0]!.socket!;
    vi.advanceTimersByTime(DB_STALL_MS);
    await flush();
    expect(r.error).toBeInstanceOf(DbQueryStalledError);

    const next = settled(unsafe('select 1 from "b"'));
    await flush();
    expect(pool.conns).toHaveLength(1);
    expect(pool.conns[0]!.socket).not.toBe(firstSocket);
    pool.conns[0]!.reply([1]);
    await flush();
    expect(next.value).toEqual([1]);
  });

  it('closes a connection that postgres-js opened again from its queue', async () => {
    const { pool, unsafe } = setup({ max: 1 });
    const a = settled(unsafe('select 1 from "a"'));
    await flush();
    const b = settled(unsafe('select 1 from "b"'));
    await flush();
    expect(pool.queue).toHaveLength(1);
    vi.advanceTimersByTime(DB_STALL_MS);
    await flush();
    expect(a.error).toBeInstanceOf(DbQueryStalledError);
    // The close reconnected the connection for "b", which now also stalls.
    const second = pool.conns[0]!.socket!;
    expect(second.destroyed).toBe(false);
    vi.advanceTimersByTime(DB_STALL_MS);
    await flush();
    expect(second.destroyed).toBe(true);
    expect(b.error).toBeInstanceOf(DbQueryStalledError);
    expect(logs).toHaveLength(2);
  });
});

describe('StallBreaker in a transaction', () => {
  it('trips a transaction query, rejects the begin with the stall, and never writes to the closed connection', async () => {
    const { pool } = setup();
    let late: unknown;
    let inner: unknown;
    const p = settled(
      runInScopedDb({} as Database, () =>
        pool.sql.begin(async (tx) => {
          try {
            await tx.unsafe('select "id" from "integrations"');
          } catch (e) {
            inner = e;
          }
          try {
            await tx.unsafe('select 2');
          } catch (e) {
            late = e;
          }
          throw inner;
        }),
      ),
    );
    await flush();
    const conn = pool.conns[0]!;
    conn.reply(); // BEGIN
    await flush();
    expect(conn.current).not.toBeNull();

    vi.advanceTimersByTime(DB_STALL_MS);
    await flush();
    await flush();

    expect(inner).toBeInstanceOf(DbQueryStalledError);
    expect(late).toBe(inner);
    expect(p.error).toBe(inner);
    expect(conn.writesAfterClose).toBe(0);
    expect(logs).toEqual([
      `[db] connection stalled ${DB_STALL_MS / 1000}s, closed it: select "integrations" (owner scope)`,
    ]);
    expect(inflightSize()).toBe(0);
  });

  it('rejects later queries with DbTransactionLostError when the server closed the connection', async () => {
    const { pool } = setup();
    let first: unknown;
    let late: unknown;
    const p = settled(
      pool.sql.begin(async (tx) => {
        try {
          await tx.unsafe('select 1');
        } catch (e) {
          first = e;
        }
        try {
          await tx.unsafe('select 2');
        } catch (e) {
          late = e;
        }
      }),
    );
    await flush();
    const conn = pool.conns[0]!;
    conn.reply(); // BEGIN
    await flush();
    conn.socket!.destroy(); // the server or the network closed it
    await flush();
    await flush();
    expect((first as { code: string }).code).toBe('CONNECTION_CLOSED');
    expect(late).toBeInstanceOf(DbTransactionLostError);
    expect((p.error as { code: string }).code).toBe('CONNECTION_CLOSED');
    // The commit after the callback was refused too.
    expect(conn.writesAfterClose).toBe(0);
  });
});

describe('StallBreaker exclusions', () => {
  it('does not watch queries under withStallLimit(null)', async () => {
    const { pool, unsafe } = setup();
    const r = settled(withStallLimit(null, () => unsafe('create index "x" on "tasks" ("id")')));
    await flush();
    vi.advanceTimersByTime(10 * 60_000);
    await flush();
    expect(r.done).toBe(false);
    expect(pool.conns[0]!.socket!.destroyed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([60_000, 200_000])('uses a longer limit of %i ms when the scope sets one', async (limit) => {
    const { pool, unsafe } = setup();
    const r = settled(withStallLimit(limit, () => unsafe('select 1 from "a"')));
    await flush();
    const socket = pool.conns[0]!.socket!;
    vi.advanceTimersByTime(limit - 1);
    await flush();
    expect(r.done).toBe(false);
    vi.advanceTimersByTime(1);
    await flush();
    expect(socket.destroyed).toBe(true);
    expect((r.error as Error).message).toBe(`db: no reply for ${limit}ms; closed the connection`);
  });
});

describe('StallBreaker with unknown internals', () => {
  it('turns itself off with one warning when a query has another shape', async () => {
    const { breaker } = setup();
    const plain = { then: (a: (v: unknown) => unknown) => Promise.resolve([]).then(a) };
    const sql = { unsafe: vi.fn(() => plain) } as unknown as postgres.Sql;
    instrumentEgress(sql, 'pool', { breaker });
    await expect(sql.unsafe('select 1', [])).resolves.toEqual([]);
    await expect(sql.unsafe('select 2', [])).resolves.toEqual([]);
    expect(breaker.enabled).toBe(false);
    expect(warns).toEqual(['[db] stall breaker off: a query does not have the postgres-js 3.4 shape']);
  });

  it('warns once and does nothing when it cannot find the connection', async () => {
    const breaker = new StallBreaker({ log: (l) => logs.push(l), warn: (l) => warns.push(l) });
    // A handler that runs the query but returns no connection.
    const queries: FakeQuery[] = [];
    const handler = (q: unknown) => {
      (q as FakeQuery).active = true;
      queries.push(q as FakeQuery);
      return undefined;
    };
    const sql = { unsafe: (t: string) => new FakeQuery(t, handler) } as unknown as postgres.Sql;
    instrumentEgress(sql, 'pool', { breaker });
    const a = settled(sql.unsafe('select 1', []));
    const b = settled(sql.unsafe('select 2', []));
    await flush();
    vi.advanceTimersByTime(DB_STALL_MS);
    await flush();
    expect(a.done).toBe(false);
    expect(b.done).toBe(false);
    expect(logs).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('could not find its connection');
    queries.forEach((q) => q.resolve([]));
  });

  it('leaves a sql object without a breaker exactly as before', async () => {
    const q = new FakeQuery('select 1', () => undefined);
    const sql = { unsafe: vi.fn(() => q) } as unknown as postgres.Sql;
    instrumentEgress(sql);
    const p = sql.unsafe('select 1', []);
    q.resolve([1]);
    await expect(p).resolves.toEqual([1]);
    expect(Object.getOwnPropertyDescriptor(q, 'active')?.get).toBeUndefined();
  });
});
