/**
 * In-flight registry for the database pool: every query that is awaited and
 * not yet settled, and every open owner-scope or advisory-lock transaction.
 *
 * It exists for one question: when the pool fills, what holds it? On
 * 2026-11-10 the 20 connections filled over 15 minutes and nothing could
 * name them. The registry is always on and costs a Map insert and delete
 * per entry. A query keeps a reference to its SQL text and is summarised
 * only when a report needs it, so the hot path does no string work. A report
 * prints the operation and the table only, never parameters or values.
 */
import { summarizeSql } from './client.js';

export type InflightKind = 'query' | 'owner_tx' | 'lock_tx';

/** Where a query runs. `transaction` shares the connection of its transaction. */
export type QueryConnection = 'pool' | 'transaction';

export interface InflightEntry {
  id: number;
  kind: InflightKind;
  startedAt: number;
  /** Request label, lock name, or the raw SQL of a query (summarised on read). */
  label: string;
  connection?: QueryConnection;
  /** The query ran in the async tree of an owner-scope request. */
  ownerScope?: boolean;
  /** Last time the reporter logged this entry. */
  reportedAt: number | null;
}

const entries = new Map<number, InflightEntry>();
let nextId = 1;
/** Every transaction the pool has opened (owner, lock or plain), by count. */
let openTransactions = 0;

export function beginInflight(
  kind: InflightKind,
  label: string,
  extra: { connection?: QueryConnection; ownerScope?: boolean } = {},
  now: number = Date.now(),
): number {
  const id = nextId++;
  entries.set(id, { id, kind, startedAt: now, label, reportedAt: null, ...extra });
  return id;
}

/** Idempotent: ending an id twice, or an unknown id, does nothing. */
export function endInflight(id: number): void {
  entries.delete(id);
}

/** Track `fn` as one entry of `kind` until it settles, on success or failure. */
export async function trackInflight<T>(
  kind: Exclude<InflightKind, 'query'>,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const id = beginInflight(kind, label);
  try {
    return await fn();
  } finally {
    endInflight(id);
  }
}

export function transactionOpened(): void {
  openTransactions += 1;
}

export function transactionClosed(): void {
  openTransactions = Math.max(0, openTransactions - 1);
}

/** All entries, oldest first. */
export function inflightEntries(): InflightEntry[] {
  return [...entries.values()].sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
}

export function inflightSize(): number {
  return entries.size;
}

const KIND_NAMES: Record<InflightKind, string> = {
  query: 'query',
  owner_tx: 'owner transaction',
  lock_tx: 'lock transaction',
};

export function kindName(kind: InflightKind): string {
  return KIND_NAMES[kind];
}

/** Human label for an entry. A query prints its operation and table only. */
export function describeEntry(entry: InflightEntry): string {
  if (entry.kind !== 'query') return entry.label;
  const { operation, table } = summarizeSql(entry.label);
  const base = `${operation.toLowerCase()}${table ? ` "${table}"` : ''}`;
  let where: string;
  if (entry.connection === 'transaction') where = entry.ownerScope ? 'owner scope' : 'transaction';
  else where = entry.ownerScope ? 'pool, from a request' : 'pool';
  return `${base} (${where})`;
}

export interface InflightCounts {
  queries: number;
  /** Queries on their own pool connection (not inside a transaction). */
  poolQueries: number;
  ownerTransactions: number;
  lockTransactions: number;
  /** Every open transaction, including plain `db.transaction` ones. */
  openTransactions: number;
  oldest: InflightEntry | null;
}

export function inflightCounts(): InflightCounts {
  const counts: InflightCounts = {
    queries: 0,
    poolQueries: 0,
    ownerTransactions: 0,
    lockTransactions: 0,
    openTransactions,
    oldest: null,
  };
  for (const e of entries.values()) {
    if (e.kind === 'query') {
      counts.queries += 1;
      if (e.connection !== 'transaction') counts.poolQueries += 1;
    } else if (e.kind === 'owner_tx') counts.ownerTransactions += 1;
    else counts.lockTransactions += 1;
    if (!counts.oldest || e.startedAt < counts.oldest.startedAt) counts.oldest = e;
  }
  return counts;
}

/**
 * Connections the process wants right now: each open transaction holds one,
 * and each query outside a transaction needs one. Above the pool max, the
 * difference is callers that wait in the postgres-js queue.
 */
export function poolDemand(counts: InflightCounts = inflightCounts()): number {
  const transactions = Math.max(
    counts.openTransactions,
    counts.ownerTransactions + counts.lockTransactions,
  );
  return counts.poolQueries + transactions;
}

export function ageSeconds(entry: InflightEntry, now: number = Date.now()): number {
  return Math.max(0, Math.round((now - entry.startedAt) / 1000));
}

/** One-line summary for the watchdog. */
export function describeInflightSummary(now: number = Date.now()): string {
  const c = inflightCounts();
  const oldest = c.oldest
    ? `oldest ${ageSeconds(c.oldest, now)}s (${kindName(c.oldest.kind)}: ${describeEntry(c.oldest)})`
    : 'nothing in flight';
  return (
    `${c.queries} queries in flight (${c.poolQueries} on the pool), ` +
    `${c.ownerTransactions} owner transactions, ${c.lockTransactions} lock transactions, ` +
    `${c.openTransactions} open transactions in all; ${oldest}`
  );
}

/** The `limit` oldest entries of each kind, as log lines. */
export function describeOldestByKind(limit: number, now: number = Date.now()): string[] {
  const lines: string[] = [];
  const all = inflightEntries();
  for (const kind of Object.keys(KIND_NAMES) as InflightKind[]) {
    const ofKind = all.filter((e) => e.kind === kind);
    if (ofKind.length === 0) continue;
    lines.push(`${kindName(kind)}: ${ofKind.length} open`);
    for (const e of ofKind.slice(0, limit)) {
      lines.push(`  ${ageSeconds(e, now)}s ${describeEntry(e)}`);
    }
    if (ofKind.length > limit) lines.push(`  +${ofKind.length - limit} more`);
  }
  return lines;
}

/** Test-only. */
export function _resetInflight(): void {
  entries.clear();
  nextId = 1;
  openTransactions = 0;
}
