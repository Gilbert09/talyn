import type { GithubHealth, WSEvent } from '@talyn/shared';
import { debugBus } from './debugBus.js';
import {
  GITHUB_STATUS_SUMMARY_URL,
  combineGithubHealth,
  githubHealthChangeKey,
  githubTraffic,
  parseGithubStatusPage,
  type GithubStatusReading,
  type GithubTrafficTracker,
} from './githubHealth.js';
import { fetchWithTimeout } from './httpTimeout.js';
import { broadcast } from './websocket.js';

/**
 * The I/O around `githubHealth.ts`: it polls GitHub's status page, keeps the
 * combined answer current, and tells clients and the debug bus when it changes.
 *
 * Per process, like the traffic window it reads. Each replica polls the status
 * page and reports what it sees. There is no cross-replica coordination.
 */

/**
 * How often the status page is read.
 *
 * Statuspage serves `summary.json` from a CDN and asks for no key. People
 * update the page by hand, minutes into an incident, so reading it more often
 * than once a minute cannot learn anything sooner. One small GET a minute from
 * each backend process is the usual polite rate for it.
 */
export const GITHUB_STATUS_POLL_INTERVAL_MS = 60_000;

/**
 * How long one read may take.
 *
 * A healthy answer is a few kilobytes from a CDN and arrives in well under a
 * second. Ten seconds allows for a slow network and still ends long before the
 * next poll, so two reads never overlap.
 */
export const GITHUB_STATUS_TIMEOUT_MS = 10_000;

const POLLER_NAME = 'github_status';

/** `GITHUB_STATUS_POLL_ENABLED=false` (or 0/off/no) stops the status-page reads. */
export function githubStatusPollEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GITHUB_STATUS_POLL_ENABLED?.trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
}

export interface GithubHealthMonitorOptions {
  tracker?: GithubTrafficTracker;
  /** Injectable for tests. Defaults to the WebSocket broadcast to all clients. */
  broadcast?: (event: WSEvent<GithubHealth>) => void;
  /** Injectable for tests. Defaults to a timed GET of the status page. */
  fetchStatusPage?: () => Promise<{ status: number; ok: boolean; bodyText: string }>;
  now?: () => number;
}

export class GithubHealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private reading: GithubStatusReading | null = null;
  private last: GithubHealth | null = null;
  // Starts as "unknown, no incidents", so a process that boots into a healthy
  // GitHub says so once and a process that learns nothing says nothing.
  private lastKey = JSON.stringify(['unknown', []]);
  private pollStatusPageEnabled = true;

  private readonly tracker: GithubTrafficTracker;
  private readonly send: (event: WSEvent<GithubHealth>) => void;
  private readonly fetchStatusPage: () => Promise<{ status: number; ok: boolean; bodyText: string }>;
  private readonly now: () => number;

  constructor(opts: GithubHealthMonitorOptions = {}) {
    this.tracker = opts.tracker ?? githubTraffic;
    this.send = opts.broadcast ?? broadcast;
    this.fetchStatusPage =
      opts.fetchStatusPage ??
      (() =>
        fetchWithTimeout(
          GITHUB_STATUS_SUMMARY_URL,
          { headers: { Accept: 'application/json', 'User-Agent': 'Talyn' } },
          { timeoutMs: GITHUB_STATUS_TIMEOUT_MS, label: 'GitHub status page' },
        ));
    this.now = opts.now ?? Date.now;
  }

  /**
   * Start the loop. Called once at boot from `index.ts`.
   *
   * Under `NODE_ENV=test` this does nothing unless the test passes `force`, so
   * no suite reaches the network by importing the backend. The env switch
   * stops only the status-page reads: the loop still runs, because the traffic
   * signal needs a tick to notice that time has passed with no failures.
   */
  init(opts: { force?: boolean } = {}): void {
    if (this.timer) return;
    if (process.env.NODE_ENV === 'test' && !opts.force) return;
    this.pollStatusPageEnabled = githubStatusPollEnabled();
    debugBus.registerPoller(
      POLLER_NAME,
      GITHUB_STATUS_POLL_INTERVAL_MS,
      this.pollStatusPageEnabled
        ? "Reads GitHub's public status page and re-checks the share of Talyn's own GitHub calls that failed. Raises the in-app GitHub outage banner."
        : "Re-checks the share of Talyn's own GitHub calls that failed. The status-page read is off (GITHUB_STATUS_POLL_ENABLED).",
    );
    // A response that changes the traffic state is reported at once, not at
    // the next tick: the request funnel calls this through the tracker.
    this.tracker.setListener(() => this.refresh());
    debugBus.setGithubHealthSource(() => this.refresh());
    const schedule = () => {
      this.timer = setTimeout(() => {
        void this.tick().finally(() => {
          if (this.timer) schedule();
        });
      }, GITHUB_STATUS_POLL_INTERVAL_MS);
      this.timer.unref?.();
    };
    schedule();
    // The first read does not wait a whole interval.
    void this.tick();
  }

  shutdown(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.tracker.setListener(null);
    debugBus.setGithubHealthSource(null);
  }

  /** One loop pass. Exposed for tests. */
  async tick(): Promise<void> {
    const startedAt = this.now();
    let ok = true;
    let error: unknown;
    try {
      if (this.pollStatusPageEnabled) await this.pollStatusPage();
    } catch (err) {
      ok = false;
      error = err;
    } finally {
      const health = this.refresh();
      debugBus.pollerTick(POLLER_NAME, {
        durationMs: this.now() - startedAt,
        ok,
        error,
        summary: `${POLLER_NAME} — GitHub ${health.state}${ok ? '' : ' (status page read failed)'}`,
      });
    }
  }

  /**
   * Read the status page once. A failed read throws and changes nothing: it
   * says nothing about GitHub, so the last good answer stays until it is stale.
   */
  async pollStatusPage(): Promise<void> {
    const startedAt = this.now();
    let response: { status: number; ok: boolean; bodyText: string };
    try {
      response = await this.fetchStatusPage();
    } catch (err) {
      debugBus.recordHttp({
        service: POLLER_NAME,
        method: 'GET',
        url: GITHUB_STATUS_SUMMARY_URL,
        durationMs: this.now() - startedAt,
        ok: false,
        error: err,
      });
      throw err;
    }
    let reading: GithubStatusReading | null = null;
    let error: string | undefined;
    if (!response.ok) {
      error = `status page answered ${response.status}`;
    } else {
      try {
        reading = parseGithubStatusPage(JSON.parse(response.bodyText), this.now());
        if (!reading) error = 'status page answer is not a summary';
      } catch {
        error = 'status page answer is not JSON';
      }
    }
    debugBus.recordHttp({
      service: POLLER_NAME,
      method: 'GET',
      url: GITHUB_STATUS_SUMMARY_URL,
      status: response.status,
      durationMs: this.now() - startedAt,
      ok: reading !== null,
      bytes: response.bodyText.length,
      ...(error ? { error } : {}),
    });
    if (!reading) throw new Error(error);
    this.reading = reading;
  }

  /**
   * Work out the current answer. When the state or the set of incidents has
   * changed since the last call, tell every client, and record a state change
   * on the debug bus. Cheap: counters and one comparison.
   */
  refresh(): GithubHealth {
    const now = this.now();
    const previous = this.last;
    const health = combineGithubHealth(this.tracker.read(now), this.reading, now, previous);
    this.last = health;
    const key = githubHealthChangeKey(health);
    if (key === this.lastKey) return health;
    this.lastKey = key;
    const from = previous?.state ?? 'unknown';
    if (from !== health.state) {
      debugBus.recordEvent({
        service: 'github',
        action: 'health:changed',
        summary: `GitHub health ${from} → ${health.state}${health.source ? ` (${health.source})` : ''}`,
        ok: health.state !== 'degraded' && health.state !== 'down',
        meta: {
          from,
          to: health.state,
          source: health.source,
          rest: health.traffic.rest,
          graphql: health.traffic.graphql,
          statusPage: health.statusPage?.state ?? null,
        },
      });
    }
    try {
      this.send({ type: 'github:health', payload: health, timestamp: health.updatedAt });
    } catch (err) {
      console.error('[githubHealth] broadcast failed:', err);
    }
    return health;
  }

  /** GitHub is `down` now, by either signal. */
  isDown(): boolean {
    return this.refresh().state === 'down';
  }

  /** Test helper: forget the status page and the last answer. */
  _reset(): void {
    this.reading = null;
    this.last = null;
    this.lastKey = JSON.stringify(['unknown', []]);
  }
}

export const githubHealthMonitor = new GithubHealthMonitor();
