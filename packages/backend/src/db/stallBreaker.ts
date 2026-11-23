/**
 * The stall breaker: close a database connection that gives no reply.
 *
 * On 2026-11-10 the pool lost connections one at a time to queries that never
 * settled: no rows, no error, for 30+ minutes, although the server ends every
 * statement after the statement timeout. So the connection was dead or stalled,
 * and postgres-js has no timer of its own for this. When enough connections
 * were gone, every query queued and the watchdog restarted the process.
 *
 * The breaker starts a timer when a query becomes the ACTIVE query on its
 * connection (the server works on it, or the earlier queries in the pipeline
 * got their replies). If the query has no reply after `stallMs`, the breaker
 * destroys that connection's socket. That is the same path as a network error
 * in postgres-js: it rejects the query and its pipeline, moves the connection
 * to its `closed` queue and opens it again on demand.
 *
 * To find the socket, the breaker gives postgres-js its sockets through the
 * documented `socket` option, and it learns which connection opened each one
 * with an AsyncLocalStorage "lineage". It reads three fields of postgres-js
 * internals: `Query.active`, `Query.handler` and the connection object that the
 * pool handler returns. Each read is checked. When the shape is not as
 * expected, the breaker turns itself off with one warning.
 *
 * Transactions need one more guard. postgres-js crashes the process when a
 * transaction sends a query after its connection closed: it writes to a null
 * socket in a `setImmediate` (`Cannot read properties of null (reading
 * 'write')`). So the breaker rejects every query of a transaction whose
 * connection closed after it began, before postgres-js can send it. This also
 * covers a connection that the server or the network closed.
 *
 * The query timer cannot see most of a transaction (2026-11-17). postgres-js
 * gives each transaction a private queue. While the connection is in its
 * `full` queue (after any query with parameters), new queries of the
 * transaction wait in that private queue, and they become active only when a
 * ReadyForQuery reaches the transaction. A query there is never active, so it
 * gets no timer. Nothing rejects that queue when the connection closes or
 * when the transaction lets the connection go, so its queries wait forever.
 * COMMIT, ROLLBACK and SAVEPOINT do not pass through `sql.unsafe`, so they get
 * no timer either. So the breaker also watches each TRANSACTION:
 *  - "stuck": queries of the transaction wait, none is active, and nothing
 *    moved for `stallMs`;
 *  - "commit": the body settled, and the COMMIT or ROLLBACK did not end the
 *    transaction in `stallMs`;
 *  - "idle" (opt in, owner-scope requests only): no query of the
 *    transaction is in flight for `idleLimitMs`.
 * Then it closes the connection (when the transaction still holds it),
 * rejects every waiting query of the transaction, and rejects the `begin`.
 * A transaction that lost its connection without a close (postgres-js gave
 * the connection back to the pool on a ReadyForQuery "idle") also has its
 * next query rejected before postgres-js sends it outside the transaction.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import net from 'node:net';

/**
 * The statement timeout that applies in production. Supavisor's transaction
 * pooler drops the startup parameter that sets 30 s, so the role-level 2 min
 * applies. Verified through the pooler on 2026-11-10.
 */
export const DB_STATEMENT_TIMEOUT_MS = 120_000;
/** Time for the network and for the server to send the timeout error. */
export const DB_STALL_MARGIN_MS = 15_000;
/** A started query with no reply for this long is on a dead connection. */
export const DB_STALL_MS = DB_STATEMENT_TIMEOUT_MS + DB_STALL_MARGIN_MS;
export const DB_QUERY_STALLED_CODE = 'DB_QUERY_STALLED';
export const DB_TRANSACTION_LOST_CODE = 'DB_TRANSACTION_LOST';
export const DB_TRANSACTION_STALLED_CODE = 'DB_TRANSACTION_STALLED';
export const DB_TRANSACTION_ENDED_CODE = 'DB_TRANSACTION_ENDED';

/**
 * How long an owner-scope request transaction may wait with no query in
 * flight. It holds a pool connection and a Supavisor server connection the
 * whole time. Request p99 is about 150 ms. The longest single wait on another
 * service in a route below `ownerScope` is the fleet create call (45 s,
 * CREATE_TIMEOUT_MS); GitHub calls stop at 30 s. Routes that wait longer (the
 * 10-minute sandbox resume, Polar, Slack) are mounted before `ownerScope`, and
 * no SSE route runs below it. So the limit is the same as for a query with no
 * reply: the statement timeout plus the margin. This also puts back the 30 s
 * `idle_in_transaction_session_timeout` intent, which Supavisor drops.
 */
export const OWNER_SCOPE_IDLE_MS = DB_STALL_MS;

/** A started query got no reply in time, so the breaker closed its connection. */
export class DbQueryStalledError extends Error {
  readonly code = DB_QUERY_STALLED_CODE;
  constructor(
    readonly stallMs: number,
    options?: { cause?: unknown },
  ) {
    super(`db: no reply for ${stallMs}ms; closed the connection`, options);
    this.name = 'DbQueryStalledError';
  }
}

/**
 * A query of a transaction that lost its connection. It was not sent.
 * `closed`: the connection closed. `released`: postgres-js gave the connection
 * back to the pool while the transaction still used it.
 */
export class DbTransactionLostError extends Error {
  readonly code = DB_TRANSACTION_LOST_CODE;
  constructor(readonly how: 'closed' | 'released' = 'closed') {
    super(
      how === 'closed'
        ? 'db: the connection of this transaction closed; the query was not sent'
        : 'db: this transaction lost its connection to the pool; the query was not sent',
    );
    this.name = 'DbTransactionLostError';
  }
}

export type TxStallReason = 'stuck' | 'commit' | 'idle';

const STALL_REASON_TEXT: Record<TxStallReason, string> = {
  stuck: 'queries waited with no reply',
  commit: 'the commit or rollback had no reply',
  idle: 'no query was in flight',
};

/** The breaker ended a transaction that made no progress. */
export class DbTransactionStalledError extends Error {
  readonly code = DB_TRANSACTION_STALLED_CODE;
  constructor(
    readonly reason: TxStallReason,
    readonly limitMs: number,
  ) {
    super(`db: transaction ended after ${limitMs}ms: ${STALL_REASON_TEXT[reason]}`);
    this.name = 'DbTransactionStalledError';
  }
}

/**
 * A query on a transaction whose body already settled. It was not sent:
 * postgres-js would hold it forever or run it outside the transaction, with
 * no RLS. Use `runWithoutScope` for work that outlives a request.
 */
export class DbTransactionEndedError extends Error {
  readonly code = DB_TRANSACTION_ENDED_CODE;
  constructor() {
    super('db: this transaction has ended; the query was not sent');
    this.name = 'DbTransactionEndedError';
  }
}

const stallLimitStore = new AsyncLocalStorage<number | null>();

/**
 * Run `fn` with a different stall limit for the queries it starts. `null`
 * turns the breaker off for them. Use it only for work that waits longer than
 * the statement timeout on purpose.
 */
export function withStallLimit<T>(limitMs: number | null, fn: () => T): T {
  return stallLimitStore.run(limitMs, fn);
}

/** The stall limit for a query created now: the scope's limit, else `fallback`. */
export function currentStallLimit(fallback: number): number | null {
  const limit = stallLimitStore.getStore();
  return limit === undefined ? fallback : limit;
}

/** What the next `begin` in this async context is, for the transaction watchdog. */
export interface TxPolicy {
  /** For the log line, e.g. `GET /api/v1/skills`. */
  label: string;
  /** End the transaction after this long with no query in flight. Null: no limit. */
  idleLimitMs: number | null;
}

const txPolicyStore = new AsyncLocalStorage<TxPolicy>();

/**
 * Run `fn` so that the `begin` it calls gets `policy`. Only that `begin` reads
 * it: the instrumented `begin` runs the transaction body outside this store,
 * so a nested transaction does not inherit it.
 */
export function withTransactionPolicy<T>(policy: TxPolicy, fn: () => T): T {
  return txPolicyStore.run(policy, fn);
}

export function currentTransactionPolicy(): TxPolicy | undefined {
  return txPolicyStore.getStore();
}

export function exitTransactionPolicy<T>(fn: () => T): T {
  return txPolicyStore.exit(fn);
}

/** Per transaction: its connection, its waiting queries and its watchdog. */
export interface TxState {
  connId: number | null;
  closeCount: number;
  /** The stall error of a query in this transaction, when the breaker tripped. */
  tripped: Error | null;
  label: string;
  /** The query stall limit when the transaction began. Null: no watchdog. */
  stallMs: number | null;
  idleLimitMs: number | null;
  /** Queries handed to postgres-js that have not settled. */
  pending: Set<object>;
  lastProgressAt: number;
  /** When the transaction body settled, so COMMIT or ROLLBACK is next. */
  bodySettledAt: number | null;
  /** The `begin` settled. */
  done: boolean;
  /** Set when the watchdog ended the transaction. */
  aborted: Error | null;
  /** The connection's `reserved` callback while this transaction holds it. */
  reserved: unknown;
  /** The transaction lost its connection without a close (logged once). */
  released: boolean;
  timer: NodeJS.Timeout | null;
  timerDueAt: number;
  onAbort: ((err: Error) => void) | null;
}

/** The parts of a postgres-js `Query` that the breaker reads. */
interface PgQuery {
  active: boolean;
  handler: ((q: unknown) => unknown) & { debug?: unknown };
  reject: (err: unknown) => void;
}

/** The parts of a postgres-js connection object that the breaker reads. */
interface PgConnection {
  id: number;
  execute: (q: unknown) => unknown;
  connect: (q: unknown) => unknown;
  /** Set by index.js while a transaction holds the connection. */
  reserved?: unknown;
}

interface Holder {
  conn: PgConnection | null;
}

export interface WatchInfo {
  /** The transaction of this query, for a query inside a transaction. */
  tx?: TxState;
  /** Set when this query is the `begin` of `beginOf`. */
  beginOf?: TxState;
  /** For the log line, e.g. `select "tasks" (pool)`. */
  describe: () => string;
  onTrip: () => void;
}

export interface StallWatch {
  clear: () => void;
}

function isPgQuery(x: unknown): x is PgQuery {
  if (!x || typeof x !== 'object') return false;
  const q = x as Partial<PgQuery>;
  return (
    'active' in x &&
    typeof q.active === 'boolean' &&
    typeof q.handler === 'function' &&
    typeof q.reject === 'function'
  );
}

function isPgConnection(x: unknown): x is PgConnection {
  if (!x || typeof x !== 'object') return false;
  const c = x as Partial<PgConnection>;
  return (
    typeof c.id === 'number' && typeof c.execute === 'function' && typeof c.connect === 'function'
  );
}

export interface StallBreakerOptions {
  stallMs?: number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** Tests only: make the socket. */
  newSocket?: () => net.Socket;
}

export class StallBreaker {
  readonly stallMs: number;
  private off = false;
  private readonly warned = new Set<string>();
  private readonly log: (line: string) => void;
  private readonly warn: (line: string) => void;
  private readonly lineage = new AsyncLocalStorage<Holder>();
  private readonly sockets = new Set<{ socket: net.Socket; holder: Holder }>();
  private readonly adopted = new WeakSet<object>();
  private readonly connOfQuery = new WeakMap<object, PgConnection>();
  private readonly txOfQuery = new WeakMap<object, TxState>();
  private readonly txOfHandler = new WeakMap<object, TxState>();
  private readonly beginOfQuery = new WeakMap<object, TxState>();
  private readonly closes = new Map<number, number>();
  private readonly connsById = new Map<number, PgConnection>();
  private nextHost = 0;
  private readonly newSocket: () => net.Socket;

  constructor(opts: StallBreakerOptions = {}) {
    this.stallMs = opts.stallMs ?? DB_STALL_MS;
    this.newSocket = opts.newSocket ?? (() => new net.Socket());
    this.log = opts.log ?? ((line) => console.error(line));
    this.warn = opts.warn ?? ((line) => console.warn(line));
  }

  get enabled(): boolean {
    return !this.off;
  }

  /**
   * The postgres-js `socket` option. It does what postgres-js does without the
   * option (connection.js `connect`), and it records the socket so that the
   * breaker can destroy it.
   */
  readonly socket = (options: { host?: unknown; port?: unknown; path?: unknown }): net.Socket => {
    for (const entry of this.sockets) if (entry.socket.destroyed) this.sockets.delete(entry);
    const socket = this.newSocket();
    this.sockets.add({ socket, holder: this.lineage.getStore() ?? { conn: null } });
    if (typeof options.path === 'string' && options.path) {
      socket.connect(options.path);
      return socket;
    }
    const hosts = Array.isArray(options.host) ? options.host : [options.host ?? 'localhost'];
    const ports = Array.isArray(options.port) ? options.port : [options.port ?? 5432];
    const i = this.nextHost++ % Math.max(1, ports.length);
    const host = String(hosts[i] ?? hosts[0]);
    const port = Number(ports[i] ?? ports[0]);
    socket.connect(port, host);
    // postgres-js reads these for TLS SNI and for its error messages.
    Object.assign(socket, { host, port });
    return socket;
  };

  /** The postgres-js `onclose` option: postgres-js calls it with the connection id. */
  readonly connectionClosed = (id: unknown): void => {
    if (typeof id === 'number') this.closes.set(id, (this.closes.get(id) ?? 0) + 1);
  };

  newTransaction(
    opts: {
      label?: string;
      stallMs?: number | null;
      idleLimitMs?: number | null;
    } = {},
  ): TxState {
    return {
      connId: null,
      closeCount: 0,
      tripped: null,
      label: opts.label ?? 'transaction',
      stallMs: opts.stallMs === undefined ? this.stallMs : opts.stallMs,
      idleLimitMs: opts.idleLimitMs ?? null,
      pending: new Set(),
      lastProgressAt: Date.now(),
      bodySettledAt: null,
      done: false,
      aborted: null,
      reserved: undefined,
      released: false,
      timer: null,
      timerDueAt: 0,
      onAbort: null,
    };
  }

  /** The transaction holds its connection now (BEGIN replied). */
  txOpened(tx: TxState): void {
    const conn = tx.connId !== null ? this.connsById.get(tx.connId) : undefined;
    if (conn?.reserved) tx.reserved = conn.reserved;
    tx.lastProgressAt = Date.now();
    this.armTx(tx);
  }

  /** A query of the transaction went to postgres-js. */
  txQueryStarted(tx: TxState, q: object): void {
    tx.pending.add(q);
    tx.lastProgressAt = Date.now();
    this.armTx(tx);
  }

  txQuerySettled(tx: TxState, q: object): void {
    if (!tx.pending.delete(q)) return;
    tx.lastProgressAt = Date.now();
    this.armTx(tx);
  }

  /** The body settled; postgres-js sends COMMIT or ROLLBACK next. */
  txBodySettled(tx: TxState): void {
    if (tx.bodySettledAt !== null) return;
    tx.bodySettledAt = Date.now();
    this.armTx(tx);
  }

  /**
   * The `begin` settled (or the watchdog ended it). A query still waiting can
   * never run in this transaction, and postgres-js never rejects its private
   * queue, so reject them here.
   */
  txDone(tx: TxState, err?: unknown): void {
    if (tx.done) return;
    tx.done = true;
    if (tx.timer) clearTimeout(tx.timer);
    tx.timer = null;
    if (tx.pending.size === 0) return;
    const reason =
      tx.aborted ?? tx.tripped ?? (err instanceof Error ? err : new DbTransactionLostError());
    for (const q of [...tx.pending]) {
      if (isPgQuery(q)) q.reject(reason);
    }
    tx.pending.clear();
  }

  /**
   * True when the transaction cannot send another query: its connection
   * closed after it began, the watchdog ended it, or postgres-js gave its
   * connection back to the pool without a close.
   */
  txLost(tx: TxState): boolean {
    if (tx.aborted) return true;
    if (tx.connId === null) return false;
    if ((this.closes.get(tx.connId) ?? 0) !== tx.closeCount) return true;
    return this.txReleased(tx);
  }

  lostError(tx: TxState): Error {
    return tx.aborted ?? tx.tripped ?? new DbTransactionLostError(tx.released ? 'released' : 'closed');
  }

  /**
   * postgres-js sets `connection.reserved` to null on a ReadyForQuery that
   * says "idle" and gives the connection to the pool, while the transaction
   * still sends on it. Its next query then runs outside the transaction, or
   * waits forever in its private queue.
   */
  private txReleased(tx: TxState): boolean {
    if (tx.reserved === undefined || tx.connId === null || tx.done) return false;
    const conn = this.connsById.get(tx.connId);
    if (!conn || conn.reserved === tx.reserved) return false;
    if (!tx.released) {
      tx.released = true;
      this.log(`[db] transaction lost its connection without a close: ${tx.label}`);
    }
    return true;
  }

  /** End `tx` now: close its connection if it still holds it, reject what waits. */
  abortTransaction(tx: TxState, err: DbTransactionStalledError): void {
    if (tx.done || tx.aborted) return;
    tx.aborted = err;
    tx.tripped ??= err;
    if (tx.timer) clearTimeout(tx.timer);
    tx.timer = null;
    const conn = tx.connId !== null ? this.connsById.get(tx.connId) : undefined;
    const closed = tx.connId !== null && (this.closes.get(tx.connId) ?? 0) !== tx.closeCount;
    const holds =
      conn !== undefined && !closed && (tx.reserved === undefined || conn.reserved === tx.reserved);
    let action = 'it did not hold its connection';
    if (holds) {
      const sockets = [...this.sockets].filter(
        (e) => e.holder.conn === conn && !e.socket.destroyed,
      );
      for (const { socket } of sockets) socket.destroy();
      if (sockets.length > 0) action = 'closed its connection';
    }
    this.log(
      `[db] transaction stalled ${Math.round(err.limitMs / 1000)}s ` +
        `(${STALL_REASON_TEXT[err.reason]}), ${action}: ${tx.label}`,
    );
    const pending = [...tx.pending];
    tx.pending.clear();
    for (const q of pending) if (isPgQuery(q)) q.reject(err);
    tx.onAbort?.(err);
  }

  private txDueAt(tx: TxState): number | null {
    if (tx.stallMs === null) return null;
    if (tx.bodySettledAt !== null) return tx.bodySettledAt + tx.stallMs;
    if (tx.pending.size > 0) return tx.lastProgressAt + tx.stallMs;
    if (tx.idleLimitMs !== null) return tx.lastProgressAt + tx.idleLimitMs;
    return null;
  }

  /**
   * One timer per transaction. Progress only moves a timestamp, and the timer
   * re-arms when it fires early. It is moved only when a deadline comes nearer.
   */
  private armTx(tx: TxState): void {
    if (tx.done || tx.aborted || this.off) return;
    const due = this.txDueAt(tx);
    if (due === null) {
      if (tx.timer) clearTimeout(tx.timer);
      tx.timer = null;
      return;
    }
    if (tx.timer && tx.timerDueAt <= due) return;
    if (tx.timer) clearTimeout(tx.timer);
    tx.timerDueAt = due;
    tx.timer = setTimeout(
      () => {
        tx.timer = null;
        this.checkTx(tx);
      },
      Math.max(0, due - Date.now()),
    );
    tx.timer.unref?.();
  }

  private checkTx(tx: TxState): void {
    if (tx.done || tx.aborted || this.off) return;
    const now = Date.now();
    // An active query has its own timer, which closes the connection.
    if (tx.bodySettledAt === null) {
      for (const q of tx.pending) {
        if (isPgQuery(q) && q.active) {
          tx.lastProgressAt = now;
          break;
        }
      }
    }
    const due = this.txDueAt(tx);
    if (due === null) return;
    if (now < due) {
      this.armTx(tx);
      return;
    }
    const reason: TxStallReason =
      tx.bodySettledAt !== null ? 'commit' : tx.pending.size > 0 ? 'stuck' : 'idle';
    const limit = reason === 'idle' ? tx.idleLimitMs! : tx.stallMs!;
    this.abortTransaction(tx, new DbTransactionStalledError(reason, limit));
  }

  /**
   * Link a transaction scope to its transaction. `probe` is a query that the
   * scope's `sql.unsafe` made and that nobody runs: its `handler` is the scope
   * handler, which postgres-js also gives to its own `commit`, `rollback` and
   * `savepoint` queries.
   */
  bindScope(probe: unknown, tx: TxState): void {
    if (isPgQuery(probe)) this.txOfHandler.set(probe.handler, tx);
  }

  /**
   * Watch one query. Returns null when the breaker does not watch it.
   * `limitMs` null means no stall limit, but the transaction guard applies.
   */
  watch(pending: object, limitMs: number | null, info: WatchInfo): StallWatch | null {
    if (this.off) return null;
    if (!isPgQuery(pending)) {
      this.disable('a query does not have the postgres-js 3.4 shape');
      return null;
    }
    const q = pending;
    let timer: NodeJS.Timeout | null = null;
    let active = q.active;
    const clear = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const fire = (): void => {
      timer = null;
      if (active && !this.off && limitMs !== null) this.trip(q, limitMs, info);
    };
    if (limitMs !== null) {
      try {
        Object.defineProperty(q, 'active', {
          configurable: true,
          enumerable: true,
          get: () => active,
          set: (v: boolean) => {
            active = v;
            if (!v) clear();
            else if (!timer && !this.off) {
              timer = setTimeout(fire, limitMs);
              timer.unref?.();
            }
          },
        });
      } catch {
        this.disable('cannot watch Query.active');
        return null;
      }
    }

    if (info.tx) this.txOfQuery.set(q, info.tx);
    if (info.beginOf) this.beginOfQuery.set(q, info.beginOf);
    const handOff = q.handler;
    q.handler = Object.assign(
      (x: unknown) => {
        if (info.tx && this.txLost(info.tx)) {
          q.reject(this.lostError(info.tx));
          return undefined;
        }
        const holder: Holder = { conn: null };
        const out = this.lineage.run(holder, () => handOff(x));
        // The pool handler returns the connection when it runs the query at
        // once or opens a connection for it. When it queues the query, it
        // returns the query, and the connection's `execute` wrapper sees it later.
        if (isPgConnection(out)) {
          holder.conn = out;
          this.adopt(out);
          this.connOfQuery.set(q, out);
          if (info.beginOf) this.bindTx(info.beginOf, out);
        }
        return out;
      },
      { debug: handOff.debug },
    );
    return { clear };
  }

  private bindTx(tx: TxState, conn: PgConnection): void {
    if (tx.connId !== null) return;
    tx.connId = conn.id;
    tx.closeCount = this.closes.get(conn.id) ?? 0;
  }

  /**
   * Wrap the connection's `execute` and `connect`. index.js calls both through
   * the object, so the wrappers see every query that a connection runs after
   * it opened, and every socket that it opens again.
   */
  private adopt(conn: PgConnection): void {
    if (this.adopted.has(conn)) return;
    this.adopted.add(conn);
    this.connsById.set(conn.id, conn);
    const execute = conn.execute;
    const connect = conn.connect;
    conn.execute = (q: unknown) => {
      if (isPgQuery(q)) {
        const tx = this.txOfQuery.get(q) ?? this.txOfHandler.get(q.handler);
        if (tx && tx.connId === conn.id && this.txLost(tx)) {
          q.reject(this.lostError(tx));
          // True means "not full", so postgres-js does not move the connection.
          return true;
        }
        this.connOfQuery.set(q, conn);
        const beginOf = this.beginOfQuery.get(q);
        if (beginOf) this.bindTx(beginOf, conn);
      }
      return execute(q);
    };
    // After a close, postgres-js opens the connection again for the next queued
    // query and runs that query from inside connection.js, not through `execute`.
    conn.connect = (q: unknown) => {
      if (q && typeof q === 'object') {
        this.connOfQuery.set(q, conn);
        const beginOf = this.beginOfQuery.get(q);
        if (beginOf) this.bindTx(beginOf, conn);
      }
      return this.lineage.run({ conn }, () => connect(q));
    };
  }

  private trip(q: PgQuery, limitMs: number, info: WatchInfo): void {
    const conn = this.connOfQuery.get(q);
    const targets: net.Socket[] = [];
    if (conn) {
      for (const entry of this.sockets) {
        if (entry.holder.conn === conn && !entry.socket.destroyed) targets.push(entry.socket);
      }
    }
    if (targets.length === 0) {
      this.warnOnce(
        'no-socket',
        `[db] a query had no reply for ${Math.round(limitMs / 1000)}s, but the breaker ` +
          `could not find its connection: ${info.describe()}`,
      );
      return;
    }
    info.onTrip();
    this.log(
      `[db] connection stalled ${Math.round(limitMs / 1000)}s, closed it: ${info.describe()}`,
    );
    // No error argument: under TLS postgres-js removed its listeners from the
    // raw socket, and an 'error' event with no listener throws.
    for (const socket of targets) socket.destroy();
  }

  private disable(reason: string): void {
    if (this.off) return;
    this.off = true;
    this.warn(`[db] stall breaker off: ${reason}`);
  }

  private warnOnce(key: string, line: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(line);
  }
}
