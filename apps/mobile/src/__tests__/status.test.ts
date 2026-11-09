import type { WorkbenchPullRequestSummary } from '@talyn/shared';

import { prNumberTone, prReview, prRowStatus, prStatus, sessionPr, sessionState, workbenchState } from '../lib/status';
import { chat, pr, session } from './workflowFixtures';

const checks = (patch: Partial<{ total: number; passed: number; failed: number; inProgress: number; skipped: number }> = {}) =>
  ({ total: 4, passed: 4, failed: 0, inProgress: 0, skipped: 0, ...patch });
const linked = (patch: Partial<WorkbenchPullRequestSummary> = {}) =>
  ({ number: 7, url: 'https://github.com/example/project/pull/7', state: 'open', mergeable: 'mergeable', ciStatus: 'success', ...patch } as WorkbenchPullRequestSummary);

describe('session state', () => {
  it.each([
    ['a failed start', session({ status: 'error' }), 'failed'],
    ['a sandbox error', session({ sandboxState: 'error' }), 'failed'],
    ['a failed chat', session({ chats: [chat({ status: 'error' })] }), 'failed'],
    ['provisioning', session({ status: 'provisioning' }), 'starting'],
    ['a creating sandbox', session({ sandboxState: 'creating' }), 'starting'],
    ['a running chat', session({ chats: [chat({ status: 'running' })] }), 'working'],
    ['a queued message', session({ chats: [chat({ queuedMessages: [{ id: 'q', text: 'x', queuedAt: '2026-11-08T10:00:00Z' }] as never })] }), 'working'],
    ['a question for the user', session({ chats: [chat({ status: 'awaiting_input' })] }), 'needs_reply'],
    ['a merged PR', session({ pr: linked({ state: 'merged' }) }), 'merged'],
    ['a closed PR', session({ pr: linked({ state: 'closed' }) }), 'closed'],
    ['conflicts', session({ pr: linked({ mergeable: 'conflicting' }) }), 'pr_attention'],
    ['failing checks', session({ pr: linked({ ciStatus: 'failure' }) }), 'pr_waiting'],
    ['a green PR', session({ pr: linked() }), 'ready_to_merge'],
    ['pending checks', session({ pr: linked({ ciStatus: 'pending' }) }), 'pr_waiting'],
    ['unknown mergeability', session({ pr: linked({ mergeable: 'unknown' }) }), 'pr_waiting'],
    ['unshipped changes', session({ diffStat: { files: 2, additions: 3, deletions: 1 } as never }), 'unshipped'],
    ['nothing', session(), 'idle'],
  ])('reads %s', (_name, item, kind) => expect(workbenchState(item).kind).toBe(kind));
  it('prefers failure over live work, and live work over a PR', () => {
    expect(sessionState(session({ status: 'error' }), [chat({ status: 'running' })], null).kind).toBe('failed');
    expect(sessionState(session(), [chat({ status: 'running' })], sessionPr({ pr: linked({ state: 'merged' }) })).kind).toBe('working');
  });
  it('labels the state in plain words', () => {
    expect(workbenchState(session({ pr: linked({ mergeable: 'conflicting' }) })).label).toBe('#7 has conflicts');
    expect(workbenchState(session()).label).toBe('Idle');
  });
  it('uses a held PR row before the workbench summary', () => {
    const row = pr({ number: 9, state: 'merged' });
    expect(sessionPr(session({ pr: linked() }), row)?.number).toBe(9);
    expect(sessionPr(session({ pr: null }))).toBeNull();
  });
  it('shows no PR state for a thread', () => expect(workbenchState(session({ kind: 'thread', pr: linked() })).kind).toBe('idle'));
});

describe('PR status pill', () => {
  it.each([
    ['merged', { state: 'merged' as const }, 'Merged', 'merged'],
    ['closed', { state: 'closed' as const }, 'Closed', 'muted'],
    ['conflicts', { state: 'open' as const, blockingReason: 'merge_conflicts' as const, checks: checks() }, 'Conflicts', 'destructive'],
    ['required failures', { state: 'open' as const, blockingReason: 'checks_failed' as const, checks: checks({ failed: 2, passed: 12, total: 14 }), ciStatus: 'failing_required' as const }, '2/14 failing', 'destructive'],
    ['optional failures', { state: 'open' as const, blockingReason: 'checks_failed_optional' as const, checks: checks({ failed: 1 }) }, '1 non-required', 'success'],
    ['running', { state: 'open' as const, blockingReason: 'mergeable' as const, checks: checks({ inProgress: 3, passed: 1 }) }, '3/4 running', 'information'],
    ['ready', { state: 'open' as const, blockingReason: 'mergeable' as const, checks: checks() }, 'Ready', 'success'],
    ['a person gate', { state: 'open' as const, blockingReason: 'needs_human' as const, checks: checks() }, 'Needs human', 'warning'],
    ['behind', { state: 'open' as const, blockingReason: 'behind' as const, checks: checks() }, 'Behind', 'warning'],
    ['unknown', { state: 'open' as const, blockingReason: 'unknown' as const, checks: checks() }, 'Unknown', 'muted'],
    ['blocked on review, review hidden', { state: 'open' as const, blockingReason: 'blocked' as const, checks: checks(), ciStatus: 'passing' as const }, 'Ready', 'success'],
    ['blocked on review, review shown', { state: 'open' as const, blockingReason: 'blocked' as const, checks: checks(), includeReview: true }, 'Review', 'warning'],
    ['approved but protected', { state: 'open' as const, blockingReason: 'blocked' as const, checks: checks(), includeReview: true, reviewDecision: 'APPROVED' as const }, 'Protected', 'warning'],
    ['changes requested, review shown', { state: 'open' as const, blockingReason: 'changes_requested' as const, checks: checks(), includeReview: true }, 'Changes requested', 'warning'],
    ['a queue testing it', { state: 'open' as const, blockingReason: 'mergeable' as const, checks: checks(), externalQueueState: 'testing' as const }, 'Queue: testing', 'information'],
    ['a queue that refused it', { state: 'open' as const, blockingReason: 'mergeable' as const, checks: checks(), externalQueueState: 'rejected' as const }, 'Queue: refused', 'destructive'],
    ['a queue holding it with its own reason', { state: 'open' as const, blockingReason: 'merge_conflicts' as const, checks: checks(), externalQueueState: 'not_ready' as const }, 'Conflicts', 'destructive'],
  ])('reads %s', (_name, input, label, tone) => expect(prStatus(input)).toMatchObject({ label, tone }));
  it('merges mergeability and merge state into one answer for a row', () => {
    const row = pr({ summary: { ...pr().summary, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', blockingReason: 'blocked', ciStatus: 'passing', checks: checks() } });
    expect(prRowStatus(row).label).toBe('Ready');
    expect(prRowStatus(row, true).label).toBe('Review');
  });
});

describe('PR review pill and number', () => {
  it.each([
    ['APPROVED', 'open', 'Approved'], ['CHANGES_REQUESTED', 'open', 'Changes requested'], ['REVIEW_REQUIRED', 'open', 'Needs approval'],
    [null, 'open', null], ['APPROVED', 'merged', null], ['REVIEW_REQUIRED', 'closed', null],
  ] as const)('maps %s on an %s PR', (decision, state, label) => expect(prReview(decision, state)?.label ?? null).toBe(label));
  it.each([['merged', false, 'merged'], ['closed', false, 'destructive'], ['open', true, 'muted'], ['open', false, 'success']] as const)(
    'tints a %s PR (draft %s) %s', (state, draft, tone) => expect(prNumberTone(state, draft)).toBe(tone));
});
