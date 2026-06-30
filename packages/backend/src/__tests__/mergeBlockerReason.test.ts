import { describe, it, expect } from 'vitest';
import { mergeBlockerReason, type PRMergeableSummary } from '@talyn/shared';

function summary(over: Partial<PRMergeableSummary> = {}): PRMergeableSummary {
  return {
    url: 'https://github.com/a/b/pull/1',
    headBranch: 'feat',
    baseBranch: 'main',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    blockingReason: 'mergeable',
    checks: { total: 0, failed: 0 },
    unresolvedReviewThreads: 0,
    ...over,
  };
}

describe('mergeBlockerReason', () => {
  it.each([
    ['merge_conflicts blockingReason', { blockingReason: 'merge_conflicts' as const }, 'merge conflicts with the base branch'],
    ['CONFLICTING mergeable', { mergeable: 'CONFLICTING' as const }, 'merge conflicts with the base branch'],
    ['changes_requested decision', { reviewDecision: 'CHANGES_REQUESTED' as const }, 'a reviewer requested changes'],
    ['changes_requested blockingReason', { blockingReason: 'changes_requested' as const }, 'a reviewer requested changes'],
    ['unresolved threads', { unresolvedReviewThreads: 2 }, 'unresolved review threads'],
    ['failing required checks', { blockingReason: 'checks_failed' as const, checks: { total: 3, failed: 1 } }, 'failing CI checks'],
    ['nothing identifiable', {}, 'needs attention'],
  ])('%s → %s', (_label, over, expected) => {
    expect(mergeBlockerReason(summary(over))).toBe(expected);
  });

  it('conflicts win over a simultaneous changes-requested', () => {
    expect(
      mergeBlockerReason(
        summary({ mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED' })
      )
    ).toBe('merge conflicts with the base branch');
  });

  it('ignores optional (non-required) failing checks', () => {
    expect(
      mergeBlockerReason(
        summary({ blockingReason: 'checks_failed_optional', checks: { total: 2, failed: 1 } })
      )
    ).toBe('needs attention');
  });
});
