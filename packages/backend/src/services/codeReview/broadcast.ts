import { eq } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { pullRequests as pullRequestsTable } from '../../db/schema.js';
import { emitPullRequestUpdated } from '../websocket.js';
import { toPublicReview } from './public.js';
import { getReview } from './store.js';

/**
 * Mirroring a review's state onto its pull-request row.
 *
 * The analogue of `mirrorToPrRow` in the merge queue, and it exists for the same
 * reason: the PR row is where the user is looking, and a review whose progress
 * only appears when they open a panel is a review nobody watches.
 *
 * The payload rides `pull_request:updated` as an OPTIONAL field, which the
 * client's merge rules require: `prCache`'s upsert and the monitor's flag
 * reconcile both emit that event and neither knows anything about a review, so a
 * required field would cost a read-back on the hottest write path in the app.
 */
export async function broadcastReview(reviewId: string): Promise<void> {
  try {
    const review = await getReview(reviewId);
    if (!review) return;

    const rows = await getDbClient()
      .select({
        id: pullRequestsTable.id,
        taskId: pullRequestsTable.taskId,
        repositoryId: pullRequestsTable.repositoryId,
        owner: pullRequestsTable.owner,
        repo: pullRequestsTable.repo,
        number: pullRequestsTable.number,
        state: pullRequestsTable.state,
        lastSummary: pullRequestsTable.lastSummary,
      })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, review.pullRequestId))
      .limit(1);
    const pr = rows[0];
    if (!pr) return;

    const summary = (pr.lastSummary ?? {}) as { headSha?: string };
    emitPullRequestUpdated(review.workspaceId, {
      id: pr.id,
      taskId: pr.taskId,
      repositoryId: pr.repositoryId,
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      state: pr.state,
      lastSummary: (pr.lastSummary ?? {}) as Record<string, unknown>,
      codeReview: (await toPublicReview(review, {
        headSha: summary.headSha ?? null,
      })) as unknown as Record<string, unknown>,
    });
  } catch (err) {
    // A broadcast is a courtesy. The review's own state is already durable, and
    // the client polls, so failing to tell anybody must never fail the pass that
    // did the work.
    console.warn(`[code-review] broadcasting ${reviewId} failed:`, err);
  }
}
