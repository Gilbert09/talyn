import { sql } from 'drizzle-orm';
import { getPoolDbClient } from '../db/client.js';
import { debugBus } from './debugBus.js';

/**
 * Last-resort self-healing for a wedged database pool.
 *
 * The 2026-07-04 / 2026-07-06 prod incidents showed the failure shape: the
 * Supavisor transaction pooler runs out of backend connections (long
 * idle-in-transaction sessions pin them), every query queues into 60s
 * ECHECKOUTTIMEOUT failures, /health answers 503 — and nothing restarts the
 * process, because Railway's healthcheck only gates deploy cutover, not
 * running deploys. The Jul 6 outage lasted 14 minutes and ended only with a
 * manual restart; the restart fixed it precisely because dropping the
 * process's connections freed the pinned pooler backends.
 *
 * This watchdog automates that: probe the pool with a bounded `select 1`,
 * and once it has failed continuously for ~2 minutes, exit(1) so Railway's
 * ON_FAILURE restart policy brings up a fresh process with a fresh pool.
 *
 * Threshold rationale (each is anchored, not arbitrary):
 * - probe bound 3s — same as the /health DB probe; a healthy pooler answers
 *   `select 1` in single-digit ms, so 3s only trips while checkouts queue.
 * - interval 15s — 4 probes/min is negligible load but keeps detection
 *   inside ~2 min.
 * - 8 consecutive failures (~120s) — must outlast one full Supavisor
 *   checkout-timeout cycle (60s) so a single transient stall never kills the
 *   process, while still beating the 14-minute manual-restart alternative by
 *   an order of magnitude.
 */
const PROBE_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 3_000;
const MAX_CONSECUTIVE_FAILURES = 8;

export interface DbWatchdogOptions {
  intervalMs?: number;
  probeTimeoutMs?: number;
  maxConsecutiveFailures?: number;
  /** Injectable for tests. Defaults to `select 1` on the process-wide pool. */
  probe?: () => Promise<unknown>;
  /** Injectable for tests. Defaults to process.exit(1). */
  onFatal?: (reason: string) => void;
}

export class DbWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private fired = false;

  private readonly intervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly probe: () => Promise<unknown>;
  private readonly onFatal: (reason: string) => void;

  constructor(opts: DbWatchdogOptions = {}) {
    this.intervalMs = opts.intervalMs ?? PROBE_INTERVAL_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.maxConsecutiveFailures = opts.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES;
    this.probe = opts.probe ?? (() => getPoolDbClient().execute(sql`select 1`));
    this.onFatal =
      opts.onFatal ??
      ((reason: string) => {
        // Deliberately NOT the graceful shutdown path: it awaits DB flushes
        // (checkCountCoalescer etc.) that would hang on the very wedge we're
        // escaping. A hard exit is the fix — the queued webhook stream and
        // reconcile sweep re-derive anything in flight.
        console.error(`[dbWatchdog] ${reason} — exiting so the platform restarts us`);
        process.exit(1);
      });
  }

  init(): void {
    if (this.timer) return;
    debugBus.registerPoller(
      'db_watchdog',
      this.intervalMs,
      'Bounded select-1 probe of the DB pool; exits the process after ~2 min of continuous failure so Railway restarts it (frees wedged pooler backends).',
    );
    const schedule = () => {
      this.timer = setTimeout(() => {
        void this.tick().finally(() => {
          if (this.timer && !this.fired) schedule();
        });
      }, this.intervalMs);
      this.timer.unref?.();
    };
    schedule();
  }

  /** One probe. Exposed for tests; production runs it off the timer only. */
  async tick(): Promise<void> {
    const startedAt = Date.now();
    let ok = false;
    let error: string | undefined;
    try {
      await Promise.race([
        this.probe(),
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error(`db probe exceeded ${this.probeTimeoutMs}ms`)),
            this.probeTimeoutMs,
          ).unref?.(),
        ),
      ]);
      ok = true;
      this.consecutiveFailures = 0;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      this.consecutiveFailures += 1;
      console.error(
        `[dbWatchdog] probe failed (${this.consecutiveFailures}/${this.maxConsecutiveFailures}):`,
        error,
      );
    } finally {
      debugBus.pollerTick('db_watchdog', {
        durationMs: Date.now() - startedAt,
        ok,
        error,
        summary: ok
          ? 'db_watchdog — pool responsive'
          : `db_watchdog — probe failing (${this.consecutiveFailures}/${this.maxConsecutiveFailures})`,
      });
    }
    if (!ok && this.consecutiveFailures >= this.maxConsecutiveFailures && !this.fired) {
      this.fired = true;
      this.stopTimer();
      this.onFatal(
        `database unreachable for ${this.consecutiveFailures} consecutive probes (~${Math.round(
          (this.consecutiveFailures * this.intervalMs) / 1000,
        )}s)`,
      );
    }
  }

  shutdown(): void {
    this.stopTimer();
    this.consecutiveFailures = 0;
    this.fired = false;
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export const dbWatchdog = new DbWatchdog();
