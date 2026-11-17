import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import {
  closeDbClient,
  getPoolDbClient,
  instrumentEgress,
  resetLateTransactionQuerySites,
  useRealPostgresForTests,
} from '../db/client.js';
import { _resetInflight, inflightCounts, inflightSize } from '../db/inflight.js';
import { withOwnerScope } from '../db/scope.js';
import {
  DbQueryStalledError,
  DbTransactionEndedError,
  DbTransactionLostError,
  DbTransactionStalledError,
  OWNER_SCOPE_IDLE_MS,
  StallBreaker,
  withStallLimit,
  withTransactionPolicy,
} from '../db/stallBreaker.js';
import { startFakePgServer, type FakePgServer } from './helpers/fakePgServer.js';

/**
 * The 2026-11-17 outage, against REAL postgres-js 3.4 and a wire-protocol
 * test server. The scripted pool in dbStallBreaker.test.ts runs every query of
 * a transaction on its connection at once, so it could not show the gap:
 * postgres-js parks a transaction's query in a private queue while the
 * connection is `full`, and a query there is never active, so the query timer
 * never starts.
 *
 * Each "postgres-js alone" case runs without `instrumentEgress` and shows the
 * hang. The case after it shows what the breaker does now.
 */

const STALL_MS = 200;
/** Long enough that a hang is a hang: several stall limits. */
const HANG_MS = STALL_MS * 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Settled {
  done: boolean;
  value?: unknown;
  error?: unknown;
  at?: number;
}

/** Attach handlers now, so that a rejection is never "unhandled" while the test waits. */
function settled(p: PromiseLike<unknown>): Settled {
  const out: Settled = { done: false };
  Promise.resolve(p).then(
    (value) => Object.assign(out, { value, done: true, at: Date.now() }),
    (error) => Object.assign(out, { error, done: true, at: Date.now() }),
  );
  return out;
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(5);
  }
}

let server: FakePgServer;
let logs: string[];
let clients: postgres.Sql[];

beforeEach(async () => {
  server = await startFakePgServer();
  logs = [];
  clients = [];
  _resetInflight();
  resetLateTransactionQuerySites();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.end({ timeout: 0 })));
  await closeDbClient();
  await server.close();
  vi.restoreAllMocks();
});

function newBreaker(): StallBreaker {
  return new StallBreaker({
    stallMs: STALL_MS,
    log: (l) => logs.push(l),
    warn: (l) => logs.push(l),
  });
}

/** A real postgres-js pool. `instrumented`: with the egress hook and the breaker, as in production. */
function pool(opts: { max?: number; instrumented?: boolean } = {}) {
  const breaker = newBreaker();
  const sql = postgres(server.url, {
    max: opts.max ?? 1,
    prepare: false,
    fetch_types: false,
    ...(opts.instrumented === false
      ? {}
      : { ...({ socket: breaker.socket } as object), onclose: breaker.connectionClosed }),
  });
  if (opts.instrumented !== false) instrumentEgress(sql, 'pool', { breaker });
  clients.push(sql);
  return { sql, breaker };
}

/** A statement that the server answers only when the test says so. */
function holdStatements(match: RegExp): { release: () => void } {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  server.onStatement = (s) => (match.test(s.sql) ? held : undefined);
  return { release: () => release() };
}

/** Run a transaction and hand back its `sql`, so the test can send on it after it ended. */
async function endedTransaction(sql: postgres.Sql): Promise<postgres.Sql> {
  let kept: postgres.Sql | undefined;
  await sql.begin(async (tx) => {
    kept = tx;
    await tx.unsafe('select 1 from "tasks" where "id" = $1', [1]);
  });
  return kept!;
}

/**
 * Make the server end the transaction on the statement that matches, as if
 * the pooler had: it answers COMMIT and then ReadyForQuery "idle". postgres-js
 * then gives the connection back to the pool while the transaction goes on.
 */
function serverEndsTransactionOn(match: RegExp): void {
  server.onStatement = (s) => {
    if (match.test(s.sql)) s.sql = 'commit';
  };
}

describe('a query sent on a transaction that already ended', () => {
  it('postgres-js alone: waits forever when the connection is full', async () => {
    const { sql } = pool({ instrumented: false });
    const tx = await endedTransaction(sql);
    const held = holdStatements(/"held"/);
    const busy = settled(sql.unsafe('select 1 from "held" where "id" = $1', [1]));
    await sleep(20);
    const late = settled(tx.unsafe('select 1 from "integrations" where "id" = $1', [1]));
    await sleep(20);
    held.release();
    await until(() => busy.done);
    await sleep(HANG_MS);
    expect(late.done).toBe(false);
    expect(server.statements.map((s) => s.sql)).not.toContain(
      'select 1 from "integrations" where "id" = $1',
    );
  });

  it('postgres-js alone: runs outside the transaction when the connection is idle', async () => {
    const { sql } = pool({ instrumented: false });
    const tx = await endedTransaction(sql);
    await tx.unsafe('select 1 from "integrations" where "id" = $1', [1]);
    const late = server.statements.find((s) => s.sql.includes('"integrations"'));
    // Status "I": no transaction, so no `set local role` and no RLS.
    expect(late?.status).toBe('I');
  });

  it.each([
    ['the connection is full', true],
    ['the connection is idle', false],
  ])('rejects at once and sends nothing when %s', async (_name, full) => {
    const { sql } = pool();
    const tx = await endedTransaction(sql);
    const held = holdStatements(/"held"/);
    const busy = full ? settled(sql.unsafe('select 1 from "held" where "id" = $1', [1])) : null;
    await sleep(20);
    const started = Date.now();
    const late = settled(tx.unsafe('select 1 from "integrations" where "id" = $1', [1]));
    await until(() => late.done, 100);
    expect(late.error).toBeInstanceOf(DbTransactionEndedError);
    // At once: well before any stall limit could have fired.
    expect(late.at! - started).toBeLessThan(STALL_MS);
    held.release();
    if (busy) await until(() => busy.done);
    expect(server.statements.some((s) => s.sql.includes('"integrations"'))).toBe(false);
    expect(inflightSize()).toBe(0);
  });

  it('rejects a late savepoint and a late query in a savepoint', async () => {
    const { sql } = pool();
    let tx: postgres.Sql | undefined;
    let sp: postgres.Sql | undefined;
    await sql.begin(async (t) => {
      tx = t;
      await (t as unknown as { savepoint: (fn: (s: postgres.Sql) => Promise<void>) => Promise<void> }).savepoint(
        async (s) => {
          sp = s;
        },
      );
    });
    await expect(
      (tx as unknown as { savepoint: (fn: () => Promise<void>) => Promise<void> }).savepoint(async () => {}),
    ).rejects.toBeInstanceOf(DbTransactionEndedError);
    await expect(sp!.unsafe('select 1 from "tasks" where "id" = $1', [1])).rejects.toBeInstanceOf(
      DbTransactionEndedError,
    );
  });

  it('still runs a query of a savepoint whose body is open while its parent is open', async () => {
    const { sql } = pool();
    const out = await sql.begin(async (t) =>
      (t as unknown as { savepoint: (fn: (s: postgres.Sql) => unknown) => Promise<unknown> }).savepoint(
        (s) => s.unsafe('select 1 from "tasks" where "id" = $1', [1]),
      ),
    );
    expect(out).toEqual([]);
  });
});

describe('queries that wait in the transaction queue when the connection closes', () => {
  // `allSettled` for postgres-js alone: with `all`, its ROLLBACK goes to the
  // closed connection and crashes the process (the guard in stallBreaker.ts).
  async function stuckFirst(sql: postgres.Sql, wait: 'all' | 'allSettled' = 'all') {
    server.onStatement = (s) => (s.sql.includes('"stuck"') ? 'stall' : undefined);
    const qs: Settled[] = [];
    const begin = settled(
      sql.begin(async (tx) => {
        const ps = ['stuck', 'integrations', 'pull_requests'].map((t) =>
          tx.unsafe(`select 1 from "${t}" where "id" = $1`, [1]),
        );
        const all = wait === 'all' ? Promise.all(ps) : Promise.allSettled(ps);
        ps.forEach((p) => qs.push(settled(p)));
        await all;
      }),
    );
    return { begin, qs };
  }

  it('postgres-js alone: the queued ones never settle', async () => {
    const { sql } = pool({ instrumented: false });
    const { qs } = await stuckFirst(sql, 'allSettled');
    await sleep(50);
    // Close the connection the way the breaker does.
    for (const socket of server.sockets.values()) socket.destroy();
    await sleep(HANG_MS);
    expect(qs[0]!.done).toBe(true);
    expect(qs.slice(1).map((q) => q.done)).toEqual([false, false]);
  });

  it('rejects every one of them with the stall error', async () => {
    const { sql } = pool();
    const { begin, qs } = await stuckFirst(sql);
    await until(() => begin.done && qs.every((q) => q.done));
    expect(begin.error).toBeInstanceOf(DbQueryStalledError);
    for (const q of qs) expect(q.error).toBeInstanceOf(DbQueryStalledError);
    expect(logs).toEqual([
      `[db] connection stalled ${Math.round(STALL_MS / 1000)}s, closed it: select "stuck" (transaction)`,
    ]);
    expect(inflightSize()).toBe(0);
    expect(inflightCounts().openTransactions).toBe(0);
  });
});

describe('a transaction whose connection went back to the pool without a close', () => {
  async function releasedWithQueued(sql: postgres.Sql) {
    serverEndsTransactionOn(/"ender"/);
    let queued: Settled | undefined;
    const begin = settled(
      sql.begin(async (tx) => {
        // A query with parameters moves the connection to postgres-js's `full`
        // queue, so the next query of the transaction waits in its private queue.
        const ender = tx.unsafe('select 1 from "ender" where "id" = $1', [1]);
        const next = tx.unsafe('select 1 from "integrations" where "id" = $1', [1]);
        // Hands them to postgres-js in this order: a query runs only once awaited.
        const both = Promise.all([ender, next]);
        queued = settled(next);
        await both;
      }),
    );
    await sleep(20);
    return { begin, queued: () => queued! };
  }

  it('postgres-js alone: the queued query is never active and never settles', async () => {
    const { sql } = pool({ instrumented: false });
    const { begin, queued } = await releasedWithQueued(sql);
    await sleep(HANG_MS);
    expect(queued().done).toBe(false);
    expect(begin.done).toBe(false);
    // The connection serves the pool again.
    await expect(sql.unsafe('select 1 from "tasks" where "id" = $1', [1])).resolves.toEqual([]);
  });

  it('ends the transaction after the stall limit and leaves the connection to the pool', async () => {
    const { sql } = pool();
    const started = Date.now();
    const { begin, queued } = await releasedWithQueued(sql);
    await until(() => begin.done && queued().done);
    expect(queued().error).toBeInstanceOf(DbTransactionStalledError);
    expect((queued().error as DbTransactionStalledError).reason).toBe('stuck');
    expect(begin.error).toBe(queued().error);
    expect(begin.at! - started).toBeGreaterThanOrEqual(STALL_MS - 20);
    expect(begin.at! - started).toBeLessThan(HANG_MS);
    expect(logs).toEqual([
      '[db] transaction stalled 0s (queries waited with no reply), it did not hold its connection: transaction',
    ]);
    expect(inflightSize()).toBe(0);
    expect(inflightCounts().openTransactions).toBe(0);
    // The breaker did not close a connection that now serves someone else.
    await expect(sql.unsafe('select 1 from "tasks" where "id" = $1', [1])).resolves.toEqual([]);
  });

  it('postgres-js alone: the next query runs outside the transaction', async () => {
    const { sql } = pool({ instrumented: false });
    serverEndsTransactionOn(/"ender"/);
    await sql.begin(async (tx) => {
      await tx.unsafe('select 1 from "ender" where "id" = $1', [1]);
      await tx.unsafe('select 1 from "integrations" where "id" = $1', [1]);
    });
    expect(server.statements.find((s) => s.sql.includes('"integrations"'))?.status).toBe('I');
  });

  it('rejects the next query before postgres-js sends it', async () => {
    const { sql } = pool();
    serverEndsTransactionOn(/"ender"/);
    const begin = settled(
      sql.begin(async (tx) => {
        await tx.unsafe('select 1 from "ender" where "id" = $1', [1]);
        await tx.unsafe('select 1 from "integrations" where "id" = $1', [1]);
      }),
    );
    await until(() => begin.done);
    expect(begin.error).toBeInstanceOf(DbTransactionLostError);
    expect((begin.error as DbTransactionLostError).how).toBe('released');
    expect(server.statements.some((s) => s.sql.includes('"integrations"'))).toBe(false);
    expect(logs).toEqual(['[db] transaction lost its connection without a close: transaction']);
    expect(inflightSize()).toBe(0);
  });
});

describe('COMMIT and ROLLBACK with no reply', () => {
  it('postgres-js alone: the begin never settles', async () => {
    const { sql } = pool({ instrumented: false });
    server.onStatement = (s) => (/^commit/i.test(s.sql) ? 'stall' : undefined);
    const begin = settled(sql.begin((tx) => tx.unsafe('select 1 from "tasks" where "id" = $1', [1])));
    await sleep(HANG_MS);
    expect(begin.done).toBe(false);
  });

  it.each([
    ['commit', /^commit/i, async () => undefined],
    [
      'rollback',
      /^rollback/i,
      async () => {
        throw new Error('handler failed');
      },
    ],
  ])('ends the transaction when its %s has no reply, and closes the connection', async (_n, match, body) => {
    const { sql } = pool();
    server.onStatement = (s) => (match.test(s.sql) ? 'stall' : undefined);
    const begin = settled(
      sql.begin(async (tx) => {
        await tx.unsafe('select 1 from "tasks" where "id" = $1', [1]);
        await body();
      }),
    );
    await until(() => begin.done);
    expect(begin.error).toBeInstanceOf(DbTransactionStalledError);
    expect((begin.error as DbTransactionStalledError).reason).toBe('commit');
    expect(logs).toEqual([
      '[db] transaction stalled 0s (the commit or rollback had no reply), closed its connection: transaction',
    ]);
    expect(inflightCounts().openTransactions).toBe(0);
    server.onStatement = () => undefined;
    await expect(sql.unsafe('select 1 from "tasks" where "id" = $1', [1])).resolves.toEqual([]);
  });

  it('does not watch a transaction begun with the stall limit off (the boot migrator)', async () => {
    const { sql } = pool();
    server.onStatement = (s) => (/^commit/i.test(s.sql) ? 'stall' : undefined);
    const begin = settled(
      withStallLimit(null, () => sql.begin((tx) => tx.unsafe('select 1 from "tasks" where "id" = $1', [1]))),
    );
    await sleep(HANG_MS);
    expect(begin.done).toBe(false);
    expect(logs).toEqual([]);
  });
});

describe('the idle limit', () => {
  const idleTx = (sql: postgres.Sql, idleLimitMs: number, body: (tx: postgres.Sql) => Promise<unknown>) =>
    withTransactionPolicy({ label: 'GET /api/v1/skills', idleLimitMs }, () => sql.begin(body));

  it('ends a transaction with no query in flight for the limit', async () => {
    const { sql } = pool();
    const started = Date.now();
    let after: Settled | undefined;
    const begin = settled(
      idleTx(sql, STALL_MS, async (tx) => {
        await tx.unsafe('select 1 from "tasks" where "id" = $1', [1]);
        await sleep(HANG_MS); // a GitHub call with the transaction open
        after = settled(tx.unsafe('select 1 from "integrations" where "id" = $1', [1]));
        await after;
      }),
    );
    await until(() => begin.done);
    expect(begin.error).toBeInstanceOf(DbTransactionStalledError);
    expect((begin.error as DbTransactionStalledError).reason).toBe('idle');
    expect(begin.at! - started).toBeLessThan(HANG_MS);
    expect(logs).toEqual([
      '[db] transaction stalled 0s (no query was in flight), closed its connection: GET /api/v1/skills',
    ]);
    await until(() => after?.done === true);
    expect(after!.error).toBe(begin.error);
    expect(server.statements.some((s) => s.sql.includes('"integrations"'))).toBe(false);
  });

  it('keeps a transaction whose queries keep it busy past the limit', async () => {
    const { sql } = pool();
    const out = await idleTx(sql, STALL_MS, async (tx) => {
      for (let i = 0; i < 8; i++) {
        await tx.unsafe('select 1 from "tasks" where "id" = $1', [i]);
        await sleep(STALL_MS / 4);
      }
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(logs).toEqual([]);
  });

  it('does not count a slow query as idle time', async () => {
    const { sql } = pool();
    const held = holdStatements(/"slow"/);
    const begin = settled(idleTx(sql, STALL_MS / 2, (tx) => tx.unsafe('select 1 from "slow" where "id" = $1', [1])));
    await sleep(STALL_MS - 50);
    held.release();
    await until(() => begin.done);
    expect(begin.error).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it('applies to the begin inside the policy only, not to a transaction its body opens', async () => {
    const { sql, breaker } = pool({ max: 2 });
    const spy = vi.spyOn(breaker, 'newTransaction');
    await idleTx(sql, STALL_MS, async () => {
      await sql.begin((tx) => tx.unsafe('select 1 from "tasks" where "id" = $1', [1]));
    });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      { label: 'GET /api/v1/skills', stallMs: STALL_MS, idleLimitMs: STALL_MS },
      { label: undefined, stallMs: STALL_MS, idleLimitMs: null },
    ]);
  });
});

describe('withOwnerScope on real postgres-js', () => {
  it('opens its transaction with the request label and the owner-scope idle limit', async () => {
    const breaker = newBreaker();
    const spy = vi.spyOn(breaker, 'newTransaction');
    useRealPostgresForTests(server.url, {
      breaker,
      options: { max: 2, prepare: false, fetch_types: false },
    });
    const out = await withOwnerScope(
      'user-1',
      async (db) => {
        await db.execute(dsql`select 1 from "tasks" where "id" = ${1}`);
        // A pool transaction from inside the request gets no idle limit.
        await getPoolDbClient().transaction(async (tx) => {
          await tx.execute(dsql`select 1 from "tasks" where "id" = ${2}`);
        });
        return 'done';
      },
      'GET /api/v1/skills',
    );
    expect(out).toBe('done');
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      { label: 'GET /api/v1/skills', stallMs: STALL_MS, idleLimitMs: OWNER_SCOPE_IDLE_MS },
      { label: undefined, stallMs: STALL_MS, idleLimitMs: null },
    ]);
    const roleSet = server.statements.find((s) => s.sql === 'set local role talyn_backend');
    expect(roleSet?.status).toBe('T');
  });

  it('a request query queued behind a lost connection fails the request instead of hanging', async () => {
    useRealPostgresForTests(server.url, {
      breaker: newBreaker(),
      options: { max: 1, prepare: false, fetch_types: false },
    });
    serverEndsTransactionOn(/"ender"/);
    const req = settled(
      withOwnerScope(
        'user-1',
        async (db) => {
          await Promise.all([
            db.execute(dsql`select 1 from "ender" where "id" = ${1}`),
            db.execute(dsql`select 1 from "integrations" where "id" = ${1}`),
          ]);
        },
        'GET /api/v1/cloud-providers',
      ),
    );
    await until(() => req.done);
    expect((req.error as { cause?: unknown }).cause ?? req.error).toBeInstanceOf(
      DbTransactionStalledError,
    );
    expect(inflightSize()).toBe(0);
    expect(logs).toEqual([
      '[db] transaction stalled 0s (queries waited with no reply), it did not hold its connection: GET /api/v1/cloud-providers',
    ]);
  });
});
