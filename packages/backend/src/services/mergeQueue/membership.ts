import { eq } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import {
  mergeQueueEntries as mergeQueueEntriesTable,
  pullRequests as pullRequestsTable,
} from '../../db/schema.js';
import { runWithoutScope } from '../../db/client.js';
import { disableAutoMerge, markReadyForReview } from '../githubAutoMerge.js';
import { prMonitorService } from '../prMonitor.js';
import { emitPullRequestUpdated } from '../websocket.js';
import { broadcastMergeQueuePositions, noteMergeQueueEmitted } from '../mergeQueueBroadcast.js';
import { onQueueMembershipChanged } from './triggers.js';
import { closeActiveEntry, ensureActiveEntry, getActiveEntryForPr } from './store.js';
import type { MergeMethod } from './types.js';

/**
 * Joining and leaving Talyn's merge queue.
 *
 * This used to be three closures inside `routes/pullRequests.ts`, reachable
 * only from an HTTP handler. It moved here when workflows gained an
 * `enqueue_merge_queue` action: a second implementation would have drifted from
 * the first, which is the very thing `applyQueueMembership`'s own comment warns
 * about — a caller that skipped the auto-merge disarm or the entry write is a
 * silent hole, and the failure shows up as GitHub merging a PR the user pulled
 * out of the queue.
 *
 * The split between the two exported entry points is per-PR vs per-CALL:
 * `applyQueueMembership` is the bookkeeping for ONE pull request, and
 * `setQueueMembership` is everything that should happen once however many PRs
 * are involved (the billing gate's advisory lock, the position broadcast, the
 * pipeline kick). The stack endpoint needs them apart — N of the first, one of
 * the second.
 */

/**
 * The PR columns queue membership touches. `routes/pullRequests.ts`'s
 * `PRFlagRow` is a structural superset, so it passes straight in.
 */
export type QueueMembershipRow = Pick<
  typeof pullRequestsTable.$inferSelect,
  | 'id'
  | 'workspaceId'
  | 'taskId'
  | 'repositoryId'
  | 'owner'
  | 'repo'
  | 'number'
  | 'state'
  | 'lastSummary'
  | 'mergeQueuedAt'
>;

/**
 * Apply queue membership to ONE PR: the pull_requests bookkeeping plus the
 * merge_queue_entries write. Extracted so the single-PR toggle, the stack batch
 * and the workflow action can't drift — the batch is exactly N of these, and a
 * member that skipped the disarm or the entry write would be a silent hole.
 *
 * Deliberately does NOT gate on billing, publish drafts, broadcast, or kick the
 * pipeline: those are per-CALL, not per-PR, and doing them here would mean N
 * advisory locks and N broadcasts for one user action. See
 * {@link setQueueMembership}.
 */
export async function applyQueueMembership(
  row: QueueMembershipRow,
  opts: { enabled: boolean; method: string; trigger: string }
): Promise<void> {
  const db = getDbClient();
  const { enabled, method } = opts;
  // Enabling: arm a fresh guard so the next processor tick acts immediately,
  // and preserve the queue place on a fast off/on toggle. Disabling: clear
  // all queue bookkeeping.
  await db
    .update(pullRequestsTable)
    .set({
      mergeQueued: enabled,
      mergeQueuedAt: enabled ? (row.mergeQueuedAt ?? new Date()) : null,
      mergeMethod: method,
      updatedAt: new Date(),
    })
    .where(eq(pullRequestsTable.id, row.id));

  // Membership into merge_queue_entries — the queue the pipeline actually
  // drives. Best-effort: a failure here must never break the toggle.
  try {
    const summary = row.lastSummary as { baseBranch?: string; headSha?: string } | null;
    if (enabled) {
      await ensureActiveEntry({
        pullRequestId: row.id,
        workspaceId: row.workspaceId,
        repositoryId: row.repositoryId,
        baseBranch: summary?.baseBranch ?? '',
        mergeMethod: method as MergeMethod,
        headSha: summary?.headSha ?? '',
        trigger: opts.trigger,
      });
    } else {
      const closed = await closeActiveEntry(row.id, 'removed', {
        trigger: opts.trigger,
        message: 'Removed from the merge queue.',
      });
      // A dequeued PR must NOT keep a Talyn-armed auto-merge on GitHub —
      // GitHub would merge it after the user explicitly pulled it. User-armed
      // auto-merges are left alone — we never disarm what we didn't arm.
      //
      // The flag is written FIRST, on the caller's transaction, and the GitHub
      // call runs off it. A GitHub call made while this transaction holds the
      // PR row keeps the row locked for as long as GitHub takes, and every
      // other writer of that row holds a pool connection while it waits. On
      // 2026-10-12 that pattern filled the pool twice and the DB watchdog
      // restarted production. If the call fails, the reconciler retries it.
      if (closed?.automergeArmedBy === 'talyn') {
        await db
          .update(mergeQueueEntriesTable)
          .set({ pendingDisarm: true, updatedAt: new Date() })
          .where(eq(mergeQueueEntriesTable.id, closed.id));
        const nodeId = (row.lastSummary as { nodeId?: string } | null)?.nodeId;
        if (nodeId) {
          const entryId = closed.id;
          afterQueueWrite(async () => {
            const disarmed = await disableAutoMerge({
              workspaceId: row.workspaceId,
              owner: row.owner,
              repo: row.repo,
              nodeId,
            });
            if (!disarmed) return;
            // On the pool, so this waits for the caller's commit and then
            // applies. Same columns as the reconciler's retry.
            await getDbClient()
              .update(mergeQueueEntriesTable)
              .set({
                pendingDisarm: false,
                automergeArmedAt: null,
                automergeArmedBy: null,
                updatedAt: new Date(),
              })
              .where(eq(mergeQueueEntriesTable.id, entryId));
          });
        }
      }
    }
  } catch (err) {
    console.warn(
      `[mergeQueue] entry write failed for ${row.owner}/${row.repo}#${row.number}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Work that must run OFF the caller's transaction: GitHub calls, and anything
 * that reads or writes on the pool. Started now, outside any request scope;
 * its pool writes wait for the caller's commit rather than the caller waiting
 * for them. Errors are logged, never thrown — the queue write already stands.
 */
const followUps = new Set<Promise<void>>();

function afterQueueWrite(fn: () => Promise<void>): void {
  runWithoutScope(() => {
    const run = fn()
      .catch((err) => {
        console.warn(
          '[mergeQueue] follow-up after a queue change failed:',
          err instanceof Error ? err.message : err
        );
      })
      .finally(() => followUps.delete(run));
    followUps.add(run);
  });
}

/** Tests: wait for every follow-up started so far. */
export async function settleQueueFollowUps(): Promise<void> {
  while (followUps.size > 0) await Promise.all([...followUps]);
}

/**
 * Publish any drafts among `rows`, then kick an evaluation for each, all off
 * the caller's transaction (see {@link afterQueueWrite}). The publish comes
 * first so the kick reads the refreshed, non-draft summary.
 */
export function publishDraftsThenKick(rows: QueueMembershipRow[], trigger: string): void {
  afterQueueWrite(async () => {
    for (const row of rows) await publishDraftForQueue(row);
    // The evaluator coalesces these into one walk per group.
    for (const row of rows) void onQueueMembershipChanged(row.id, trigger);
  });
}

/**
 * Queuing a draft PR: GitHub 405s a draft merge, so a queued draft would just
 * sit blocked waiting on the author. Since queuing IS the intent to merge,
 * mark it ready for review now. Best-effort — on success we refresh the
 * cached summary so the kick merges without waiting for the ready_for_review
 * webhook; on failure decide()'s draft block still surfaces the manual action.
 *
 * Callers inside a request go through {@link publishDraftsThenKick}: this makes
 * a GitHub call and a pool read, and must not run while the request's
 * transaction holds the PR row.
 */
export async function publishDraftForQueue(row: QueueMembershipRow): Promise<void> {
  const summary = row.lastSummary as
    | { draft?: boolean; nodeId?: string; mergeStateStatus?: string }
    | null;
  const isDraftPr = summary?.draft === true || summary?.mergeStateStatus === 'DRAFT';
  if (!isDraftPr || !summary?.nodeId) return;
  const ready = await markReadyForReview({
    workspaceId: row.workspaceId,
    owner: row.owner,
    repo: row.repo,
    nodeId: summary.nodeId,
  });
  if (!ready) return;
  await prMonitorService
    .refreshPr(row.workspaceId, row.owner, row.repo, row.number, {
      resolveMergeable: true,
      repositoryId: row.repositoryId,
    })
    .catch((err) => {
      console.warn(
        `[mergeQueue] post-ready refresh failed for ${row.owner}/${row.repo}#${row.number}:`,
        err instanceof Error ? err.message : err
      );
    });
}

/** The cleared-badge broadcast a dequeued row needs (it is out of the group). */
export function emitDequeued(row: QueueMembershipRow): void {
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
  });
  noteMergeQueueEmitted(row.workspaceId, row.id, null);
}

/**
 * Rebroadcast the workspace's queue positions off the caller's transaction.
 * Not awaited by the request: the run reads every queued row, and it must read
 * after the caller commits, not inside its transaction. Tests wait for it with
 * {@link settleQueueFollowUps}.
 */
export function broadcastPositionsAfterQueueWrite(workspaceId: string): void {
  afterQueueWrite(() => broadcastMergeQueuePositions(workspaceId));
}

export type ResubmitRefusal = 'not_queued' | 'not_parked' | 'no_external_queue';

/**
 * A person's "Re-submit to the merge queue" on a PARKED entry that has been
 * through an external queue (trunk). It re-arms the entry, so budgets reset and
 * the block clears, and kicks an evaluation, which submits the PR through the
 * same door the queue always uses (`submit_external`). Nothing here posts to
 * GitHub itself: one submit path, with every guard it already has.
 *
 * Refuses, and changes nothing, when there is no active entry, when the entry
 * is not parked (the queue is working the PR, and a second submit would fight
 * it), or when the entry has never been near an external queue.
 *
 * No plan gate: the entry already exists, so nothing is added to the queue.
 */
export async function resubmitQueueEntry(
  row: QueueMembershipRow,
  trigger: string
): Promise<{ ok: true } | { ok: false; code: ResubmitRefusal }> {
  const entry = await getActiveEntryForPr(row.id);
  if (!entry) return { ok: false, code: 'not_queued' };
  if (entry.status !== 'blocked' && entry.status !== 'blocked_manual') {
    return { ok: false, code: 'not_parked' };
  }
  const external =
    entry.externalState !== null ||
    entry.blockedCode === 'external_gate' ||
    entry.blockedCode === 'external_queue_rejected';
  if (!external) return { ok: false, code: 'no_external_queue' };

  const summary = row.lastSummary as { baseBranch?: string; headSha?: string } | null;
  await ensureActiveEntry({
    pullRequestId: row.id,
    workspaceId: row.workspaceId,
    repositoryId: row.repositoryId,
    baseBranch: summary?.baseBranch ?? '',
    mergeMethod: entry.mergeMethod as MergeMethod,
    headSha: summary?.headSha ?? '',
    trigger,
    rearmEvent: {
      code: 'user_resubmit',
      message: 'Re-submit to the merge queue requested by the user — budgets reset.',
    },
  });
  broadcastPositionsAfterQueueWrite(row.workspaceId);
  publishDraftsThenKick([row], trigger);
  return { ok: true };
}

/**
 * The whole per-call enqueue/dequeue for ONE pull request: the bookkeeping,
 * the draft publish or the cleared badge, the position rebroadcast, and the
 * evaluation kick that merges an already-clean PR without waiting for the
 * reconciler.
 *
 * Queueing is free: no plan caps how many PRs wait. A fix run the queue
 * starts is gated where it is created (`createCloudTask`).
 */
export async function setQueueMembership(opts: {
  row: QueueMembershipRow;
  enabled: boolean;
  method: string;
  trigger: string;
}): Promise<void> {
  const { row, enabled, method, trigger } = opts;
  await applyQueueMembership(row, { enabled, method, trigger });

  // When disabling, the row is no longer in the queue so the group rebroadcast
  // below will not touch it — emit its cleared badge explicitly here.
  if (!enabled) emitDequeued(row);

  // Recompute "#N" for the whole queue so the toggled PR gets its real position
  // and every sibling shifts to match — not just after a refresh.
  broadcastPositionsAfterQueueWrite(row.workspaceId);

  // Publish a draft, then kick an evaluation so an already-clean PR merges
  // without waiting for the reconciler. Both off the caller's transaction.
  if (enabled) publishDraftsThenKick([row], trigger);
}
