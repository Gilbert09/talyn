import { getReviewForPr } from './store.js';
import { hasOpenBlocker } from './findings.js';

/**
 * Whether an unresolved code-review blocker should hold this pull request out of
 * the merge queue.
 *
 * Deliberately narrow, because the alternative is a wrong finding wedging somebody
 * else's merge with no way out but a database edit. FOUR conditions, all of them
 * necessary:
 *
 * 1. A review exists for this pull request.
 * 2. It reviewed the CURRENT head. A review of an older commit describes code that
 *    may no longer be there, and blocking on it would punish somebody for pushing.
 * 3. The finding is `blocker` severity AND the judging pass confirmed it. A
 *    candidate the judge rejected never reaches a person, so it must not reach the
 *    queue either.
 * 4. It is still open — a dismissal or a landed fix releases it at once.
 *
 * Returns null rather than throwing on any failure. A review the backend cannot
 * read must not block a merge: the queue's job is to merge, and an unreadable
 * review is our problem rather than the user's.
 */
export async function codeReviewBlockerFor(
  pullRequestId: string,
  currentHeadSha: string | null
): Promise<{ reason: string } | null> {
  try {
    if (!currentHeadSha) return null;
    const review = await getReviewForPr(pullRequestId);
    if (!review) return null;
    // A review of an older commit blocks nothing — see condition 2.
    if (review.reviewedHeadSha !== currentHeadSha) return null;
    if (!(await hasOpenBlocker(review.id))) return null;
    return {
      reason:
        'The code review found a blocker on this commit. Fix it or dismiss it in the ' +
        'Findings tab, and the pull request goes back in the queue.',
    };
  } catch (err) {
    console.warn(`[code-review] could not read the queue blocker for ${pullRequestId}:`, err);
    return null;
  }
}
