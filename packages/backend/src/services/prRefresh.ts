import { eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { pullRequests as pullRequestsTable } from '../db/schema.js';
import { githubService } from './github.js';
import { QUEUE_RESET_COLUMNS } from './mergeQueueBroadcast.js';
import { forceFetchAndUpsert } from './prCache.js';
import { markRefreshed } from './prFocus.js';
import { emitPullRequestUpdated } from './websocket.js';
import { notifyThreadsOfMergedPr } from './workbenches/threads.js';

/**
 * Re-reading one pull request from GitHub. Shared by the app's
 * `POST /pull-requests/:id/refresh` and the public API's refresh, so the two
 * cannot drift.
 */

type Row = typeof pullRequestsTable.$inferSelect;

export type ReconcileRow = Pick<Row, 'id' | 'workspaceId' | 'owner' | 'repo' | 'number' | 'state' | 'mergeQueued'>;

export type RefreshRow = ReconcileRow & Pick<Row, 'repositoryId' | 'taskId'>;

/** What the reconcile emits: the fields every client patches a row with. */
const EMIT_COLUMNS = {
  id: pullRequestsTable.id,
  workspaceId: pullRequestsTable.workspaceId,
  taskId: pullRequestsTable.taskId,
  repositoryId: pullRequestsTable.repositoryId,
  owner: pullRequestsTable.owner,
  repo: pullRequestsTable.repo,
  number: pullRequestsTable.number,
  state: pullRequestsTable.state,
  lastSummary: pullRequestsTable.lastSummary,
} as const;

/**
 * Reconcile a PR's lifecycle state against GitHub via REST. The GraphQL
 * batch query only returns OPEN PRs, so once a PR is merged/closed our
 * normal fetch paths can't tell merged from closed — and a row that was
 * mis-classified (e.g. a transient sweep failure marking a merged PR
 * "closed") never gets re-checked. This hits the authoritative per-PR
 * REST endpoint and corrects state + mergedAt. Returns true when the row
 * changed; false if nothing changed or the lookup failed.
 */
export async function reconcileTerminalState(row: ReconcileRow): Promise<boolean> {
  let pr: Awaited<ReturnType<typeof githubService.getPullRequest>>;
  try {
    pr = await githubService.getPullRequest(row.workspaceId, row.owner, row.repo, row.number);
  } catch (err) {
    console.warn(`[pull-requests] terminal reconcile failed for ${row.id}:`, err);
    return false;
  }
  let nextState: 'open' | 'closed' | 'merged';
  let mergedAt: Date | null = null;
  if (pr.merged_at || pr.merged) {
    nextState = 'merged';
    mergedAt = pr.merged_at ? new Date(pr.merged_at) : new Date();
  } else if (pr.state === 'closed') {
    nextState = 'closed';
  } else {
    nextState = 'open';
  }
  if (nextState === row.state) return false;

  const db = getDbClient();
  // A PR that left 'open' can't be merged by the queue — drop it off so it
  // never blocks its (repo, base) group.
  const dropFromQueue = nextState !== 'open' && row.mergeQueued;
  const queueReset = dropFromQueue ? QUEUE_RESET_COLUMNS : {};
  await db
    .update(pullRequestsTable)
    .set({ state: nextState, mergedAt, updatedAt: new Date(), ...queueReset })
    .where(eq(pullRequestsTable.id, row.id));
  if (nextState === 'merged') await notifyThreadsOfMergedPr(row.id);
  const [updated] = await db.select(EMIT_COLUMNS).from(pullRequestsTable).where(eq(pullRequestsTable.id, row.id)).limit(1);
  // Tell every client, not just the caller. The reconcile is usually triggered
  // by ONE surface (a detail sheet opening, a merge that GitHub refused), but
  // the row it corrects is on the open-only list of every connected client —
  // and that list is exactly where a merged PR was still showing "Ready".
  if (updated) {
    emitPullRequestUpdated(updated.workspaceId, {
      id: updated.id,
      taskId: updated.taskId,
      repositoryId: updated.repositoryId,
      owner: updated.owner,
      repo: updated.repo,
      number: updated.number,
      state: updated.state,
      lastSummary: (updated.lastSummary as Record<string, unknown> | null) ?? {},
      ...(dropFromQueue ? { mergeQueued: false } : {}),
    });
  }
  return Boolean(updated);
}

export type RefreshOutcome =
  /** Fetched and stored again. `rowId` is the row the upsert wrote. */
  | { kind: 'refreshed'; rowId: string }
  /** GitHub has it closed or merged now, and the row says so. */
  | { kind: 'reconciled' }
  /** Not on GitHub, or no head branch in the cache to fetch it by. */
  | { kind: 'not_found' };

/**
 * A person's "refresh this pull request": a forced fetch and upsert, then a
 * short cooldown so a racing poll does not overwrite it. A PR the GraphQL fetch
 * does not return is not open any more, so its terminal state is read from REST.
 */
export async function refreshPullRequest(row: RefreshRow): Promise<RefreshOutcome> {
  const result = await forceFetchAndUpsert({
    workspaceId: row.workspaceId,
    repositoryId: row.repositoryId,
    taskId: row.taskId,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
  });
  if (!result) {
    return (await reconcileTerminalState(row)) ? { kind: 'reconciled' } : { kind: 'not_found' };
  }
  // Cooldown: the next 5 s of poll-driven refetches skip this PR
  // so a manual refresh doesn't get stomped by a racing tick.
  markRefreshed(row.workspaceId, result.rowId);
  return { kind: 'refreshed', rowId: result.rowId };
}
