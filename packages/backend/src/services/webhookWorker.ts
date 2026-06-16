import type { Redis } from 'ioredis';
import { createRedisConnection, isRedisEnabled } from './redis.js';
import { REPLICA_ID } from './wsBus.js';
import { targetsForRepo, refreshWebhookIndex } from './webhookIndex.js';
import { prMonitorService } from './prMonitor.js';
import { debugBus } from './debugBus.js';

/**
 * Drains the GitHub webhook ingest stream and turns each delivery into the
 * realtime work it implies.
 *
 * The receiver (routes/webhooks.ts) XADDs verified deliveries to a Redis Stream;
 * a consumer group lets every replica pull competitively so each delivery is
 * processed exactly once across the fleet. For a PR-affecting event we resolve
 * EVERY workspace watching the repo and `refreshPr` each — that one call
 * re-fetches the PR (state, checks, reviews, comments, mergeability) and upserts
 * it, which broadcasts `pull_request:updated`. A short coalescing window
 * collapses bursts (e.g. 20 check_runs for one suite) into a single refresh per
 * (workspace, PR).
 *
 * Inert when REDIS_URL is unset.
 */

export const WEBHOOK_STREAM = 'gh:webhooks';
const GROUP = 'fastowl';
const COALESCE_WINDOW_MS = 750;

/** The decoded envelope the receiver enqueues. */
export interface WebhookDelivery {
  deliveryId: string;
  eventType: string;
  action?: string;
  repoFullName: string;
  installationId?: string;
  enqueuedAtMs: number;
  payload: Record<string, unknown>;
}

// ---- Pure classification helpers (unit-tested) ---------------------------

/**
 * Whether an event should trigger a PR data refresh. installation* events are
 * handled separately (index/allowlist maintenance), not here.
 */
export function isRefreshEvent(eventType: string): boolean {
  return [
    'pull_request',
    'pull_request_review',
    'pull_request_review_comment',
    'issue_comment',
    'check_run',
    'check_suite',
  ].includes(eventType);
}

/**
 * The PR number(s) a delivery touches. Most events carry one; check_run /
 * check_suite reference an array (a commit can belong to several PRs).
 * `issue_comment` only counts when the issue is actually a PR. `status` carries
 * no PR number (commit-scoped) — returns [] (the reconcile sweep covers it).
 */
export function extractPrNumbers(eventType: string, payload: Record<string, unknown>): number[] {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isInteger(v) ? v : null;
  const fromArray = (arr: unknown): number[] =>
    Array.isArray(arr)
      ? arr.map((p) => num((p as { number?: unknown })?.number)).filter((n): n is number => n !== null)
      : [];

  switch (eventType) {
    case 'pull_request': {
      const n = num((payload.pull_request as { number?: unknown })?.number) ?? num(payload.number);
      return n !== null ? [n] : [];
    }
    case 'pull_request_review':
    case 'pull_request_review_comment': {
      const n = num((payload.pull_request as { number?: unknown })?.number);
      return n !== null ? [n] : [];
    }
    case 'issue_comment': {
      const issue = payload.issue as { number?: unknown; pull_request?: unknown } | undefined;
      if (!issue?.pull_request) return []; // a plain issue, not a PR
      const n = num(issue.number);
      return n !== null ? [n] : [];
    }
    case 'check_run':
      return fromArray((payload.check_run as { pull_requests?: unknown })?.pull_requests);
    case 'check_suite':
      return fromArray((payload.check_suite as { pull_requests?: unknown })?.pull_requests);
    default:
      return [];
  }
}

// ---- Coalescing ----------------------------------------------------------

const recentRefresh = new Map<string, number>();

function shouldRefresh(key: string, nowMs: number): boolean {
  const last = recentRefresh.get(key);
  if (last !== undefined && nowMs - last < COALESCE_WINDOW_MS) return false;
  recentRefresh.set(key, nowMs);
  // Opportunistic prune so the map can't grow unbounded.
  if (recentRefresh.size > 5_000) {
    for (const [k, t] of recentRefresh) {
      if (nowMs - t > COALESCE_WINDOW_MS) recentRefresh.delete(k);
    }
  }
  return true;
}

// ---- Delivery processing --------------------------------------------------

/**
 * Fan one delivery out to every watching workspace. Returns the number of
 * (workspace, PR) refreshes actually dispatched (post-coalescing). Exported for
 * tests. `nowMs` is injectable for deterministic coalescing assertions.
 */
export async function processWebhookDelivery(
  delivery: WebhookDelivery,
  nowMs: number = Date.now(),
): Promise<number> {
  // installation lifecycle: keep the watch index + allowlist current.
  if (delivery.eventType === 'installation' || delivery.eventType === 'installation_repositories') {
    await refreshWebhookIndex().catch(() => undefined);
    return 0;
  }
  if (!isRefreshEvent(delivery.eventType)) return 0;

  const numbers = extractPrNumbers(delivery.eventType, delivery.payload);
  if (numbers.length === 0) return 0;

  const targets = await targetsForRepo(delivery.repoFullName);
  if (targets.length === 0) return 0;

  let dispatched = 0;
  for (const target of targets) {
    for (const number of numbers) {
      const key = `${target.workspaceId}:${delivery.repoFullName.toLowerCase()}:${number}`;
      if (!shouldRefresh(key, nowMs)) continue;
      dispatched += 1;
      await prMonitorService
        .refreshPr(target.workspaceId, target.owner, target.repo, number)
        .catch((err) => {
          console.error(`[webhookWorker] refreshPr ${delivery.repoFullName}#${number} failed:`, err);
        });
    }
  }
  return dispatched;
}

// ---- Stream consumer ------------------------------------------------------

function fieldsToObject(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
  return obj;
}

class WebhookWorker {
  private conn: Redis | null = null;
  private running = false;

  async init(): Promise<void> {
    if (!isRedisEnabled()) {
      console.log('[webhookWorker] REDIS_URL unset — webhook worker disabled');
      return;
    }
    this.conn = createRedisConnection('webhook-worker');
    if (!this.conn) return;
    debugBus.registerPoller(
      'webhook_worker',
      0,
      'Drains the GitHub webhook Redis Stream and fans deliveries out to PR refreshes.',
    );
    try {
      await this.conn.xgroup('CREATE', WEBHOOK_STREAM, GROUP, '$', 'MKSTREAM');
    } catch (err) {
      // BUSYGROUP = group already exists; anything else is unexpected.
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) {
        console.error('[webhookWorker] xgroup create failed:', err);
      }
    }
    this.running = true;
    void this.loop();
    console.log(`[webhookWorker] consuming ${WEBHOOK_STREAM} as ${REPLICA_ID}`);
  }

  private async loop(): Promise<void> {
    while (this.running && this.conn) {
      try {
        const res = (await this.conn.xreadgroup(
          'GROUP',
          GROUP,
          REPLICA_ID,
          'COUNT',
          10,
          'BLOCK',
          5_000,
          'STREAMS',
          WEBHOOK_STREAM,
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;
        if (!res) continue;
        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            await this.handleEntry(id, fieldsToObject(fields));
          }
        }
      } catch (err) {
        if (this.running) {
          console.error('[webhookWorker] read loop error:', err);
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
    }
  }

  private async handleEntry(id: string, fields: Record<string, string>): Promise<void> {
    const startedAt = Date.now();
    let delivery: WebhookDelivery | null = null;
    try {
      delivery = JSON.parse(fields.data) as WebhookDelivery;
      const fanout = await processWebhookDelivery(delivery);
      debugBus.recordWebhook({
        action: 'processed',
        eventType: delivery.eventType,
        delivery: delivery.deliveryId,
        ok: true,
        fanout,
        latencyMs: delivery.enqueuedAtMs ? startedAt - delivery.enqueuedAtMs : undefined,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      debugBus.recordWebhook({
        action: 'processed',
        eventType: delivery?.eventType ?? 'unknown',
        ok: false,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Ack regardless: a delivery that throws is logged; the reconcile sweep is
      // the safety net for missed work. Leaving it un-acked would wedge the PEL.
      await this.conn?.xack(WEBHOOK_STREAM, GROUP, id).catch(() => undefined);
      debugBus.pollerTick('webhook_worker', {
        durationMs: Date.now() - startedAt,
        ok: true,
        summary: `webhook_worker processed ${delivery?.eventType ?? '?'} `,
      });
    }
  }

  shutdown(): void {
    this.running = false;
    void this.conn?.quit().catch(() => undefined);
    this.conn = null;
  }
}

export const webhookWorker = new WebhookWorker();

/** Test helper — clear the coalescing window. */
export function _resetCoalesce(): void {
  recentRefresh.clear();
}
