import { DB_POOL_MAX } from '../db/client.js';
import {
  ageSeconds,
  describeEntry,
  inflightCounts,
  inflightEntries,
  kindName,
  poolDemand,
} from '../db/inflight.js';
import { debugBus } from './debugBus.js';

/**
 * Logs what holds the DB pool, from the in-flight registry (`db/inflight.ts`).
 *
 * An entry open longer than `thresholdMs` is logged once when it crosses the
 * threshold, then at most once per `repeatMs`. A tick also warns when the
 * pool demand is above the pool max, because then callers wait in the
 * postgres-js queue. 30 s matches the pool's statement and idle-in-transaction
 * timeouts: anything open longer has already escaped both.
 */
const REPORT_INTERVAL_MS = 15_000;
const THRESHOLD_MS = 30_000;
const REPEAT_MS = 60_000;
const MAX_LINES = 15;

export interface InflightReportOptions {
  thresholdMs?: number;
  repeatMs?: number;
  maxLines?: number;
  poolMax?: number;
}

/** Build this tick's log lines and mark the printed entries as reported. */
export function collectInflightReport(
  now: number = Date.now(),
  opts: InflightReportOptions = {},
): string[] {
  const thresholdMs = opts.thresholdMs ?? THRESHOLD_MS;
  const repeatMs = opts.repeatMs ?? REPEAT_MS;
  const maxLines = opts.maxLines ?? MAX_LINES;
  const poolMax = opts.poolMax ?? DB_POOL_MAX;

  const lines: string[] = [];
  const counts = inflightCounts();
  const demand = poolDemand(counts);
  if (demand > poolMax) {
    lines.push(
      `[db-inflight] pool demand ${demand} > max ${poolMax}: callers are queueing for a connection ` +
        `(${counts.poolQueries} pool queries, ${counts.openTransactions} open transactions, ` +
        `${counts.ownerTransactions} owner, ${counts.lockTransactions} lock)`,
    );
  }

  const due = inflightEntries().filter(
    (e) =>
      now - e.startedAt >= thresholdMs && (e.reportedAt === null || now - e.reportedAt >= repeatMs),
  );
  for (const e of due.slice(0, maxLines)) {
    e.reportedAt = now;
    lines.push(`[db-inflight] ${kindName(e.kind)} open ${ageSeconds(e, now)}s: ${describeEntry(e)}`);
  }
  if (due.length > maxLines) lines.push(`[db-inflight] +${due.length - maxLines} more`);
  return lines;
}

export class DbInflightReporter {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly intervalMs: number = REPORT_INTERVAL_MS,
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  init(): void {
    if (this.timer) return;
    debugBus.registerPoller(
      'db_inflight',
      this.intervalMs,
      'Logs DB queries and owner or lock transactions open longer than 30s, and warns when pool demand exceeds the pool max.',
    );
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  tick(now: number = Date.now()): string[] {
    const startedAt = Date.now();
    let ok = true;
    let error: unknown;
    let lines: string[] = [];
    try {
      lines = collectInflightReport(now);
      for (const line of lines) this.log(line);
    } catch (err) {
      ok = false;
      error = err;
    } finally {
      debugBus.pollerTick('db_inflight', {
        durationMs: Date.now() - startedAt,
        ok,
        error,
        summary: `db_inflight — ${lines.length} lines`,
      });
    }
    return lines;
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const dbInflightReporter = new DbInflightReporter();
