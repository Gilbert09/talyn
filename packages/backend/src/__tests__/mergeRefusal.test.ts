import { describe, expect, it } from 'vitest';
import {
  describeMergeRefusal,
  githubMergeWords,
  markSummaryBehind,
  type MergeRefusalCode,
} from '../services/mergeRefusal.js';
import type { BlockingReason, PRSummary } from '../services/githubGraphql.js';

const REQUEST_ID = ' (GitHub request-id: 8E14:BEB88:AFA78BD:1030E63F:6B070AFE)';

describe('githubMergeWords', () => {
  it.each([
    [
      'GitHub API error 409 Conflict: Head branch is out of date. Review and try the merge again.' + REQUEST_ID,
      'Head branch is out of date. Review and try the merge again.',
    ],
    ['GitHub API error 405 Method Not Allowed: Pull Request is not mergeable', 'Pull Request is not mergeable'],
    ['GitHub did not merge the pull request', 'GitHub did not merge the pull request'],
    ['Something else' + REQUEST_ID, 'Something else'],
  ])('cleans %j', (raw, words) => {
    expect(githubMergeWords(raw)).toBe(words);
  });
});

describe('describeMergeRefusal', () => {
  const pr = { number: 344, baseBranch: 'main' };

  it.each<[string, string, MergeRefusalCode]>([
    ['409 out of date', 'GitHub API error 409 Conflict: Head branch is out of date. Review and try the merge again.' + REQUEST_ID, 'branch_behind'],
    ['405 out of date', 'GitHub API error 405 Method Not Allowed: Head branch is out of date.', 'branch_behind'],
    ['up-to-date rule', 'GitHub API error 405 Method Not Allowed: Required status check "ci" is expected. Branch must be up to date', 'branch_behind'],
    ['head modified', 'GitHub API error 409 Conflict: Head branch was modified. Review and try the merge again.', 'head_changed'],
    ['base modified', 'GitHub API error 405 Method Not Allowed: Base branch was modified. Review and try the merge again.', 'base_changed'],
    ['not mergeable', 'GitHub API error 405 Method Not Allowed: Pull Request is not mergeable', 'not_mergeable'],
    ['merge conflict', 'GitHub API error 405 Method Not Allowed: Merge conflict', 'not_mergeable'],
    ['review required', 'GitHub API error 405 Method Not Allowed: At least 1 approving review is required by reviewers with write access.', 'merge_refused'],
    ['200 merged false', 'GitHub did not merge the pull request', 'merge_refused'],
  ])('%s → %s', (_name, raw, code) => {
    const refusal = describeMergeRefusal(raw, pr);
    expect(refusal.code).toBe(code);
    expect(refusal.message).not.toMatch(/GitHub API error|request-id/);
  });

  it('names the PR, the base branch and the fix for a branch that is behind', () => {
    const { message } = describeMergeRefusal('GitHub API error 409 Conflict: Head branch is out of date.', pr);
    expect(message).toContain('#344 is behind main');
    expect(message).toContain('Update the branch');
  });

  it('says "the base branch" when the base is not known', () => {
    const { message } = describeMergeRefusal('Head branch is out of date.', { number: 7, baseBranch: '' });
    expect(message).toContain('#7 is behind the base branch');
  });

  it('keeps GitHub\'s own words for a refusal it does not know', () => {
    const { message } = describeMergeRefusal(
      'GitHub API error 405 Method Not Allowed: At least 1 approving review is required.' + REQUEST_ID,
      pr,
    );
    expect(message).toBe('At least 1 approving review is required.');
  });
});

describe('markSummaryBehind', () => {
  const summary = (blockingReason: BlockingReason): PRSummary =>
    ({ number: 1, mergeStateStatus: 'CLEAN', blockingReason }) as unknown as PRSummary;

  it.each<[BlockingReason, BlockingReason]>([
    ['mergeable', 'behind'],
    ['checks_failed_optional', 'behind'],
    ['unknown', 'behind'],
    ['behind', 'behind'],
    ['merge_conflicts', 'merge_conflicts'],
    ['checks_failed', 'checks_failed'],
    ['changes_requested', 'changes_requested'],
    ['blocked', 'blocked'],
    ['needs_human', 'needs_human'],
  ])('%s → %s', (before, after) => {
    const out = markSummaryBehind(summary(before));
    expect(out.blockingReason).toBe(after);
    if (after === 'behind' && before !== 'behind') expect(out.mergeStateStatus).toBe('BEHIND');
  });
});
