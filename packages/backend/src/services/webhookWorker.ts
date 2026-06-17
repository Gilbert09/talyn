import type { Redis } from 'ioredis';
import { createRedisConnection, isRedisEnabled } from './redis.js';
import { REPLICA_ID } from './wsBus.js';
import { targetsForRepo, refreshWebhookIndex } from './webhookIndex.js';
import { prMonitorService } from './prMonitor.js';
import { githubService } from './github.js';
import { debugBus } from './debugBus.js';
import {
  ingestCheckRun,
  parseCheckRunPayload,
  pruneChecksForSha,
} from './checkCounts.js';

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
// How many stream deliveries to read and process concurrently per loop. Each
// delivery's slow step is an independent GitHub GraphQL refresh, so processing a
// batch in parallel (rather than serially) multiplies throughput by ~this much.
// Bounded to keep simultaneous GraphQL/DB load reasonable.
const WORKER_BATCH = 10;

// Opt-in deep trace of the webhook pipeline (set WEBHOOK_TRACE=1). Logs every
// step a delivery takes — received → fanout → dispatch/coalesce → refresh →
// resolved state — so a "why didn't my merge update?" can be followed end to
// end in stdout. Off by default: with org-wide ("All repositories") install
// access this is a firehose, so it's a deliberate, temporary debug switch.
export const WEBHOOK_TRACE =
  process.env.WEBHOOK_TRACE === '1' || process.env.WEBHOOK_TRACE === 'true';
export function whTrace(msg: string): void {
  if (WEBHOOK_TRACE) console.log(`[wh-trace] ${msg}`);
}

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
  whTrace(
    `recv ${delivery.eventType}/${delivery.action ?? '-'} ` +
      `${delivery.repoFullName || '(no repo)'} delivery=${delivery.deliveryId}`,
  );

  // installation lifecycle: keep the repo watch index + the account→installation
  // index current (the latter so data-plane reads resolve a newly-(un)installed
  // account immediately, across replicas).
  if (delivery.eventType === 'installation' || delivery.eventType === 'installation_repositories') {
    await refreshWebhookIndex().catch(() => undefined);
    await githubService.refreshInstallationIndex().catch(() => undefined);
    return 0;
  }

  const targets = await targetsForRepo(delivery.repoFullName);
  if (targets.length === 0) {
    whTrace(`  └ ${delivery.repoFullName}: no watching workspace — dropped`);
    return 0;
  }

  // A push to a branch advances it; every OPEN PR targeting that branch as its
  // base may have just become (un)conflicting, and GitHub fires no per-PR event
  // for that. Refresh each such PR (mergeability resolves inline in refreshPr).
  if (delivery.eventType === 'push') {
    const ref = typeof delivery.payload.ref === 'string' ? delivery.payload.ref : '';
    if (!ref.startsWith('refs/heads/')) return 0;
    const branch = ref.slice('refs/heads/'.length);
    let dispatched = 0;
    for (const target of targets) {
      const numbers = await prMonitorService
        .openPrNumbersForBase(target.workspaceId, target.repositoryId, branch)
        .catch(() => [] as number[]);
      whTrace(
        `  push ${delivery.repoFullName}@${branch} → open PRs on this base=[${numbers.join(',')}]`,
      );
      for (const number of numbers) {
        dispatched += await refreshTarget(target, number, delivery.repoFullName, nowMs, 'push');
      }
    }
    return dispatched;
  }

  if (!isRefreshEvent(delivery.eventType)) {
    whTrace(`  └ ${delivery.eventType}: not a refresh event — ignored`);
    return 0;
  }
  const numbers = extractPrNumbers(delivery.eventType, delivery.payload);
  if (numbers.length === 0) {
    whTrace(
      `  └ ${delivery.eventType}/${delivery.action ?? '-'} ${delivery.repoFullName}: ` +
        `no PR number on payload — ignored`,
    );
    return 0;
  }
  whTrace(
    `  ${delivery.eventType}/${delivery.action ?? '-'} ${delivery.repoFullName} ` +
      `PRs=[${numbers.join(',')}] → ${targets.length} workspace(s)`,
  );

  // check_suite carries no per-check data — the individual check_run events do —
  // so it's a no-op for the incremental count path. Skipping it removes a big
  // slice of the firehose; the per-check_run updates + the sweep keep counts live.
  if (delivery.eventType === 'check_suite') {
    whTrace(`  check_suite ${delivery.repoFullName}: no-op (counts come from check_run)`);
    return 0;
  }

  // check_run: update the pill counts INCREMENTALLY from the webhook — no GraphQL
  // refresh. One query says which of the check's PRs each workspace tracks (a
  // single check_run can list several, incl. cross-fork junk); untracked PRs cost
  // nothing past it. See docs/INCREMENTAL_CHECK_COUNTS.md.
  if (delivery.eventType === 'check_run') {
    const trackedByRepo = await prMonitorService
      .filterTrackedOpenAcross(
        targets.map((t) => t.repositoryId),
        numbers,
      )
      .catch(() => new Map<string, Set<number>>());
    const ev = parseCheckRunPayload(delivery.payload, delivery.repoFullName);
    if (!ev) return 0;
    const updated = await ingestCheckRun(ev, targets, numbers, trackedByRepo).catch((err) => {
      // drizzle wraps the driver error: `err.message` is just "Failed query: …",
      // the real Postgres error (code + message) is on `err.cause`.
      const cause = (err as { cause?: unknown }).cause;
      const causeMsg =
        cause instanceof Error
          ? `${cause.message}${(cause as { code?: string }).code ? ` [${(cause as { code?: string }).code}]` : ''}`
          : '';
      console.warn(
        `[webhookWorker] ingestCheckRun ${delivery.repoFullName}: ${err instanceof Error ? err.message : String(err)}${causeMsg ? ` | cause: ${causeMsg}` : ''}`,
      );
      return 0;
    });
    if (updated > 0) {
      whTrace(
        `  check_run ${delivery.repoFullName} ${ev.name}=${ev.state} → ${updated} PR(s) updated (incremental)`,
      );
      return updated;
    }
    // Incremental applied to nothing even though we track PR(s) on this check —
    // the row is an unmaterialised placeholder (e.g. a just-opened cloud-task PR,
    // title still empty) or its cached headSha is stale. Fall back to a full
    // refresh to backfill the summary + head; subsequent checks then go
    // incremental. Coalesced, so this is at most one refresh per stale PR.
    let dispatched = 0;
    for (const target of targets) {
      for (const number of trackedByRepo.get(target.repositoryId) ?? []) {
        dispatched += await refreshTarget(target, number, delivery.repoFullName, nowMs, 'check_run');
      }
    }
    if (dispatched > 0) {
      whTrace(
        `  check_run ${delivery.repoFullName} ${ev.name}=${ev.state} → ` +
          `${dispatched} stale/placeholder PR(s) → full-refresh fallback`,
      );
    }
    return dispatched;
  }

  // A PR closing/merging or force-pushing makes its per-check state irrelevant —
  // prune it (the count fast-path stays bounded to open, tracked PRs). Done
  // alongside the normal refresh below, which still materialises the PR row.
  if (delivery.eventType === 'pull_request') {
    await pruneOnPullRequest(delivery).catch(() => undefined);
  }

  // Everything else (pull_request actions, reviews, comments): a full refresh
  // that materialises/updates the row (mergeable, reviews, authoritative counts).
  let dispatched = 0;
  for (const target of targets) {
    for (const number of numbers) {
      dispatched += await refreshTarget(target, number, delivery.repoFullName, nowMs, delivery.eventType);
    }
  }
  return dispatched;
}

/**
 * Drop per-check state a `pull_request` event has made stale: the head commit on
 * close/merge (the PR is done), and the *previous* head on a force-push
 * (`synchronize` carries `before`/`after`; checks on `before` no longer count).
 */
async function pruneOnPullRequest(delivery: WebhookDelivery): Promise<void> {
  const pr = delivery.payload.pull_request as { head?: { sha?: string } } | undefined;
  if (delivery.action === 'closed') {
    const sha = pr?.head?.sha;
    if (typeof sha === 'string') await pruneChecksForSha(delivery.repoFullName, sha);
  } else if (delivery.action === 'synchronize') {
    const before = delivery.payload.before;
    if (typeof before === 'string') await pruneChecksForSha(delivery.repoFullName, before);
  }
}

/** Coalesced single-PR refresh for one watching workspace. Returns 1 if dispatched, 0 if coalesced. */
async function refreshTarget(
  target: { workspaceId: string; owner: string; repo: string; repositoryId: string },
  number: number,
  repoFullName: string,
  nowMs: number,
  eventType: string,
): Promise<number> {
  const key = `${target.workspaceId}:${repoFullName.toLowerCase()}:${number}`;
  if (!shouldRefresh(key, nowMs)) {
    whTrace(`    coalesced ${repoFullName}#${number} (${eventType}) — refreshed <${COALESCE_WINDOW_MS}ms ago`);
    return 0;
  }
  // Pass the index-resolved repositoryId so refreshPr skips its getWatchedRepos
  // DB round-trip. Webhook refreshes never block on `mergeable: UNKNOWN` — the
  // sweep / a follow-up event settles it (keeps the consumer draining fast).
  whTrace(`    dispatch ${repoFullName}#${number} (${eventType}) → refreshPr`);
  await prMonitorService
    .refreshPr(target.workspaceId, target.owner, target.repo, number, {
      repositoryId: target.repositoryId,
      resolveMergeable: false,
    })
    .then(() => whTrace(`    done ${repoFullName}#${number} (${eventType})`))
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      // Benign on busy repos: the number is an ISSUE (issues + PRs share a
      // numbering space, and a check_run/check_suite/comment can reference one)
      // or a transferred/deleted PR. Not an error — record where it came from on
      // the Debug bus (not stdout) so the source is traceable without spam.
      if (/Could not resolve to a PullRequest/i.test(msg)) {
        debugBus.recordWebhook({
          action: 'processed',
          eventType,
          repo: repoFullName,
          prNumbers: [number],
          ok: true,
          fanout: 0,
          dropReason: 'not_a_pr',
        });
        return;
      }
      // One concise line, no stack — operational, not a crash.
      console.warn(`[webhookWorker] refreshPr (${eventType}) ${repoFullName}#${number}: ${msg}`);
    });
  return 1;
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
          WORKER_BATCH,
          'BLOCK',
          5_000,
          'STREAMS',
          WEBHOOK_STREAM,
          '>',
        )) as Array<[string, Array<[string, string[]]>]> | null;
        if (!res) continue;
        // Process the batch CONCURRENTLY rather than one-at-a-time. Each
        // delivery's expensive step (refreshPr → GitHub GraphQL, ~1-2s for a big
        // PR) is independent, so serial processing capped throughput at
        // 1/latency and let the firehose back up. handleEntry is self-contained
        // (its own try/catch + xack), so a failure in one never rejects the
        // batch. Concurrency is bounded by WORKER_BATCH (the read COUNT), which
        // keeps simultaneous GraphQL/DB load in check.
        const batch = res.flatMap(([, entries]) => entries);
        await Promise.all(
          batch.map(([id, fields]) => this.handleEntry(id, fieldsToObject(fields))),
        );
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
      // Definitive consumer-lag readout: how long this delivery sat between the
      // receiver enqueuing it and the worker starting it. Reading this directly
      // beats inferring lag from UUID gaps in a noisy log buffer.
      const lagMs = delivery.enqueuedAtMs ? startedAt - delivery.enqueuedAtMs : -1;
      whTrace(
        `entry ${delivery.eventType}/${delivery.action ?? '-'} ${delivery.repoFullName} ` +
          `lag=${(lagMs / 1000).toFixed(1)}s fanout=${fanout} took=${Date.now() - startedAt}ms`,
      );
      debugBus.recordWebhook({
        action: 'processed',
        eventType: delivery.eventType,
        ghAction: delivery.action,
        repo: delivery.repoFullName,
        prNumbers: extractPrNumbers(delivery.eventType, delivery.payload),
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
        ghAction: delivery?.action,
        repo: delivery?.repoFullName,
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
