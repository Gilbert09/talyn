import { and, eq } from 'drizzle-orm';
import { prNeedsFollowup, buildPostHogPrompt, type PRMergeableSummary } from '@fastowl/shared';
import { getDbClient } from '../db/client.js';
import { pullRequests as pullRequestsTable } from '../db/schema.js';
import { createCloudTask } from './taskCreate.js';
import { prMonitorService } from './prMonitor.js';
import { githubService } from './github.js';
import { emitPullRequestUpdated } from './websocket.js';
import { broadcastMergeQueuePositions } from './mergeQueueBroadcast.js';
import { debugBus } from './debugBus.js';
import { ACTIVE_STATUSES, linkedTaskStatus, resolvePostHogEnvId } from './prCloudFix.js';

const POLL_INTERVAL_MS = 10_000;
/** Re-poll a queued PR if its cached summary is older than this. */
const FRESHNESS_MS = 90_000;
/** Stop auto-firing fix runs after this many consecutive un-mergeable runs. */
const MAX_ATTEMPTS = 3;

type MergeMethod = 'merge' | 'squash' | 'rebase';
type QueueStatus = 'waiting' | 'fixing' | 'merging' | 'blocked';

interface MergeQueueState {
  attempts: number;
  lastFixTaskId?: string;
  /** Whether `lastFixTaskId`'s terminal result has been folded into attempts. */
  accounted?: boolean;
  status: QueueStatus;
  lastError?: string;
  lastErrorAt?: string;
}

type PRRow = typeof pullRequestsTable.$inferSelect;

function readState(row: PRRow): MergeQueueState {
  const s = (row.mergeQueueState as MergeQueueState | null) ?? null;
  return {
    attempts: s?.attempts ?? 0,
    lastFixTaskId: s?.lastFixTaskId,
    accounted: s?.accounted ?? true,
    status: s?.status ?? 'waiting',
    lastError: s?.lastError,
    lastErrorAt: s?.lastErrorAt,
  };
}

/** Compact queue state for the desktop (toggle + badge). `position` is 1-based. */
function publicState(s: MergeQueueState, position: number): {
  status: QueueStatus;
  attempts: number;
  position: number;
} {
  return { status: s.status, attempts: s.attempts, position };
}

function baseBranchOf(row: PRRow): string {
  return (row.lastSummary as { baseBranch?: string } | null)?.baseBranch ?? '';
}

function mergeStateOf(row: PRRow): string {
  return (
    (row.lastSummary as { mergeStateStatus?: string } | null)?.mergeStateStatus ?? 'UNKNOWN'
  ).toUpperCase();
}

/**
 * Behind / blocked-by-out-of-date is a queue blocker that `prNeedsFollowup`
 * misses — it's exactly the state every sibling PR lands in after one merges to
 * the shared base. Funnel it into the same cloud fix run, which merges the base
 * branch in and brings the branch current.
 */
function needsUpdate(row: PRRow): boolean {
  const s = mergeStateOf(row);
  return s === 'BEHIND' || s === 'BLOCKED';
}

function queueBlocked(row: PRRow, summary: PRMergeableSummary): boolean {
  return prNeedsFollowup(summary) || needsUpdate(row);
}

function normalizeMethod(raw: unknown): MergeMethod {
  return raw === 'merge' || raw === 'rebase' ? raw : 'squash';
}

/**
 * Merges the PRs in the FastOwl merge queue one-by-one, serialized per
 * (workspace, repo, base branch). Each tick:
 *
 *   1. Load every queued open PR, FIFO by `merge_queued_at`.
 *   2. Group by (workspace, repo, base) — only same-base merges collide.
 *   3. Act on the HEAD of each group (earliest queued). Because there's one
 *      head per group, the single-threaded `ticking` guard, and the merge is a
 *      synchronous awaited REST call, two same-base PRs can never both merge in
 *      a tick — while distinct groups proceed independently.
 *
 * Per head: refresh stale state, then merge if clean, or fire the shared
 * "take this PR to a clean, mergeable state" cloud run on conflict / behind /
 * blocked, wait for it (active-task guard), retry, and drop the PR off the
 * queue once merged — which promotes the next same-base PR to head.
 */
class MergeQueueProcessor {
  private interval: NodeJS.Timeout | null = null;
  private ticking = false;

  init(): void {
    if (this.interval) return;
    debugBus.registerPoller(
      'merge_queue',
      POLL_INTERVAL_MS,
      'Merges queued PRs one-by-one, serialized per (workspace, repo, base branch) — merges the head when clean, or fires a cloud fix run on conflict/behind/blocked, then promotes the next PR.',
    );
    this.interval = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  shutdown(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Test entry point — run a single tick synchronously. */
  async runOnce(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const startedAt = Date.now();
    let headCount = 0;
    let tickError: string | undefined;
    let skipRecord = false;
    try {
      const db = getDbClient();
      const rows = await db
        .select()
        .from(pullRequestsTable)
        .where(
          and(
            eq(pullRequestsTable.mergeQueued, true),
            eq(pullRequestsTable.state, 'open')
          )
        )
        .orderBy(pullRequestsTable.mergeQueuedAt);

      // Group by (workspace, repo, base) and take the head (earliest queued)
      // of each — `rows` is already FIFO-ordered, so the first row seen per
      // key is the head, and its 1-based position within the group is the
      // running count.
      const heads: PRRow[] = [];
      const groupSizeByKey = new Map<string, number>();
      for (const row of rows) {
        const key = `${row.workspaceId}|${row.repositoryId}|${baseBranchOf(row)}`;
        const seen = groupSizeByKey.get(key) ?? 0;
        if (seen === 0) heads.push(row);
        groupSizeByKey.set(key, seen + 1);
      }

      headCount = heads.length;
      for (const head of heads) {
        try {
          await this.processHead(head);
        } catch (err) {
          // One PR failing must never abort the tick — retry next time.
          console.warn(
            `[mergeQueueProcessor] failed for PR ${head.owner}/${head.repo}#${head.number}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('DATABASE_URL is not set')) {
        skipRecord = true;
        return;
      }
      tickError = msg;
      console.error('[mergeQueueProcessor] tick error:', err);
    } finally {
      this.ticking = false;
      if (!skipRecord) {
        debugBus.pollerTick('merge_queue', {
          durationMs: Date.now() - startedAt,
          ok: !tickError,
          summary: tickError
            ? `merge_queue tick failed: ${tickError}`
            : `merge_queue tick — ${headCount} head${headCount === 1 ? '' : 's'}`,
          error: tickError,
        });
      }
    }
  }

  private async processHead(initialRow: PRRow): Promise<void> {
    const db = getDbClient();

    // 1. Freshness — refetch a stale summary so behind/conflict detection is
    //    current. A stale BEHIND head would otherwise be merge-attempted and
    //    bounce with `merged:false`.
    let row = initialRow;
    if (Date.now() - new Date(row.lastPolledAt).getTime() > FRESHNESS_MS) {
      await prMonitorService
        .refreshPr(row.workspaceId, row.owner, row.repo, row.number)
        .catch(() => {});
      const reread = await db
        .select()
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, row.id))
        .limit(1);
      if (reread[0]) row = reread[0];
    }

    // The PR may have merged/closed underneath us. Drop it off the queue so it
    // never blocks the group, and stop.
    if (row.state !== 'open') {
      if (row.mergeQueued) await this.dequeue(row);
      return;
    }
    if (!row.mergeQueued) return;

    const summary = row.lastSummary as PRMergeableSummary;
    const state = readState(row);

    // 2. Active-task guard — a fix run for this PR is still working; leave it.
    const linkedStatus = await linkedTaskStatus(row.taskId);
    if (linkedStatus && ACTIVE_STATUSES.has(linkedStatus)) {
      await this.ensureStatus(row, state, 'fixing');
      return;
    }

    // 3. Account the last fix run now that it's terminal.
    if (state.lastFixTaskId && !state.accounted) {
      if (queueBlocked(row, summary)) {
        state.attempts += 1;
        if (state.attempts >= MAX_ATTEMPTS) state.status = 'blocked';
      } else {
        state.attempts = 0;
      }
      state.accounted = true;
      await this.persist(row, state);
    }

    // 4. Gave up after MAX_ATTEMPTS — wait for the user (or a clean observation).
    if (state.status === 'blocked') {
      // Re-arm if it's since gone clean.
      if (!queueBlocked(row, summary)) {
        state.status = 'waiting';
        state.attempts = 0;
        await this.persist(row, state);
      } else {
        return;
      }
    }

    // 5. Clean path — mergeable AND up-to-date → merge it.
    if (!queueBlocked(row, summary)) {
      state.status = 'merging';
      await this.persist(row, state);
      try {
        const result = await githubService.mergePullRequest(
          row.workspaceId,
          row.owner,
          row.repo,
          row.number,
          { merge_method: normalizeMethod(row.mergeMethod) }
        );
        if (!result.merged) {
          // GitHub accepted the request but didn't merge (e.g. it lost a race
          // and is now behind). Stay queued; next tick's refresh sees BEHIND
          // and funnels into the fix path.
          state.status = 'waiting';
          state.lastError = result.message || 'GitHub did not merge the pull request';
          state.lastErrorAt = new Date().toISOString();
          await this.persist(row, state);
          return;
        }
        // Success — flip the row terminal (the merge route can't GraphQL-refetch
        // a merged PR either) and drop it off the queue. The next same-base PR
        // becomes head on the next tick automatically.
        await db
          .update(pullRequestsTable)
          .set({
            state: 'merged',
            mergedAt: new Date(),
            mergeQueued: false,
            mergeQueuedAt: null,
            mergeQueueState: null,
            updatedAt: new Date(),
          })
          .where(eq(pullRequestsTable.id, row.id));
        emitPullRequestUpdated(row.workspaceId, {
          id: row.id,
          taskId: row.taskId,
          repositoryId: row.repositoryId,
          owner: row.owner,
          repo: row.repo,
          number: row.number,
          state: 'merged',
          lastSummary: row.lastSummary as Record<string, unknown>,
          mergeQueued: false,
          mergeQueueState: null,
        });
        // The merged PR left its group — reshuffle the survivors' "#N" badges
        // (e.g. #2 → #1) instead of leaving them stale until a refresh.
        await broadcastMergeQueuePositions(row.workspaceId);
      } catch (err) {
        // 405 not-actually-mergeable, network, etc. Don't dequeue; record + retry.
        state.status = 'waiting';
        state.lastError = err instanceof Error ? err.message : 'Merge failed';
        state.lastErrorAt = new Date().toISOString();
        await this.persist(row, state);
      }
      return;
    }

    // 6. Blocked path — conflict / changes / failing CI / unresolved threads /
    //    BEHIND / BLOCKED. Funnel all of these into the SAME cloud fix run (it
    //    merges the base in, curing both conflicts and BEHIND in one run).
    const envId = await resolvePostHogEnvId(row.workspaceId);
    if (!envId) {
      // No connected PostHog Code env — can't dispatch. Keep waiting; the
      // desktop badge surfaces this.
      await this.ensureStatus(row, state, 'waiting');
      return;
    }

    const ref = `${row.owner}/${row.repo}#${row.number}`;
    const prTitle = (row.lastSummary as { title?: string } | null)?.title ?? '';
    const created = await createCloudTask({
      workspaceId: row.workspaceId,
      type: 'pr_response',
      title: `Get ${ref} mergeable (merge queue)`,
      description: `Merge queue: take ${ref} ("${prTitle}") to a clean, mergeable, up-to-date state via PostHog Code.`,
      prompt: buildPostHogPrompt({
        owner: row.owner,
        repo: row.repo,
        number: row.number,
        summary,
      }),
      repositoryId: row.repositoryId,
      assignedEnvironmentId: envId,
      pullRequestId: row.id,
    });

    state.lastFixTaskId = created.id;
    state.accounted = false;
    state.status = 'fixing';
    await this.persist(row, state);
  }

  /** Persist `status` only if it changed, emitting a WS echo when it does. */
  private async ensureStatus(
    row: PRRow,
    state: MergeQueueState,
    status: QueueStatus
  ): Promise<void> {
    if (state.status === status) return;
    state.status = status;
    await this.persist(row, state);
  }

  /** Drop a no-longer-open PR off the queue. */
  private async dequeue(row: PRRow): Promise<void> {
    const db = getDbClient();
    await db
      .update(pullRequestsTable)
      .set({
        mergeQueued: false,
        mergeQueuedAt: null,
        mergeQueueState: null,
        updatedAt: new Date(),
      })
      .where(eq(pullRequestsTable.id, row.id));
    emitPullRequestUpdated(row.workspaceId, {
      id: row.id,
      taskId: row.taskId,
      repositoryId: row.repositoryId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      state: row.state,
      lastSummary: row.lastSummary as Record<string, unknown>,
      mergeQueued: false,
      mergeQueueState: null,
    });
    // Dropping out of the queue shifts the survivors' positions — rebroadcast.
    await broadcastMergeQueuePositions(row.workspaceId);
  }

  private async persist(row: PRRow, state: MergeQueueState): Promise<void> {
    const db = getDbClient();
    await db
      .update(pullRequestsTable)
      .set({ mergeQueueState: state, updatedAt: new Date() })
      .where(eq(pullRequestsTable.id, row.id));
    emitPullRequestUpdated(row.workspaceId, {
      id: row.id,
      taskId: row.taskId,
      repositoryId: row.repositoryId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      state: row.state,
      lastSummary: row.lastSummary as Record<string, unknown>,
      mergeQueued: row.mergeQueued,
      // The processor only ever acts on a group's head → position 1.
      mergeQueueState: publicState(state, 1),
    });
  }
}

export const mergeQueueProcessor = new MergeQueueProcessor();
