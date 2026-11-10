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

/** A query of a transaction whose connection closed. It was not sent. */
export class DbTransactionLostError extends Error {
  readonly code = DB_TRANSACTION_LOST_CODE;
  constructor() {
    super('db: the connection of this transaction closed; the query was not sent');
    this.name = 'DbTransactionLostError';
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

/** Per transaction: its connection and how many times that connection had closed. */
export interface TxState {
  connId: number | null;
  closeCount: number;
  /** The stall error of a query in this transaction, when the breaker tripped. */
  tripped: Error | null;
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

  newTransaction(): TxState {
    return { connId: null, closeCount: 0, tripped: null };
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

  /** True when the connection of `tx` closed after the transaction began. */
  txLost(tx: TxState): boolean {
    return tx.connId !== null && (this.closes.get(tx.connId) ?? 0) !== tx.closeCount;
  }

  lostError(tx: TxState): Error {
    return tx.tripped ?? new DbTransactionLostError();
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
