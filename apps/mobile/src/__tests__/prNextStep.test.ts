import type { MergeQueuePublic, PRCheckContext, PRReviewDetail, PRRow } from '@talyn/client/native';

import { prActions, type PrActionSet } from '../features/prs/actions';
import { descriptionIsLong, failingBadge, fileTotals, groupChecks, lastHunkLines, reviewTimeline } from '../features/prs/detailModel';
import { queueStatusLabel, queueStatusLine } from '../features/prs/lists';
import { prNextStep, type NextStepInput } from '../features/prs/nextStep';
import { pr } from './workflowFixtures';

const NOW = Date.parse('2026-11-08T12:00:00Z');
type Summary = PRRow['summary'];
const summary = (patch: Partial<Summary> = {}): Summary => ({ ...pr().summary, ...patch });
const CLEAN = { blockingReason: 'mergeable', mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', ciStatus: 'passing',
  checks: { total: 4, passed: 4, failed: 0, inProgress: 0, skipped: 0 } } as const;
const mine = (patch: Partial<PRRow> = {}, s: Partial<Summary> = {}) =>
  pr({ authored: true, reviewRequested: false, ...patch, summary: summary({ ...CLEAN, ...s }) });
const theirs = (patch: Partial<PRRow> = {}, s: Partial<Summary> = {}) =>
  pr({ authored: false, reviewRequested: false, ...patch, summary: summary(s) });
const queue = (patch: Partial<MergeQueuePublic>): Partial<PRRow> => ({ mergeQueued: true, mergeQueue: { status: 'queued', position: 2, ...patch } as MergeQueuePublic });
const check = (name: string, state: PRCheckContext['state'], required: boolean | null = true): PRCheckContext => ({ name, state, url: null, required });

function next(row: PRRow, extra: Partial<NextStepInput> = {}, actions?: Partial<PrActionSet>) {
  return prNextStep({ row, summary: row.summary, actions: { ...prActions(row, { posthogConnected: true }), ...actions }, now: NOW, ...extra });
}

describe('prNextStep, one row of the state table each', () => {
  it.each<[string, PRRow, Partial<NextStepInput>, string, string, string | null, string | null]>([
    ['merged', mine({ state: 'merged', mergedAt: '2026-11-08T10:00:00Z' }), {}, 'merged', 'Merged 2 hours ago', 'open', 'Open on GitHub'],
    ['closed', mine({ state: 'closed' }), {}, 'closed', 'Closed without merging', 'open', 'Open on GitHub'],
    ['queue fix by a session', mine({ ...queue({ status: 'fixing', fixKind: 'session' }), session: { id: 'session-one', name: 'chore-data', status: 'ready' } }),
      {}, 'agent', 'An agent is fixing this', 'session', 'View session'],
    ['session parked on the queue', mine({ ...queue({ status: 'blocked', blockedCode: 'session_active' }), session: { id: 'session-one', name: 'chore-data', status: 'ready' } }),
      {}, 'agent', 'An agent is fixing this', 'session', 'View session'],
    ['queue cloud fix, no session', mine(queue({ status: 'fixing', fixKind: 'blockers' })), {}, 'agent', 'An agent is fixing this', null, null],
    ['linked task running', mine({ taskId: 'task-one' }, { blockingReason: 'checks_failed', checks: { total: 2, passed: 1, failed: 1, inProgress: 0, skipped: 0 } }),
      { taskRunning: true }, 'agent', 'An agent is fixing this', null, null],
    ['in the queue', mine(queue({ status: 'awaiting_ci', position: 2 })), {}, 'queued', 'In the merge queue, #2', null, null],
    ['queue stopped on failing checks', mine(queue({ status: 'blocked', reason: 'Checks fail.' }), { blockingReason: 'checks_failed',
      checks: { total: 2, passed: 1, failed: 1, inProgress: 0, skipped: 0 } }), {}, 'queue_stopped', 'Merge queue stopped', 'fix', 'Fix with agent'],
    ['queue stopped, nothing to fix', mine(queue({ status: 'blocked', reason: 'Base moved.' })), {}, 'queue_stopped', 'Merge queue stopped', 'requeue', 'Requeue'],
    ['queue stopped at Trunk', mine(queue({ status: 'blocked', blockedCode: 'external_queue_rejected', reason: 'Trunk said no.' })), {},
      'queue_stopped', 'Merge queue stopped', 'resubmit', 'Re-submit to Trunk'],
    ['queue waits on a person', mine(queue({ status: 'blocked', blockedCode: 'awaiting_human_check' })), {}, 'queue_stopped', 'Merge queue stopped', 'open', 'Open on GitHub'],
    ['queue waits on a review blocker', mine(queue({ status: 'blocked', blockedCode: 'code_review_blocker' })), { codeReview: 'ready' },
      'queue_stopped', 'Merge queue stopped', 'findings', 'View findings'],
    ['draft', mine({}, { draft: true }), {}, 'draft', 'Draft', 'open', 'Open on GitHub'],
    ['conflicts', mine({}, { blockingReason: 'merge_conflicts', mergeable: 'CONFLICTING' }), {}, 'conflicts', 'Merge conflicts with main', 'fix', 'Resolve with agent'],
    ['human gate', mine({}, { blockingReason: 'needs_human', humanGates: [{ id: 'vr', label: 'Visual review', name: 'Visual review', url: null }] }), {},
      'needs_human', 'A person must approve a check', 'open', 'Open on GitHub'],
    ['failing required checks', mine({}, { blockingReason: 'checks_failed', ciStatus: 'failing_required',
      checks: { total: 5, passed: 2, failed: 3, inProgress: 0, skipped: 0 } }), {}, 'checks_failing', '3 checks are failing', 'fix', 'Fix with agent'],
    ['changes requested', mine({}, { blockingReason: 'changes_requested', reviewDecision: 'CHANGES_REQUESTED' }),
      { recentReviews: [{ id: 'r1', author: 'old', state: 'CHANGES_REQUESTED', submittedAt: '2026-11-01T00:00:00Z', url: '' },
        { id: 'r2', author: 'ada', state: 'CHANGES_REQUESTED', submittedAt: '2026-11-07T00:00:00Z', url: '' }] },
      'changes_requested', 'Changes requested by ada', 'fix', 'Address review with agent'],
    ['behind', mine({}, { blockingReason: 'behind' }), {}, 'behind', 'Behind main', 'open', 'Open on GitHub'],
    ['checks running', mine({}, { checks: { total: 10, passed: 7, failed: 0, inProgress: 3, skipped: 0 } }), {},
      'checks_running', 'Checks are running (7 of 10 done)', 'queue', 'Add to merge queue'],
    ['waiting for review', mine({}, { blockingReason: 'blocked', reviewDecision: 'REVIEW_REQUIRED' }), {}, 'awaiting_review', 'Waiting for review', 'queue', 'Add to merge queue'],
    ['ready', mine(), {}, 'ready', 'Ready to merge', 'merge', 'Merge'],
    ['ready with optional failures', mine({}, { blockingReason: 'checks_failed_optional', checks: { total: 4, passed: 3, failed: 1, inProgress: 0, skipped: 0 } }), {},
      'ready', 'Ready to merge', 'merge', 'Merge'],
    ['held by a branch rule', mine({}, { blockingReason: 'blocked' }), {}, 'branch_rule', 'Blocked by a branch rule', 'queue', 'Add to merge queue'],
    ['GitHub has not answered', mine({}, { blockingReason: 'unknown', mergeable: 'UNKNOWN' }), {}, 'waiting', 'Waiting for GitHub', 'queue', 'Add to merge queue'],
    ['review requested from me', theirs({ reviewRequested: true }), {}, 'review_requested', 'Your review is requested', 'approve', 'Approve'],
    ['review requested, a review exists', theirs({ reviewRequested: true }), { codeReview: 'running' }, 'review_requested', 'Your review is requested', 'approve', 'Approve'],
    ['someone else', theirs({}, { blockingReason: 'mergeable' }), {}, 'other', 'Ready to merge', 'open', 'Open on GitHub'],
  ])('%s', (_name, row, extra, key, verdict, kind, label) => {
    const step = next(row, extra);
    expect(step.key).toBe(key);
    expect(step.verdict).toBe(verdict);
    expect(step.primary?.kind ?? null).toBe(kind);
    expect(step.primary?.label ?? null).toBe(label);
  });

  it.each([
    ['danger', mine({}, { blockingReason: 'merge_conflicts' })],
    ['warning', mine({}, { blockingReason: 'changes_requested', reviewDecision: 'CHANGES_REQUESTED' })],
    ['success', mine()],
    ['neutral', mine({ state: 'merged' })],
    ['information', mine(queue({ status: 'awaiting_ci' }))],
  ] as const)('gives the card a %s tone', (tone, row) => {
    expect(next(row).tone).toBe(tone);
  });

  it('first match wins: a running queue fix suppresses Fix even with failing checks', () => {
    const row = mine(queue({ status: 'fixing', fixKind: 'blockers' }), { blockingReason: 'checks_failed', checks: { total: 2, passed: 1, failed: 1, inProgress: 0, skipped: 0 } });
    const step = next(row);
    expect(step.key).toBe('agent');
    expect(step.primary).toBeNull();
  });

  it('a running session suppresses Fix and links the session', () => {
    const row = mine({ ...queue({ status: 'fixing', fixKind: 'session' }), session: { id: 's1', name: 'chore-data', status: 'ready' } },
      { blockingReason: 'merge_conflicts' });
    const step = next(row);
    expect(step.primary).toEqual({ kind: 'session', label: 'View session' });
    expect(step.session).toEqual({ id: 's1', name: 'chore-data' });
    expect(step.detail).toBe('The merge queue asked the session "chore-data" to fix this pull request. It waits for the session\'s turn to end.');
  });

  it('a blocked fix carries its reason instead of a live button', () => {
    const row = mine({}, { blockingReason: 'checks_failed', checks: { total: 2, passed: 1, failed: 1, inProgress: 0, skipped: 0 } });
    expect(next(row, {}, { fixBlocked: 'task_running' }).primary).toEqual({ kind: 'fix', label: 'Fix with agent',
      disabledReason: 'A run is already working this PR. Stop it before you start another.' });
    expect(next(row).primary?.disabledReason).toBeUndefined();
  });

  it('a queue stop does not offer a fix that cannot run', () => {
    const row = mine(queue({ status: 'blocked', reason: 'Checks fail.' }), { blockingReason: 'checks_failed',
      checks: { total: 2, passed: 1, failed: 1, inProgress: 0, skipped: 0 } });
    expect(next(row, {}, { fixBlocked: 'task_running' }).primary?.kind).toBe('requeue');
  });

  it.each([
    ['author', mine({}, { blockingReason: 'merge_conflicts' }), 'conflicts', 'fix'],
    ['reviewer', theirs({ reviewRequested: true }, { blockingReason: 'merge_conflicts' }), 'review_requested', 'approve'],
    ['bystander', theirs({}, { blockingReason: 'merge_conflicts' }), 'other', 'open'],
  ] as const)('the %s gets their own next step', (_who, row, key, kind) => {
    const step = next(row);
    expect(step.key).toBe(key);
    expect(step.primary?.kind).toBe(kind);
  });

  it.each<[string, PRRow, Partial<NextStepInput>, string, string | null, string | null]>([
    ['review requested', theirs({ reviewRequested: true }), {}, 'review_requested', 'approve', 'request_changes'],
    ['review requested, a code review is ready', theirs({ reviewRequested: true }), { codeReview: 'ready' }, 'review_requested', 'approve', 'request_changes'],
    ['review requested, I already approved', theirs({ reviewRequested: true }, { reviewDecision: 'APPROVED' }), {}, 'review_requested', 'approve', 'request_changes'],
    ['review requested on my own PR', mine({ reviewRequested: true }), {}, 'ready', 'merge', null],
    ['review requested on a closed PR', theirs({ reviewRequested: true, state: 'closed' }), {}, 'closed', 'open', null],
    ['review requested on a merged PR', theirs({ reviewRequested: true, state: 'merged' }), {}, 'merged', 'open', null],
    ['review requested on a draft', theirs({ reviewRequested: true }, { draft: true }), {}, 'draft', 'open', null],
    ['review requested while a run fixes it', theirs({ reviewRequested: true }), { taskRunning: true }, 'agent', null, null],
    ['no review requested', theirs(), {}, 'other', 'open', null],
    ['my own PR', mine(), {}, 'ready', 'merge', null],
  ])('%s: primary and secondary', (_name, row, extra, key, primary, secondary) => {
    const step = next(row, extra);
    expect(step.key).toBe(key);
    expect(step.primary?.kind ?? null).toBe(primary);
    expect(step.secondary?.kind ?? null).toBe(secondary);
  });

  it('labels the review actions', () => {
    const step = next(theirs({ reviewRequested: true }));
    expect(step.primary).toEqual({ kind: 'approve', label: 'Approve' });
    expect(step.secondary).toEqual({ kind: 'request_changes', label: 'Request changes' });
  });

  it('names up to three failing checks, required first, and counts from the live list', () => {
    const row = mine({}, { blockingReason: 'checks_failed', checks: { total: 6, passed: 1, failed: 5, inProgress: 0, skipped: 0 } });
    const step = next(row, { checkContexts: [check('lint', 'failure'), check('e2e', 'failure'), check('unit', 'failure'), check('types', 'failure'),
      check('optional', 'failure', false), check('build', 'success')] });
    // Every failing check counts, as in the badge; the detail says how many block the merge.
    expect(step.verdict).toBe('5 checks are failing');
    expect(step.detail).toBe('4 are required and must pass before it can merge.');
    expect(step.failing).toEqual(['e2e', 'lint', 'types']);
    expect(next(mine({}, { blockingReason: 'checks_failed', checks: { total: 1, passed: 0, failed: 1, inProgress: 0, skipped: 0 } })).verdict).toBe('1 check is failing');
  });

  it('says how many review comments are open', () => {
    const step = next(mine({}, { blockingReason: 'changes_requested', unresolvedReviewThreads: 2 }));
    expect(step.verdict).toBe('Changes requested');
    expect(step.detail).toBe('2 comments are not resolved.');
  });

  it('a non-author never gets a merge or fix action', () => {
    for (const s of [{ blockingReason: 'mergeable' }, { blockingReason: 'checks_failed' }, { blockingReason: 'merge_conflicts' }] as const) {
      expect(['merge', 'fix']).not.toContain(next(theirs({}, s)).primary?.kind);
    }
  });

  it('the queue line in the card leaves out the position the verdict already names', () => {
    const entry = { status: 'awaiting_ci', position: 2 } as MergeQueuePublic;
    expect(queueStatusLine(entry)).toBe(`#2 · ${queueStatusLabel(entry)}`);
    expect(next(mine(queue({ status: 'awaiting_ci' }))).detail).toBe(queueStatusLabel(entry));
  });
});

describe('PR detail model', () => {
  it('groups checks failing first, with optional and human-gated ones tagged', () => {
    const groups = groupChecks([check('b', 'failure'), check('a', 'failure', false), check('run', 'in_progress'), check('wait', 'pending'),
      check('ok', 'success'), check('skip', 'skipped')]);
    expect(groups.failing.map((item) => [item.check.name, item.optional])).toEqual([['b', false], ['a', true]]);
    expect(groups.running.map((item) => item.name)).toEqual(['run', 'wait']);
    expect(groups.passed).toHaveLength(1);
    expect(groups.skipped).toHaveLength(1);
    // The badge counts optional failures too, as the card and the list do.
    expect(failingBadge(groups, 9)).toBe(2);
    expect(failingBadge(groupChecks([]), 3)).toBe(3);
  });

  it('treats an unknown required flag as optional when GitHub says the PR can merge', () => {
    expect(groupChecks([check('x', 'failure', null)], 'checks_failed_optional').failing[0].optional).toBe(true);
    expect(groupChecks([check('x', 'failure', null)], 'checks_failed').failing[0].optional).toBe(false);
  });

  it('orders reviews, threads and comments by time and drops empty comment reviews', () => {
    const detail: PRReviewDetail = {
      reviews: [{ id: '1', author: 'a', avatarUrl: null, state: 'APPROVED', body: '', submittedAt: '2026-11-03T00:00:00Z', url: '' },
        { id: '2', author: 'b', avatarUrl: null, state: 'COMMENTED', body: ' ', submittedAt: '2026-11-01T00:00:00Z', url: '' }],
      threads: [{ id: 't', isResolved: false, isOutdated: false, path: 'a.ts', line: 3, diffHunk: null,
        comments: [{ id: 'tc', author: 'c', avatarUrl: null, body: 'Hm', createdAt: '2026-11-02T00:00:00Z', url: '' }] }],
      comments: [{ id: 'c', author: 'd', avatarUrl: null, body: 'Hi', createdAt: '2026-11-04T00:00:00Z', url: '' }],
    };
    expect(reviewTimeline(detail).map((item) => item.key)).toEqual(['t:t', 'r:1', 'c:c']);
    expect(reviewTimeline(undefined)).toEqual([]);
  });

  it.each([
    ['short', 'One line', false],
    ['many lines', Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n'), true],
    ['one long paragraph', 'x'.repeat(900), true],
  ])('folds a %s description: %#', (_name, body, long) => {
    expect(descriptionIsLong(body)).toBe(long);
  });

  it('keeps the last hunk lines and sums file counts', () => {
    expect(lastHunkLines('1\n2\n3\n4\n5\n6\n7\n8', 3)).toBe('6\n7\n8');
    expect(lastHunkLines('1\n2', 3)).toBe('1\n2');
    expect(fileTotals([{ sha: '', filename: 'a', status: 'added', additions: 3, deletions: 1, changes: 4 },
      { sha: '', filename: 'b', status: 'removed', additions: 0, deletions: 5, changes: 5 }])).toEqual({ added: 3, removed: 6 });
  });
});

describe('automation toggle text', () => {
  const { queueToggleText, keepToggleText } = jest.requireActual('../features/prs/AutomationToggles') as typeof import('../features/prs/AutomationToggles');
  it.each([
    [{ mergeQueued: false }, 'Merge queue'],
    [{ mergeQueued: true, mergeQueue: { status: 'queued', position: 4 } }, 'Queued #4'],
    [{ mergeQueued: true, mergeQueue: { status: 'fixing' } }, 'Queue: fixing'],
    [{ mergeQueued: true, mergeQueue: { status: 'merging' } }, 'Queue: merging'],
    [{ mergeQueued: true, mergeQueue: { status: 'blocked' } }, 'Queue blocked'],
  ])('queue %j reads %s', (row, text) => {
    expect(queueToggleText(row as never)).toBe(text);
  });
  it.each([
    [{ autoKeepMergeable: false }, 'Keep mergeable'],
    [{ autoKeepMergeable: true }, 'Keeping mergeable'],
    [{ autoKeepMergeable: true, autoMergeState: { paused: true } }, 'Keep mergeable paused'],
  ])('keep mergeable %j reads %s', (row, text) => {
    expect(keepToggleText(row as never)).toBe(text);
  });
});
