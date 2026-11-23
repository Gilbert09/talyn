import type { MergeQueuePublic, PRRow } from '@talyn/client/native';

import { prCounts } from '../features/prs/counts';
import { buildQueueGroups, compareByCreated, hiddenReviewCohort, isAwaitingReview, isNeedsAttention, isReadyToMerge,
  pullsTab, queueBlockedReason, queueBudgetsLine, queueChip, queueParentStatus, queueStatusLine, reviewCohort, reviewRequestLabel,
  sortReviews } from '../features/prs/lists';
import { queueSections } from '../features/prs/PullRequestsScreen';
import { pr } from './workflowFixtures';

jest.mock('../auth/AuthProvider', () => ({ useMobileRuntime: () => ({}), useNetwork: () => 'online' }));

const summary = (patch: Partial<PRRow['summary']>) => ({ ...pr().summary, ...patch });
const row = (id: string, patch: Partial<PRRow> = {}, summaryPatch: Partial<PRRow['summary']> = {}) =>
  pr({ id, number: Number(id.replace(/\D/g, '')) || 1, ...patch, summary: summary(summaryPatch) });
const entry = (patch: Partial<MergeQueuePublic>): MergeQueuePublic => ({ status: 'queued', position: 1, ...patch });

describe('pull request pages', () => {
  it.each([
    ['mine', 'mine'], ['reviews', 'reviews'], ['queue', 'queue'], [undefined, 'mine'], ['other', 'mine'], [['queue', 'mine'], 'queue'], [3, 'mine'],
  ] as const)('reads tab %j as %s', (value, expected) => expect(pullsTab(value)).toBe(expected));

  it.each([
    ['changes_requested', true], ['checks_failed', true], ['merge_conflicts', true], ['needs_human', true], ['behind', true],
    ['mergeable', false], ['checks_failed_optional', false], ['blocked', false], ['unknown', false],
  ] as const)('needs attention for %s: %s', (reason, expected) => expect(isNeedsAttention(row('pr-1', {}, { blockingReason: reason }))).toBe(expected));

  it.each([
    ['REVIEW_REQUIRED', false, true], ['REVIEW_REQUIRED', true, false], ['APPROVED', false, false], [undefined, false, false],
  ] as const)('awaits review for %s, draft %s: %s', (decision, draft, expected) =>
    expect(isAwaitingReview(row('pr-1', {}, { reviewDecision: decision, draft }))).toBe(expected));

  const checks = (patch: Partial<PRRow['summary']['checks']> = {}) => ({ total: 3, passed: 3, failed: 0, inProgress: 0, skipped: 0, ...patch });
  it.each([
    ['mergeable and approved', { blockingReason: 'mergeable', reviewDecision: 'APPROVED', checks: checks() }, null, true],
    ['optional failure', { blockingReason: 'checks_failed_optional', reviewDecision: 'APPROVED', checks: checks({ failed: 1 }) }, null, true],
    ['still running', { blockingReason: 'mergeable', reviewDecision: 'APPROVED', checks: checks({ inProgress: 1 }) }, null, false],
    ['review outstanding', { blockingReason: 'mergeable', reviewDecision: 'REVIEW_REQUIRED', checks: checks() }, null, false],
    ['draft', { blockingReason: 'mergeable', draft: true, checks: checks() }, null, false],
    ['held only by protection', { blockingReason: 'blocked', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', checks: checks() }, null, true],
    ['blocked with a failure', { blockingReason: 'blocked', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', checks: checks({ failed: 1 }) }, null, false],
    ['in an external queue', { blockingReason: 'mergeable', reviewDecision: 'APPROVED', checks: checks() }, 'testing', false],
    ['refused by the external queue', { blockingReason: 'mergeable', reviewDecision: 'APPROVED', checks: checks() }, 'failed', true],
  ] as const)('ready to merge when %s', (_name, patch, external, expected) => {
    const mergeQueue = external ? entry({ status: 'awaiting_external', external: { state: external } } as Partial<MergeQueuePublic>) : null;
    expect(isReadyToMerge(row('pr-1', { mergeQueue }, patch as Partial<PRRow['summary']>))).toBe(expected);
  });

  it.each([
    ['desc', ['pr-2', 'pr-1', 'pr-3', 'pr-4']],
    ['asc', ['pr-4', 'pr-1', 'pr-3', 'pr-2']],
  ] as const)('orders by the GitHub open date, then the row date, then the id, %s', (dir, expected) => {
    const a = row('pr-1', { createdAt: '2026-11-05T00:00:00Z' });
    const b = row('pr-2', { createdAt: '2026-11-01T00:00:00Z' }, { createdAt: '2026-11-09T00:00:00Z' } as Partial<PRRow['summary']>);
    const c = row('pr-3', { createdAt: '2026-11-05T00:00:00Z' });
    const d = row('pr-4', { createdAt: '2026-10-01T00:00:00Z' });
    expect([c, d, a, b].sort((x, y) => compareByCreated(x, y, dir)).map((item) => item.id)).toEqual(expected);
  });

  it('defaults to newest first when used as a plain comparator', () => {
    const rows = [row('pr-1', { createdAt: '2026-11-01T00:00:00Z' }), row('pr-2', { createdAt: '2026-11-02T00:00:00Z' })];
    expect(rows.sort(compareByCreated).map((item) => item.id)).toEqual(['pr-2', 'pr-1']);
  });

  it('splits review requests into visible and hidden, the most recently hidden first', () => {
    const rows = [
      row('pr-1', { reviewRequested: true }), row('pr-2', { reviewRequested: true, reviewHiddenAt: '2026-11-01T00:00:00Z' }),
      row('pr-3', { reviewRequested: true, reviewHiddenAt: '2026-11-05T00:00:00Z' }), row('pr-4', { reviewRequested: false, reviewHiddenAt: '2026-11-06T00:00:00Z' }),
    ];
    expect(reviewCohort(rows).map((item) => item.id)).toEqual(['pr-1']);
    expect(hiddenReviewCohort(rows).map((item) => item.id)).toEqual(['pr-3', 'pr-2']);
  });

  it.each([
    ['newest', ['pr-2', 'pr-1', 'pr-3']],
    ['oldest', ['pr-3', 'pr-1', 'pr-2']],
    // The server's verdicts win: blocking others first, then score. A row it did not score is scored here.
    ['priority', ['pr-3', 'pr-1', 'pr-2']],
  ] as const)('sorts reviews by %s', (mode, expected) => {
    const verdict = (gate: string, score: number) => ({ gate, score, terms: [], topReason: null }) as unknown as PRRow['priority'];
    const rows = [row('pr-1', { createdAt: '2026-11-02T00:00:00Z', priority: verdict('actionable', 90) }),
      row('pr-2', { createdAt: '2026-11-05T00:00:00Z', priority: verdict('actionable', 10) }),
      row('pr-3', { createdAt: '2026-11-01T00:00:00Z', priority: verdict('blocking_others', 0) })];
    expect(sortReviews(rows, { mode, now: Date.parse('2026-11-09T00:00:00Z') }).map((item) => item.id)).toEqual(expected);
  });

  it('scores a row the server did not', () => {
    const rows = [row('pr-1', { createdAt: '2026-11-02T00:00:00Z' }), row('pr-2', { createdAt: '2026-11-05T00:00:00Z' })];
    expect(sortReviews(rows, { mode: 'priority', now: Date.parse('2026-11-09T00:00:00Z') }).map((item) => item.id).sort()).toEqual(['pr-1', 'pr-2']);
  });

  it.each([
    [undefined, null],
    [{ direct: true, teams: ['org/core'] }, { label: 'You', extra: 0, direct: true }],
    [{ direct: false, teams: ['org/core', 'org/web', 'org/api'] }, { label: '@org/core', extra: 2, direct: false }],
    [{ direct: false, teams: [] }, null],
  ] as const)('labels the review request %j', (via, expected) =>
    expect(reviewRequestLabel({ reviewRequestVia: via as PRRow['summary']['reviewRequestVia'] })).toEqual(expected));

  it.each([
    [undefined, { mine: null, reviews: null, queue: null }],
    [[], { mine: 0, reviews: 0, queue: 0 }],
    [[row('pr-1', { authored: true, mergeQueued: true, reviewRequested: false }), row('pr-2', { watching: true, reviewRequested: true }),
      row('pr-3', { reviewRequested: true, reviewHiddenAt: '2026-11-01T00:00:00Z' }), row('pr-4', { reviewRequested: false })],
    { mine: 2, reviews: 1, queue: 1 }],
  ] as const)('counts badges for %#', (rows, expected) => expect(prCounts(rows as PRRow[] | undefined)).toEqual(expected));

  it('groups the queue page by where each PR lands', () => {
    const rows = [row('pr-1', { authored: true, reviewRequested: false, mergeQueued: true, mergeQueue: entry({ position: 2 }) })];
    expect(queueSections(rows)).toEqual([expect.objectContaining({ title: 'example/project → main', data: [rows[0]] })]);
  });
});

describe('merge queue', () => {
  const queued = (id: string, head: string, base: string, mergeQueue: Partial<MergeQueuePublic> = {}, repositoryId = 'repo-one') =>
    row(id, { repositoryId, mergeQueued: true, mergeQueue: entry(mergeQueue) }, { headBranch: head, baseBranch: base });

  it('groups by repository and base, ordered by position, and collapses a stack onto the branch it lands on', () => {
    const rows = [
      queued('pr-1', 'a', 'main', { position: 2 }), queued('pr-2', 'b', 'main', { position: 1 }),
      queued('pr-3', 'stack-2', 'stack-1', { status: 'awaiting_stack' }), queued('pr-4', 'stack-1', 'release', { status: 'blocked' }),
      queued('pr-5', 'c', 'main', {}, 'repo-two'),
    ];
    const groups = buildQueueGroups(rows);
    expect(groups.map((group) => [group.kind, group.base, group.rows.map((item) => item.id)])).toEqual([
      ['base', 'main', ['pr-2', 'pr-1']], ['base', 'main', ['pr-5']], ['stack', 'release', ['pr-4', 'pr-3']],
    ]);
    const stack = groups[2];
    expect(stack.kind === 'stack' && [stack.size, stack.stalledAt?.id]).toEqual([2, 'pr-4']);
  });

  it('finds the parent status of a stacked row', () => {
    const rows = [queued('pr-1', 'a', 'main', { status: 'blocked' }), queued('pr-2', 'b', 'a', { status: 'awaiting_stack', stackParentNumber: 1 })];
    expect(queueParentStatus(rows).get('pr-2')).toBe('blocked');
  });

  it.each([
    [{ status: 'automerge_armed' }, undefined, 'Auto-merge armed', 'success'],
    [{ status: 'awaiting_external', external: { state: 'testing' } }, undefined, 'Queue: testing', 'success'],
    [{ status: 'awaiting_external' }, undefined, 'Submitted to queue', 'success'],
    [{ status: 'awaiting_ci' }, undefined, 'Waiting for CI', 'information'],
    [{ status: 'awaiting_review' }, undefined, 'Waiting for a required review', 'muted'],
    [{ status: 'awaiting_stack', stackCoveredBy: 7 }, undefined, 'Queued with #7', 'information'],
    [{ status: 'awaiting_stack', stackParentNumber: 3 }, 'blocked', 'Blocked below #3', 'warning'],
    [{ status: 'awaiting_stack', stackParentNumber: 3 }, 'queued', 'Waiting for #3', 'muted'],
    [{ status: 'awaiting_stack' }, undefined, 'Waiting for its stack', 'muted'],
    [{ status: 'fixing', budgets: { fixRuns: [1, 3], checkReruns: [0, 2], resigns: [0, 3] } }, undefined, 'Fixing (2/3)', 'merged'],
    [{ status: 'fixing', fixKind: 'resign', budgets: { fixRuns: [0, 3], checkReruns: [0, 2], resigns: [0, 3] } }, undefined, 'Re-signing (1/3)', 'merged'],
    [{ status: 'fixing', fixKind: 'session' }, undefined, 'Session fixing (1/3)', 'muted'],
    [{ status: 'merging' }, undefined, 'Merging', 'information'],
    [{ status: 'blocked', blockedCode: 'session_active' }, undefined, 'Session working', 'muted'],
    [{ status: 'blocked', blockedCode: 'awaiting_human_check' }, undefined, 'Needs you', 'warning'],
    [{ status: 'blocked', blockedCode: 'checks_failed' }, undefined, 'Blocked', 'warning'],
    [{ status: 'blocked_manual' }, undefined, 'Needs you', 'destructive'],
    [{ status: 'queued' }, undefined, 'Waiting', 'muted'],
  ] as const)('labels %j', (patch, parent, label, tone) =>
    expect(queueChip({ summary: pr().summary, mergeQueue: entry(patch as Partial<MergeQueuePublic>) }, parent)).toMatchObject({ label, tone }));

  it.each([
    [{ status: 'queued' }, null],
    [{ status: 'blocked', blockedCode: 'session_active', reason: 'Busy.' }, null],
    [{ status: 'blocked', blockedCode: 'code_review_blocker', reason: 'A blocker is open.' }, 'A blocker is open. It picks this PR back up on its own once that clears.'],
    [{ status: 'blocked', reason: 'Checks fail.' }, 'Checks fail. It clears on a new push. Requeue to retry now.'],
    [{ status: 'blocked_manual' }, 'GitHub refuses the app merge. Merge it yourself or requeue it.'],
  ] as const)('explains a blocked row %j', (patch, expected) => expect(queueBlockedReason(entry(patch as Partial<MergeQueuePublic>))).toBe(expected));

  it.each([
    [null, 'Waiting'],
    [{ status: 'queued', position: 3 }, '#3 · Queued'],
    [{ status: 'awaiting_ci', position: 1, autoMerge: { armed: true } }, '#1 · Waiting for CI · auto-merge armed'],
    [{ status: 'awaiting_stack', position: 0, stackParentNumber: 9 }, 'Waiting for #9 to merge. This PR is stacked on it.'],
    [{ status: 'blocked', position: 2, blockedCode: 'agent_needs_human' }, '#2 · Waiting on you. The queue carries on by itself once this clears.'],
    [{ status: 'blocked', position: 2, blockedCode: 'checks_failed' }, '#2 · Blocked'],
  ] as const)('states the queue status %j', (patch, expected) =>
    expect(queueStatusLine(patch ? entry(patch as Partial<MergeQueuePublic>) : null)).toBe(expected));

  it('states the retry budgets', () => {
    expect(queueBudgetsLine(entry({ budgets: { fixRuns: [1, 3], checkReruns: [0, 2], resigns: [0, 3] } }))).toBe('Fix runs 1/3 · Check re-runs 0/2 · Re-signs 0/3');
    expect(queueBudgetsLine(entry({}))).toBeNull();
  });
});
