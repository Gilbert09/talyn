import { describe, it, expect } from 'vitest';
import type { PRRow, PRReviewDecision, PRBlockingReason } from '../lib/api';
import {
  isAwaitingReview,
  isNeedsAttention,
  isReadyToMerge,
} from '../components/panels/github/prTableShared';

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
    watching: false,
    mergedAt: null,
    lastPolledAt: '2026-06-05T00:00:00Z',
    summary: { title: 'PR', draft: false, ...summary } as PRRow['summary'],
    autoKeepMergeable: false,
    autoMergeState: null,
    mergeQueued: false,
    mergeMethod: 'squash',
    mergeQueue: null,
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

describe('isReadyToMerge — "Ready to merge" filter predicate', () => {
  const greenChecks = { total: 3, passed: 3, failed: 0, inProgress: 0, skipped: 0 };

  function readyRow(overrides: Partial<PRRow['summary']> = {}): PRRow {
    return makeRow({
      blockingReason: 'mergeable',
      checks: greenChecks,
      reviewDecision: 'APPROVED',
      ...overrides,
    });
  }

  it('flags a clean approved PR with green checks', () => {
    expect(isReadyToMerge(readyRow())).toBe(true);
  });

  it.each<[PRBlockingReason, boolean]>([
    ['mergeable', true],
    ['checks_failed_optional', true],
    ['merge_conflicts', false],
    ['changes_requested', false],
    ['checks_failed', false],
    ['blocked', false],
    // Behind the base on a repo that refuses the merge until it is not. It is
    // NOT ready: GitHub would refuse the click this bucket exists to offer.
    ['behind', false],
    ['unknown', false],
  ])('blockingReason %s → %s', (blockingReason, expected) => {
    expect(isReadyToMerge(readyRow({ blockingReason }))).toBe(expected);
  });

  it('never flags a draft, even when otherwise mergeable', () => {
    expect(isReadyToMerge(readyRow({ draft: true }))).toBe(false);
  });

  it('waits for in-progress checks to finish', () => {
    expect(
      isReadyToMerge(readyRow({ checks: { ...greenChecks, inProgress: 1 } }))
    ).toBe(false);
  });

  it.each<[PRReviewDecision, boolean]>([
    ['APPROVED', true],
    [null, true],
    ['REVIEW_REQUIRED', false],
  ])('reviewDecision %s → %s', (reviewDecision, expected) => {
    expect(isReadyToMerge(readyRow({ reviewDecision }))).toBe(expected);
  });

  it('respects effectiveReviewDecision over the raw decision (unprotected repos)', () => {
    expect(
      isReadyToMerge(
        readyRow({ reviewDecision: null, effectiveReviewDecision: 'REVIEW_REQUIRED' })
      )
    ).toBe(false);
    expect(
      isReadyToMerge(
        readyRow({ reviewDecision: 'REVIEW_REQUIRED', effectiveReviewDecision: 'APPROVED' })
      )
    ).toBe(true);
  });
});

/**
 * A verdict that lands in NO bucket makes the PR vanish from the lists
 * entirely — the disappearance `mergeableSettle.ts` was written to stop
 * happening to `unknown`. `behind` leaves "Ready to merge", so it has to be
 * caught here.
 */
describe('isNeedsAttention', () => {
  function row(blockingReason: PRBlockingReason): PRRow {
    return makeRow({ blockingReason, reviewDecision: 'APPROVED' });
  }

  it.each<[PRBlockingReason, boolean]>([
    ['behind', true],
    ['merge_conflicts', true],
    ['changes_requested', true],
    ['checks_failed', true],
    ['mergeable', false],
    ['checks_failed_optional', false],
    ['blocked', false],
    ['unknown', false],
  ])('blockingReason %s → %s', (blockingReason, expected) => {
    expect(isNeedsAttention(row(blockingReason))).toBe(expected);
  });

  it('keeps a behind PR in exactly one bucket, never none', () => {
    const r = row('behind');
    expect(isReadyToMerge(r)).toBe(false);
    expect(isNeedsAttention(r)).toBe(true);
  });
});
