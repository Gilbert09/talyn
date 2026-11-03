import type { CodeReviewDismissReason } from '@talyn/shared';
import { captureWorkspaceEvent } from '../analytics.js';
import { onQueueMembershipChanged } from '../mergeQueue/triggers.js';
import { setDisposition, type FindingDetailRow } from './findings.js';
import { postFindingsToPr, type PostOutcome } from './postToPr.js';
import type { ReviewRow } from './store.js';

/**
 * A person's actions on a review: dismiss, undo a dismissal, post to the PR.
 * The app's routes and the public API call these, so the analytics event and
 * the merge-queue notice happen once per action whichever door it came in by.
 */

type ReviewFacts = Pick<ReviewRow, 'id' | 'workspaceId' | 'pullRequestId' | 'cycle' | 'preset'>;

/** Dismiss a finding, with one of the four fixed reasons or none. */
export async function dismissFinding(input: {
  review: ReviewFacts;
  finding: FindingDetailRow;
  reason: CodeReviewDismissReason | null;
  userId: string;
}): Promise<void> {
  const { review, finding, reason, userId } = input;
  await setDisposition(finding.id, 'dismissed', { reason, userId });
  // The ONE emit for a dismissal. Both front ends used to send this as well,
  // with richer properties and a different shape for a missing reason (`null`
  // against `'unspecified'`), so every dismissal counted twice and its reason
  // breakdown split down the middle. This is the authoritative side — a
  // dismissal is an API call, and a client event can be blocked — so the
  // properties moved here rather than the emit moving there.
  void captureWorkspaceEvent(review.workspaceId, 'code_review_finding_dismissed', {
    severity: finding.severity,
    // Absent when somebody dismissed without picking one. The reasons are
    // skippable, so no reason is a real answer about the prompt, not a gap.
    reason,
    // How many reviewers raised it. Dismissing something two lenses agreed on
    // is a different signal from dismissing something one of them guessed at.
    lenses: ((finding.lenses as string[]) ?? []).length,
    // The first real review's one surviving finding quoted code that was not
    // where it said. If unverified anchors drive dismissals, this is where it
    // shows.
    anchor_verified: finding.anchorVerified,
    verdict: finding.verdict,
    seen_count: finding.seenCount,
    cycle: review.cycle,
  });
  // Dismissing a blocker is one of the two ways a parked merge-queue entry gets
  // released, so tell the queue rather than making it wait for a poll. Not
  // awaited, and scope-escaped inside: it must not inherit the request's
  // transaction.
  void onQueueMembershipChanged(review.pullRequestId, 'code_review:dismissed');
}

/** Undo a dismissal. Un-dismissing can re-park a merge-queue entry, so the queue hears about it. */
export async function undismissFinding(input: { review: ReviewFacts; findingId: string }): Promise<void> {
  await setDisposition(input.findingId, 'open');
  void onQueueMembershipChanged(input.review.pullRequestId, 'code_review:undismissed');
}

/**
 * Post to PR: one GitHub review, always `COMMENT`, from the user's own account.
 * `findingIds` empty means every finding. Only open findings that are not on
 * the pull request yet are posted (see `postToPr.ts`).
 */
export async function postReviewFindings(input: {
  review: ReviewFacts;
  findingIds: string[];
  userId: string;
}): Promise<PostOutcome> {
  const { review, findingIds, userId } = input;
  const outcome = await postFindingsToPr(review.id, findingIds, userId);
  if (outcome.ok) {
    // The ONE emit for a post, for the reason `dismissFinding` gives.
    void captureWorkspaceEvent(review.workspaceId, 'code_review_posted_to_pr', {
      posted: outcome.posted,
      inline: outcome.inline,
      in_summary: outcome.inSummary,
      selected_count: findingIds.length,
      preset: review.preset,
      cycle: review.cycle,
    });
  }
  return outcome;
}
