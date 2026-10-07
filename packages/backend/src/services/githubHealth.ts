import type {
  GithubApiTraffic,
  GithubHealth,
  GithubHealthSource,
  GithubHealthState,
  GithubStatusComponent,
  GithubStatusIncident,
  GithubStatusPageHealth,
  GithubTrafficHealth,
} from '@talyn/shared';
import { parseRateLimitResponse } from './githubRateGate.js';

/**
 * Is GitHub itself down?
 *
 * This file is the pure part: how one response is classified, the rolling
 * window over Talyn's own GitHub calls, how GitHub's status page is read, and
 * how the two signals combine. Nothing here does I/O or reads a clock that the
 * caller did not pass in. The poller, the broadcast and the debug bus live in
 * `githubHealthMonitor.ts`.
 *
 * The one piece of state is {@link githubTraffic}, the window the request
 * funnel feeds. It is PER PROCESS. Each replica has its own window and reports
 * what it sees. That is accepted: replicas only overlap during a deploy, and
 * coordinating them would put a shared store on the hottest path in the
 * backend for a signal that heals in minutes.
 *
 * The window holds counters only. No URL, token, account or workspace is
 * stored, so the result is safe to send to every client.
 */

// ---- Signal A: one response --------------------------------------------------

export type GithubApi = 'rest' | 'graphql';
export type GithubResponseKind = 'ok' | 'server_failure';

/** The statuses an outage answers with. Every other status means GitHub answered. */
const SERVER_FAILURE_STATUSES = new Set([500, 502, 503, 504]);

/**
 * Classify one GitHub response. Pass `null` when there was no response at all
 * (network error, timeout, connection reset).
 *
 * A 4xx is `ok`: GitHub was up and said no. A rate limit is `ok` too. It is
 * GitHub working as designed, and `parseRateLimitResponse` is the one
 * definition of what a rate limit looks like, so it is asked first.
 */
export function classifyGithubResponse(
  response: { status: number; headers: Headers; bodyText: string } | null,
): GithubResponseKind {
  if (response === null) return 'server_failure';
  if (parseRateLimitResponse(response, response.bodyText).isRateLimited) return 'ok';
  return SERVER_FAILURE_STATUSES.has(response.status) ? 'server_failure' : 'ok';
}

/** Which API a URL belongs to. GitHub's GraphQL API has one endpoint. */
export function githubApiForUrl(url: string): GithubApi {
  const path = url.split('?')[0] ?? url;
  return path.endsWith('/graphql') ? 'graphql' : 'rest';
}

// ---- Signal A: the rolling window -------------------------------------------

/**
 * How far back the window looks.
 *
 * Ten minutes is two periods of the reconcile sweep (5 min, plus up to 1 min
 * of jitter). The sweep is the one source of GitHub calls that runs with no
 * user and no webhook, so a window this long always holds at least one whole
 * sweep. A shorter window would be empty between sweeps on a quiet night, and
 * an outage would read `down`, then `unknown`, then `down` again.
 */
export const GITHUB_HEALTH_WINDOW_MS = 10 * 60_000;

/**
 * The size of one counter bucket.
 *
 * It sets how exactly old calls leave the window: at most 30 seconds late, 5%
 * of the window. Twenty buckets per API is the whole memory cost, whatever the
 * request volume is.
 */
export const GITHUB_HEALTH_BUCKET_MS = 30_000;

const BUCKET_COUNT = GITHUB_HEALTH_WINDOW_MS / GITHUB_HEALTH_BUCKET_MS;

/**
 * The fewest calls, and the fewest server failures, that can decide anything.
 *
 * `executeGraphql` tries one query up to three times, so three server failures
 * can be a single unlucky query. Four cannot. One failed call at 3 a.m. never
 * raises a banner.
 */
export const GITHUB_HEALTH_MIN_SAMPLE = 4;

/**
 * The share of server failures that reads as `degraded`.
 *
 * GitHub's GraphQL endpoint answers 502 to a heavy query now and then on a
 * normal day, so a few percent is background. At one failure in four a REST
 * call, which has no retry, fails one time in four, while a GraphQL query still
 * gets through its three tries 98% of the time. Slow and flaky, not stopped.
 */
export const GITHUB_HEALTH_DEGRADED_SHARE = 0.25;

/**
 * The share of server failures that reads as `down`.
 *
 * At one in two a REST call is a coin toss and one GraphQL query in eight
 * fails all three tries. A merge that needs several calls in a row will not
 * finish. Waiting for a share near 100% would miss the usual outage, in which
 * GitHub still answers some requests.
 */
export const GITHUB_HEALTH_DOWN_SHARE = 0.5;

/**
 * How long the picture must stay better before the state improves.
 *
 * Getting worse is immediate. Getting better waits two minutes, which is two
 * ticks of the merge queue reconciler (60 s). GitHub often answers a burst of
 * good responses in the middle of an incident, and one good tick must not take
 * the banner down only for the next tick to put it back.
 */
export const GITHUB_HEALTH_RECOVERY_MS = 2 * 60_000;

const STATE_RANK: Record<GithubHealthState, number> = {
  unknown: 0,
  operational: 1,
  degraded: 2,
  down: 3,
};

const isBad = (state: GithubHealthState): boolean => state === 'degraded' || state === 'down';

/** The worse of two states. `unknown` loses to everything. */
export function worseGithubState(a: GithubHealthState, b: GithubHealthState): GithubHealthState {
  return STATE_RANK[a] >= STATE_RANK[b] ? a : b;
}

interface Bucket {
  /** `floor(time / bucket size)`. A bucket whose slot is old is empty. */
  slot: number;
  requests: number;
  failures: number;
}

/** The rolling window for one API. */
export class GithubApiWindow {
  private readonly buckets: Bucket[] = Array.from({ length: BUCKET_COUNT }, () => ({
    slot: -1,
    requests: 0,
    failures: 0,
  }));
  private lastFailureAt: number | null = null;
  private okSinceFailure = 0;
  private held: GithubHealthState = 'unknown';
  /** When the window first read better than `held`. Null while it does not. */
  private betterSince: number | null = null;

  record(kind: GithubResponseKind, now: number): void {
    const slot = Math.floor(now / GITHUB_HEALTH_BUCKET_MS);
    const bucket = this.buckets[slot % BUCKET_COUNT];
    if (bucket.slot !== slot) {
      bucket.slot = slot;
      bucket.requests = 0;
      bucket.failures = 0;
    }
    bucket.requests += 1;
    if (kind === 'server_failure') {
      bucket.failures += 1;
      this.lastFailureAt = now;
      this.okSinceFailure = 0;
    } else {
      this.okSinceFailure += 1;
    }
    this.evaluate(now);
  }

  /** Counts in the window, and the state after hysteresis. */
  read(now: number): GithubApiTraffic {
    const state = this.evaluate(now);
    return { ...this.totals(now), state };
  }

  /** Test helper: how many buckets exist. It never changes. */
  bucketCount(): number {
    return this.buckets.length;
  }

  private totals(now: number): { requests: number; serverFailures: number } {
    const oldest = Math.floor(now / GITHUB_HEALTH_BUCKET_MS) - BUCKET_COUNT;
    let requests = 0;
    let serverFailures = 0;
    for (const bucket of this.buckets) {
      if (bucket.slot <= oldest) continue;
      requests += bucket.requests;
      serverFailures += bucket.failures;
    }
    return { requests, serverFailures };
  }

  /** What the window alone says, with no memory of the state before. */
  private raw(now: number): GithubHealthState {
    const { requests, serverFailures } = this.totals(now);
    if (requests < GITHUB_HEALTH_MIN_SAMPLE) return 'unknown';
    if (serverFailures < GITHUB_HEALTH_MIN_SAMPLE) return 'operational';
    const share = serverFailures / requests;
    if (share >= GITHUB_HEALTH_DOWN_SHARE) return 'down';
    if (share >= GITHUB_HEALTH_DEGRADED_SHARE) return 'degraded';
    return 'operational';
  }

  private evaluate(now: number): GithubHealthState {
    if (!isBad(this.held)) {
      // Nothing to hold on to: follow the window, in either direction.
      this.held = this.raw(now);
      this.betterSince = null;
      return this.held;
    }

    // A clean run ends the incident whatever the older buckets still hold: no
    // server failure for the recovery time, and enough good calls after the
    // last one to mean something. The buckets from the incident are emptied,
    // or their failures would raise the state again on the next call.
    if (
      this.lastFailureAt !== null &&
      now - this.lastFailureAt >= GITHUB_HEALTH_RECOVERY_MS &&
      this.okSinceFailure >= GITHUB_HEALTH_MIN_SAMPLE
    ) {
      const lastFailureSlot = Math.floor(this.lastFailureAt / GITHUB_HEALTH_BUCKET_MS);
      for (const bucket of this.buckets) {
        if (bucket.slot <= lastFailureSlot) {
          bucket.requests = 0;
          bucket.failures = 0;
        }
      }
      this.held = 'operational';
      this.betterSince = null;
      return this.held;
    }

    const raw = this.raw(now);
    if (STATE_RANK[raw] > STATE_RANK[this.held]) {
      this.held = raw;
      this.betterSince = null;
    } else if (raw === this.held) {
      this.betterSince = null;
    } else {
      // Better (or no longer known). Believe it only once it has lasted.
      this.betterSince ??= now;
      if (now - this.betterSince >= GITHUB_HEALTH_RECOVERY_MS) {
        this.held = raw;
        this.betterSince = null;
      }
    }
    return this.held;
  }
}

/** Both APIs' windows. GitHub outages are often one API and not the other. */
export class GithubTrafficTracker {
  private rest = new GithubApiWindow();
  private graphql = new GithubApiWindow();
  private lastState: GithubHealthState = 'unknown';
  private listener: (() => void) | null = null;

  /** Called when a recorded response changes the overall traffic state. */
  setListener(fn: (() => void) | null): void {
    this.listener = fn;
  }

  record(api: GithubApi, kind: GithubResponseKind, now: number = Date.now()): void {
    (api === 'graphql' ? this.graphql : this.rest).record(kind, now);
    if (!this.listener) return;
    const state = this.read(now).state;
    if (state === this.lastState) return;
    this.lastState = state;
    try {
      this.listener();
    } catch {
      // The request funnel must never fail because of health reporting.
    }
  }

  read(now: number = Date.now()): GithubTrafficHealth {
    const rest = this.rest.read(now);
    const graphql = this.graphql.read(now);
    return {
      rest,
      graphql,
      state: worseGithubState(rest.state, graphql.state),
      windowMs: GITHUB_HEALTH_WINDOW_MS,
    };
  }

  /** Test helper: drop every count. The listener stays. */
  _reset(): void {
    this.rest = new GithubApiWindow();
    this.graphql = new GithubApiWindow();
    this.lastState = 'unknown';
  }
}

/** The window the GitHub request funnel feeds. Per process: see the file comment. */
export const githubTraffic = new GithubTrafficTracker();

// ---- Signal B: GitHub's status page -----------------------------------------

export const GITHUB_STATUS_SUMMARY_URL = 'https://www.githubstatus.com/api/v2/summary.json';

/**
 * The status-page components Talyn depends on. An incident on any other
 * component (Codespaces, Copilot, Pages, Packages) is not Talyn's problem.
 */
export const GITHUB_STATUS_RELIED_COMPONENTS = [
  'API Requests',
  'Webhooks',
  'Pull Requests',
  'Git Operations',
  'Actions',
] as const;

/** The component whose major outage means Talyn cannot work at all. */
const API_COMPONENT = 'api requests';

const RELIED = new Set(GITHUB_STATUS_RELIED_COMPONENTS.map((name) => name.toLowerCase()));

/** Statuspage's values for a component that is not working normally. */
const BAD_COMPONENT_STATUSES = new Set(['degraded_performance', 'partial_outage', 'major_outage']);

/**
 * How old the last good read may be before it says nothing.
 *
 * Five minutes is five missed polls. GitHub posts and resolves incidents on a
 * scale of minutes, so an older answer can be wrong in either direction.
 */
export const GITHUB_STATUS_STALE_MS = 5 * 60_000;

/** One successful read of the status page. */
export interface GithubStatusReading {
  indicator: string | null;
  components: GithubStatusComponent[];
  incidents: GithubStatusIncident[];
  fetchedAtMs: number;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Read Statuspage's `summary.json`. The shape is not ours, so every field is
 * optional and a missing one never throws. Returns null when the body is not
 * the summary at all, which the caller treats as a failed read.
 */
export function parseGithubStatusPage(body: unknown, fetchedAtMs: number): GithubStatusReading | null {
  const root = asRecord(body);
  if (!root) return null;
  const status = asRecord(root.status);
  if (!status && !Array.isArray(root.components)) return null;

  const components: GithubStatusComponent[] = [];
  for (const entry of Array.isArray(root.components) ? root.components : []) {
    const component = asRecord(entry);
    const name = asString(component?.name);
    const componentStatus = asString(component?.status);
    if (!name || !componentStatus || !RELIED.has(name.toLowerCase())) continue;
    components.push({ name, status: componentStatus });
  }
  const anyReliedBad = components.some((c) => BAD_COMPONENT_STATUSES.has(c.status));

  const incidents: GithubStatusIncident[] = [];
  for (const entry of Array.isArray(root.incidents) ? root.incidents : []) {
    const incident = asRecord(entry);
    const name = asString(incident?.name);
    if (!incident || !name) continue;
    // `resolved` and `postmortem` are over. The summary lists unresolved ones
    // only, but nothing promises that.
    const incidentStatus = asString(incident.status);
    if (incidentStatus === 'resolved' || incidentStatus === 'postmortem') continue;
    const touched = Array.isArray(incident.components)
      ? incident.components
          .map((c) => asString(asRecord(c)?.name)?.toLowerCase())
          .filter((n): n is string => Boolean(n))
      : [];
    incidents.push({
      name,
      url: asString(incident.shortlink),
      impact: asString(incident.impact),
      startedAt: asString(incident.started_at) ?? asString(incident.created_at),
      // An incident that names its components is judged by them. One that does
      // not is judged by whether a component Talyn depends on is unwell now.
      relevant: touched.length > 0 ? touched.some((n) => RELIED.has(n)) : anyReliedBad,
    });
  }

  return { indicator: asString(status?.indicator), components, incidents, fetchedAtMs };
}

/** What the status page says for Talyn at `now`. */
export function githubStatusPageState(
  reading: GithubStatusReading | null,
  now: number,
): GithubHealthState {
  if (!reading) return 'unknown';
  if (now - reading.fetchedAtMs > GITHUB_STATUS_STALE_MS) return 'unknown';
  const bad = reading.components.filter((c) => BAD_COMPONENT_STATUSES.has(c.status));
  // An incident that touches none of Talyn's components is not Talyn's
  // problem, whatever the overall indicator says.
  if (bad.length === 0) return 'operational';
  const apiOut = bad.some((c) => c.name.toLowerCase() === API_COMPONENT && c.status === 'major_outage');
  if (apiOut || reading.indicator === 'critical') return 'down';
  return 'degraded';
}

// ---- The two signals together -------------------------------------------------

/**
 * Combine the two signals into the one answer clients see.
 *
 * The worse signal wins. Talyn's own traffic is enough alone, because the
 * status page trails a real incident by many minutes. The status page is
 * enough alone for a component Talyn depends on. `unknown` only when neither
 * signal can say anything.
 *
 * `previous` carries `since` across calls: it is kept while the state stays
 * the same and starts again when the state changes.
 */
export function combineGithubHealth(
  traffic: GithubTrafficHealth,
  reading: GithubStatusReading | null,
  now: number,
  previous?: Pick<GithubHealth, 'state' | 'since'> | null,
): GithubHealth {
  const pageState = githubStatusPageState(reading, now);
  const state = worseGithubState(traffic.state, pageState);
  const trafficBad = isBad(traffic.state);
  const pageBad = isBad(pageState);
  const source: GithubHealthSource | null =
    trafficBad && pageBad ? 'both' : trafficBad ? 'traffic' : pageBad ? 'status_page' : null;
  const nowIso = new Date(now).toISOString();
  const statusPage: GithubStatusPageHealth | null = reading
    ? {
        indicator: reading.indicator,
        components: reading.components,
        incidents: reading.incidents,
        fetchedAt: new Date(reading.fetchedAtMs).toISOString(),
        state: pageState,
      }
    : null;
  return {
    state,
    source,
    traffic,
    statusPage,
    since: !isBad(state) ? null : previous?.state === state && previous.since ? previous.since : nowIso,
    updatedAt: nowIso,
  };
}

/**
 * What must change for clients to be told: the state, or the set of incidents
 * the status page lists. A stale page lists none.
 */
export function githubHealthChangeKey(health: GithubHealth): string {
  const names =
    health.statusPage && health.statusPage.state !== 'unknown'
      ? [...new Set(health.statusPage.incidents.map((incident) => incident.name))].sort()
      : [];
  return JSON.stringify([health.state, names]);
}
