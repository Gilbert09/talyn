import type { PRRow, PRReviewDecision } from '../renderer/lib/api';
import { isAwaitingReview } from '../renderer/components/panels/github/prTableShared';

function makeRow(summary: Partial<PRRow['summary']>): PRRow {
  return {
    id: 'p1',
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    taskId: null,
    owner: 'acme',
    repo: 'app',
    number: 1,
    state: 'open',
    reviewRequested: false,
    authored: true,
    mergedAt: null,
    lastPolledAt: '2026-06-05T00:00:00Z',
    summary: { title: 'PR', draft: false, ...summary } as PRRow['summary'],
    autoKeepMergeable: false,
    autoMergeState: null,
    mergeQueued: false,
    mergeMethod: 'squash',
    mergeQueueState: null,
    createdAt: '2026-06-05T00:00:00Z',
    updatedAt: '2026-06-05T00:00:00Z',
  };
}

describe('isAwaitingReview — "Needs review" filter predicate', () => {
  it.each<[PRReviewDecision, boolean]>([
    ['REVIEW_REQUIRED', true],
    ['APPROVED', false],
    ['CHANGES_REQUESTED', false],
    [null, false],
  ])('reviewDecision %s → %s', (reviewDecision, expected) => {
    expect(isAwaitingReview(makeRow({ reviewDecision }))).toBe(expected);
  });

  it('prefers effectiveReviewDecision over the raw decision', () => {
    expect(
      isAwaitingReview(
        makeRow({ reviewDecision: 'APPROVED', effectiveReviewDecision: 'REVIEW_REQUIRED' })
      )
    ).toBe(true);
    expect(
      isAwaitingReview(
        makeRow({ reviewDecision: 'REVIEW_REQUIRED', effectiveReviewDecision: 'APPROVED' })
      )
    ).toBe(false);
  });

  it('never flags a draft, even when a review is required', () => {
    expect(isAwaitingReview(makeRow({ draft: true, reviewDecision: 'REVIEW_REQUIRED' }))).toBe(
      false
    );
  });
});
