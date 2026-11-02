import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import {
  apiWebhookDeliveries as deliveriesTable,
  apiWebhookEndpoints as endpointsTable,
  apiWebhookObjectStates as statesTable,
} from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { webhookHeaders } from './signing.js';
import { abandonPendingDeliveries, endpointsForDelivery } from './store.js';
import { defaultWebhookUrlPolicy, parseWebhookUrl, webhookLookup, type WebhookUrlPolicy } from './urlPolicy.js';

/**
 * Sends webhook deliveries. Every replica runs one; they share the work.
 *
 * # Claiming
 *
 * One UPDATE claims due rows with `FOR UPDATE SKIP LOCKED` and moves their
 * `next_attempt_at` 60 seconds ahead. That column is the lease: a row whose
 * worker died (a deploy) is due again after a minute. The claim also writes a
 * token, and every settle matches it, so a worker that outlived its lease
 * cannot overwrite the result of the worker that took the row over. No
 * advisory lock: two replicas claim different rows and both make progress.
 *
 * # Retries
 *
 * A 2xx is success. Anything else, a timeout or a refused address is a failed
 * attempt, retried after RETRY_DELAYS_MS: 8 attempts over about 28 hours. A
 * 410 Gone disables the endpoint at once. An endpoint that has failed every
 * attempt for 3 days and at least 10 times is disabled with a reason; one
 * success resets the streak.
 */

export const WEBHOOK_WORKER_POLLER = 'api_webhook_deliveries';

/** The wait after each failed attempt: attempt 1 fails → 5 s, attempt 2 → 5 min, and so on. */
export const RETRY_DELAYS_MS = [
  5_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  5 * 3_600_000,
  10 * 3_600_000,
  10 * 3_600_000,
] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** A receiver must answer within this. Standard Webhooks senders use 15 s or less. */
export const DELIVERY_TIMEOUT_MS = 10_000;
/** Longer than the timeout, so a live attempt never loses its row. */
const LEASE_SECONDS = 60;
/** The fallback cadence. A new delivery also nudges the worker, so the first attempt does not wait for it. */
const POLL_MS = 5_000;
/** Rows per claim. Each is one outbound request at most 10 s long; the next tick takes the rest. */
const BATCH = 20;

/** Disable after a failure streak at least this long AND at least this many attempts long. */
export const DISABLE_AFTER_MS = 3 * 24 * 3_600_000;
export const DISABLE_AFTER_FAILURES = 10;

/**
 * Finished deliveries and announced states are kept 30 days: many times the
 * 28-hour retry window, and long enough to notice a failure and redeliver.
 */
const RETENTION_MS = 30 * 24 * 3_600_000;
const PRUNE_EVERY_MS = 3_600_000;

const ERROR_MAX = 300;
const USER_AGENT = 'Talyn-Webhooks/1.0 (+https://talyn.dev)';

const db = () => getPoolDbClient();

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

function shortError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > ERROR_MAX ? `${message.slice(0, ERROR_MAX - 1)}…` : message;
}

// ---------------------------------------------------------------------------
// One HTTP request
// ---------------------------------------------------------------------------

export interface WebhookResponse {
  status: number;
  durationMs: number;
}

/**
 * POST one delivery. Connects only to an address `webhookLookup` allowed, and
 * follows no redirect. Resolves with the status once the headers arrive;
 * rejects on a refused address, a network error or the timeout.
 */
export function postWebhook(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  opts: { policy?: WebhookUrlPolicy; timeoutMs?: number } = {},
): Promise<WebhookResponse> {
  const policy = opts.policy ?? defaultWebhookUrlPolicy();
  const timeoutMs = opts.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  const started = Date.now();
  return new Promise<WebhookResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = parseWebhookUrl(rawUrl, policy);
    } catch (err) {
      reject(err);
      return;
    }
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    const req = transport.request(
      url,
      {
        method: 'POST',
        agent: false,
        lookup: webhookLookup(policy),
        headers: {
          ...headers,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'user-agent': USER_AGENT,
        },
      },
      (res) => {
        settled = true;
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, durationMs: Date.now() - started });
        // Read and drop the body; a receiver that keeps writing is cut off.
        res.resume();
        setTimeout(() => res.destroy(), 5_000).unref();
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error(`No response within ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

interface ClaimedDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  /** Matches the row's `claim_token` while this worker holds it. */
  token: string;
}

/** The exact bytes sent: the envelope's keys in their documented order. */
export function deliveryBody(payload: Record<string, unknown>): string {
  const { id, type, created_at, workspace_id, data, ...rest } = payload;
  return JSON.stringify({ id, type, created_at, workspace_id, data, ...rest });
}

export class WebhookDeliveryWorker {
  private timer: NodeJS.Timeout | null = null;
  private nudgeTimer: NodeJS.Timeout | null = null;
  private running = false;
  private lastPruneAt = 0;

  constructor(private readonly options: { policy?: WebhookUrlPolicy; timeoutMs?: number; batch?: number } = {}) {}

  init(): void {
    if (this.timer) return;
    debugBus.registerPoller(
      WEBHOOK_WORKER_POLLER,
      POLL_MS,
      'Sends public API webhook deliveries that are due, and retries failed ones on a schedule. A new delivery also wakes it at once.',
    );
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.timer = null;
    this.nudgeTimer = null;
  }

  /** Run a tick soon. Only when the worker runs on a timer; tests drive `tick()` themselves. */
  nudge(): void {
    if (!this.timer || this.nudgeTimer) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      void this.tick();
    }, 100);
    this.nudgeTimer.unref();
  }

  /** One pass. Returns the deliveries attempted. */
  async tick(now: () => Date = () => new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const started = Date.now();
    let attempted = 0;
    try {
      const batch = this.options.batch ?? BATCH;
      const claimed = await this.claim(batch);
      attempted = claimed.length;
      if (claimed.length > 0) {
        const endpoints = await endpointsForDelivery([...new Set(claimed.map((c) => c.endpointId))], now());
        await Promise.all(claimed.map((c) => this.deliver(c, endpoints.get(c.endpointId) ?? null, now)));
      }
      if (claimed.length === batch) this.nudge();
      if (Date.now() - this.lastPruneAt >= PRUNE_EVERY_MS) {
        this.lastPruneAt = Date.now();
        await pruneWebhookTables(now());
      }
      debugBus.pollerTick(WEBHOOK_WORKER_POLLER, { durationMs: Date.now() - started, ok: true, summary: `sent ${attempted}` });
    } catch (error) {
      debugBus.pollerTick(WEBHOOK_WORKER_POLLER, { durationMs: Date.now() - started, ok: false, error });
    } finally {
      this.running = false;
    }
    return attempted;
  }

  private async claim(limit: number): Promise<ClaimedDelivery[]> {
    const token = randomUUID();
    // The CTE runs once: `id IN (subquery LIMIT n)` can be re-run by the
    // planner and claim more than n rows.
    const result = await db().execute(sql`
      WITH due AS (
        SELECT d2.id FROM api_webhook_deliveries d2
        JOIN api_webhook_endpoints e ON e.id = d2.endpoint_id AND e.enabled
        WHERE d2.status = 'pending' AND d2.next_attempt_at <= now()
        ORDER BY d2.next_attempt_at
        LIMIT ${limit}
        FOR UPDATE OF d2 SKIP LOCKED
      )
      UPDATE api_webhook_deliveries d SET
        claim_token = ${token},
        next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS}),
        attempt_count = d.attempt_count + 1
      FROM due
      WHERE d.id = due.id AND d.status = 'pending' AND d.next_attempt_at <= now()
      RETURNING d.id, d.endpoint_id, d.event_id, d.payload, d.attempt_count
    `);
    return rowsOf<{ id: string; endpoint_id: string; event_id: string; payload: unknown; attempt_count: number }>(result).map((r) => ({
      id: r.id,
      endpointId: r.endpoint_id,
      eventId: r.event_id,
      payload: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<string, unknown>,
      attemptCount: Number(r.attempt_count),
      token,
    }));
  }

  private async deliver(
    claim: ClaimedDelivery,
    endpoint: { url: string; secrets: string[]; workspaceId: string | null; enabled: boolean } | null,
    now: () => Date,
  ): Promise<void> {
    const { token } = claim;
    if (!endpoint || !endpoint.enabled) {
      await settle(claim.id, token, { status: 'abandoned', lastError: 'The endpoint was disabled.' });
      return;
    }
    const body = deliveryBody(claim.payload);
    const headers = webhookHeaders(endpoint.secrets, claim.eventId, body, now());
    const workspaceId = typeof claim.payload.workspace_id === 'string' ? claim.payload.workspace_id : undefined;
    let origin = endpoint.url;
    try {
      // The path can hold a receiver's own token (Slack-style URLs): the debug log gets the origin only.
      origin = new URL(endpoint.url).origin;
    } catch {
      // Recorded as given; the send below fails on it.
    }

    let response: WebhookResponse | null = null;
    let error: unknown = null;
    const started = Date.now();
    try {
      response = await postWebhook(endpoint.url, body, headers, { policy: this.options.policy, timeoutMs: this.options.timeoutMs });
    } catch (err) {
      error = err;
    }
    const durationMs = response?.durationMs ?? Date.now() - started;
    const ok = response !== null && response.status >= 200 && response.status < 300;
    debugBus.recordHttp({
      service: 'api_webhooks',
      method: 'POST',
      url: origin,
      status: response?.status,
      durationMs,
      ok,
      ...(error ? { error } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    });

    if (ok) {
      await settle(claim.id, token, {
        status: 'succeeded',
        deliveredAt: now(),
        lastResponseStatus: response!.status,
        lastResponseMs: durationMs,
        lastError: null,
      });
      await db()
        .update(endpointsTable)
        .set({ consecutiveFailures: 0, failingSince: null })
        .where(and(eq(endpointsTable.id, claim.endpointId), sql`(${endpointsTable.consecutiveFailures} <> 0 OR ${endpointsTable.failingSince} IS NOT NULL)`));
      return;
    }

    const gone = response?.status === 410;
    const lastError = error
      ? shortError(error)
      : response && response.status >= 300 && response.status < 400
        ? `The endpoint answered ${response.status}. Redirects are not followed.`
        : `The endpoint answered ${response?.status ?? 0}.`;
    const final = gone || claim.attemptCount >= MAX_ATTEMPTS;
    const delay = RETRY_DELAYS_MS[Math.min(claim.attemptCount, RETRY_DELAYS_MS.length) - 1] ?? RETRY_DELAYS_MS[0];
    await settle(claim.id, token, {
      status: final ? 'failed' : 'pending',
      nextAttemptAt: final ? now() : new Date(now().getTime() + delay),
      lastResponseStatus: response?.status ?? null,
      lastResponseMs: response ? durationMs : null,
      lastError,
    });

    if (gone) {
      await disableEndpoint(claim.endpointId, 'The endpoint answered 410 Gone.', now());
      return;
    }
    const [streak] = await db()
      .update(endpointsTable)
      .set({
        consecutiveFailures: sql`${endpointsTable.consecutiveFailures} + 1`,
        failingSince: sql`COALESCE(${endpointsTable.failingSince}, now())`,
      })
      .where(eq(endpointsTable.id, claim.endpointId))
      .returning({ failures: endpointsTable.consecutiveFailures, since: endpointsTable.failingSince });
    if (
      streak &&
      streak.failures >= DISABLE_AFTER_FAILURES &&
      streak.since &&
      now().getTime() - streak.since.getTime() >= DISABLE_AFTER_MS
    ) {
      await disableEndpoint(
        claim.endpointId,
        `Every delivery failed for ${Math.round(DISABLE_AFTER_MS / 86_400_000)} days (${streak.failures} attempts in a row). Fix the receiver, then enable the endpoint again.`,
        now(),
      );
    }
  }
}

async function settle(
  id: string,
  token: string,
  set: Partial<{
    status: string;
    nextAttemptAt: Date;
    deliveredAt: Date;
    lastResponseStatus: number | null;
    lastResponseMs: number | null;
    lastError: string | null;
  }>,
): Promise<void> {
  await db()
    .update(deliveriesTable)
    .set({ ...set, claimToken: null })
    .where(and(eq(deliveriesTable.id, id), eq(deliveriesTable.claimToken, token)));
}

export async function disableEndpoint(id: string, reason: string, now: Date = new Date()): Promise<void> {
  await db()
    .update(endpointsTable)
    .set({ enabled: false, disabledReason: reason, disabledAt: now, updatedAt: now })
    .where(and(eq(endpointsTable.id, id), eq(endpointsTable.enabled, true)));
  await abandonPendingDeliveries(id);
}

/**
 * Hourly, on every replica (each statement is the same on each): delete old
 * finished deliveries and old announced states, and abandon pending rows of
 * disabled endpoints (a dispatcher with a stale cache can still add some).
 */
export async function pruneWebhookTables(now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_MS);
  await db()
    .delete(deliveriesTable)
    .where(and(ne(deliveriesTable.status, 'pending'), lt(deliveriesTable.createdAt, cutoff)));
  await db().delete(statesTable).where(lt(statesTable.updatedAt, cutoff));
  const disabled = db().select({ id: endpointsTable.id }).from(endpointsTable).where(eq(endpointsTable.enabled, false));
  await db()
    .update(deliveriesTable)
    .set({ status: 'abandoned', lastError: 'The endpoint was disabled.', claimToken: null })
    .where(and(eq(deliveriesTable.status, 'pending'), inArray(deliveriesTable.endpointId, disabled)));
}

export const webhookDeliveryWorker = new WebhookDeliveryWorker();
