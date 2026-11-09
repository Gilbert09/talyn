import type { PRRow } from '@talyn/client/native';
import type { Workbench } from '@talyn/shared';

import { canQueue, cycleActions, diffTotals, primaryActions, primaryCycleAction } from '../features/sessions/quickActions';
import { chat, pr, session, thread } from './workflowFixtures';

const row = (summary: Partial<PRRow['summary']> = {}, patch: Partial<PRRow> = {}) => pr({ ...patch, summary: { ...pr().summary, ...summary } });
const mergeable = { mergeable: 'MERGEABLE', ciStatus: 'passing', blockingReason: 'mergeable' } as const;
const conflicts = { mergeable: 'CONFLICTING', blockingReason: 'merge_conflicts' } as const;
const failing = { mergeable: 'MERGEABLE', ciStatus: 'failing_required', blockingReason: 'checks_failed' } as const;
const noPr = (patch: Partial<Workbench> = {}) => session({ pullRequestId: null, pr: null, ...patch });
const changes = { diffStat: { added: 3, removed: 1, files: 2 } };
const kinds = (item: Workbench, pull: PRRow | null, options: Parameters<typeof primaryActions>[2] = {}) =>
  primaryActions(item, pull, options).map((action) => action.kind);

describe('primaryActions', () => {
  it.each<[string, Workbench, PRRow | null, string[]]>([
    ['archived work only restores', session({ archivedAt: '2026-11-09T10:00:00Z' }), row(mergeable), ['restore']],
    ['archived by status only restores', session({ status: 'archived' }), null, ['restore']],
    ['a quiet session with no PR and no changes has nothing', noPr(), null, []],
    ['changes with no PR offer Create PR', noPr(changes), null, ['create_pr']],
    ['committed work alone offers Create PR', noPr({ committedStats: { added: 1, removed: 0, files: 1 } }), null, ['create_pr']],
    ['conflicts come first, then the queue', session(), row(conflicts), ['resolve_conflicts', 'queue_add']],
    ['failing checks offer Fix checks and the queue', session(), row(failing), ['fix_checks', 'queue_add']],
    ['a mergeable PR offers Merge and the queue', session(), row(mergeable), ['merge', 'queue_add']],
    ['no checks configured counts as green', session(), row({ mergeable: 'MERGEABLE', ciStatus: 'none' }), ['merge', 'queue_add']],
    ['pending checks wait, leaving the queue', session(), row({ mergeable: 'MERGEABLE', ciStatus: 'running' }), ['queue_add']],
    ['unknown mergeability waits, leaving the queue', session(), row(), ['queue_add']],
    ['a queued PR shows its queue state', session(), row(mergeable, { mergeQueued: true, mergeQueue: { position: 3, status: 'queued' } as never }), ['merge', 'queue_status']],
    ['a merged PR offers Archive', session(), row({}, { state: 'merged' }), ['archive']],
    ['a closed PR offers Archive', session(), row({}, { state: 'closed' }), ['archive']],
    ['a running turn puts Stop first', session({ chats: [chat({ status: 'running' })] }), row(conflicts), ['stop', 'resolve_conflicts']],
    ['a failed start offers Retry', noPr({ status: 'error', error: 'Boom.' }), null, ['retry']],
    ['a failed sandbox offers Retry before the PR action', session({ sandboxState: 'error' }), row(mergeable), ['retry', 'merge']],
    ['a sleeping sandbox offers Wake last', noPr({ sandboxState: 'suspended' }), null, ['wake']],
    ['Wake falls off when two actions come first', session({ sandboxState: 'suspended' }), row(mergeable), ['merge', 'queue_add']],
    ['a thread never gets PR actions', thread(), null, []],
    ['a running thread can stop', { ...thread(), chats: [chat({ id: 'thread-chat', status: 'running' })] }, null, ['stop']],
    ['a sleeping thread can wake', { ...thread(), sandboxState: 'suspended' }, null, ['wake']],
    ['a linked PR still loading waits instead of offering Create PR', session({ diffStat: changes.diffStat }), null, []],
    ['the workbench summary drives the cycle before the row loads', session({ pr: { number: 42, url: '', state: 'open', mergeable: 'conflicting', ciStatus: 'success' } }), null, ['resolve_conflicts']],
  ])('%s', (_name, item, pull, expected) => {
    expect(kinds(item, pull)).toEqual(expected);
  });

  it('keeps at most the limit', () => {
    const item = session({ chats: [chat({ status: 'running' })], sandboxState: 'running' });
    expect(kinds(item, row(conflicts), { limit: 3 })).toEqual(['stop', 'resolve_conflicts', 'queue_add']);
    expect(kinds(item, row(conflicts), { limit: 1 })).toEqual(['stop']);
  });

  it.each([
    ['Create PR', noPr(changes), null, 'create_pr', 'Create PR'],
    ['Resolve conflicts', session(), row(conflicts), 'resolve_conflicts', 'Resolve conflicts'],
    ['Merge', session(), row(mergeable), 'merge', 'Merge'],
    ['Archive after a merge', session(), row({}, { state: 'merged' }), 'archive', 'Archive session'],
    ['Archive after a close', session(), row({}, { state: 'closed' }), 'archive', 'Archive'],
    ['Queue', session(), row(), 'queue_add', 'Add to merge queue'],
    ['Queue state', session(), row({}, { mergeQueued: true, mergeQueue: { position: 2, status: 'queued' } as never }), 'queue_status', 'Queued #2'],
  ] as const)('labels %s', (_name, item, pull, kind, label) => {
    expect(primaryActions(item, pull, { limit: 5 }).find((action) => action.kind === kind)?.label).toBe(label);
  });

  it.each([
    ['a local session cannot send prompts', noPr({ ...changes, runtime: 'local' }), null, 'create_pr', 'This session runs on a computer with the Talyn desktop app. Open it there.'],
    ['a starting sandbox cannot send prompts', session({ status: 'provisioning' }), row(conflicts), 'resolve_conflicts', 'The sandbox is starting.'],
    ['merge needs the row', session({ pr: { number: 42, url: '', state: 'open', mergeable: 'mergeable', ciStatus: 'success' } }), null, 'merge', 'The pull request is still loading.'],
    ['a ready session can act', session(), row(conflicts), 'resolve_conflicts', null],
  ] as const)('gives a reason when %s', (_name, item, pull, kind, reason) => {
    expect(primaryActions(item, pull, { limit: 5 }).find((action) => action.kind === kind)?.disabledReason).toBe(reason);
  });

  it('disables every action offline but the queue state, which only navigates', () => {
    const actions = primaryActions(session({ chats: [chat({ status: 'running' })] }), row(mergeable, { mergeQueued: true }), { offline: true, limit: 5 });
    expect(actions.map((action) => [action.kind, action.disabledReason])).toEqual([
      ['stop', 'You are offline.'], ['merge', 'You are offline.'], ['queue_status', null],
    ]);
  });

  it('puts the failure in the Retry hint', () => {
    expect(primaryActions(noPr({ status: 'error', error: 'The sandbox did not start.' }), null)[0].hint).toBe('The sandbox did not start.');
  });

  it('stops the selected running chat when there are two', () => {
    const item = session({ chats: [chat({ id: 'a', status: 'idle' }), chat({ id: 'b', status: 'running' })] });
    expect(kinds(item, null, { selectedChat: 'a' })).toEqual(['stop']);
  });
});

describe('cycleActions', () => {
  it.each<[string, Workbench, PRRow | null, string[]]>([
    ['no PR offers Create PR even before the diff stat', noPr(), null, ['create_pr']],
    ['conflicts offer Resolve but not Merge', session(), row(conflicts), ['resolve_conflicts']],
    ['failing optional checks still offer Fix checks and Merge', session(), row({ mergeable: 'MERGEABLE', ciStatus: 'failing_optional' }), ['fix_checks', 'merge']],
    ['running checks still offer Merge', session(), row({ mergeable: 'MERGEABLE', ciStatus: 'running' }), ['merge']],
    ['a draft with running checks does not offer Merge', session(), row({ draft: true, mergeable: 'MERGEABLE', ciStatus: 'running' }), []],
    ['a merged PR offers nothing here', session(), row({}, { state: 'merged' }), []],
    ['archived work offers nothing', session({ archivedAt: '2026-11-09T10:00:00Z' }), row(conflicts), []],
    ['a thread offers nothing', thread(), null, []],
  ])('%s', (_name, item, pull, expected) => {
    expect(cycleActions(item, pull)).toEqual(expected);
  });
});

describe('primaryCycleAction', () => {
  it.each<[string, Workbench, PRRow | null, string | null]>([
    ['no PR and no changes waits', noPr(), null, null],
    ['no PR with changes creates one', noPr(changes), null, 'create_pr'],
    ['a merged PR archives', session(), row({}, { state: 'merged' }), 'archive'],
    ['conflicts before failing checks', session(), row({ mergeable: 'CONFLICTING', ciStatus: 'failing_required' }), 'resolve_conflicts'],
    ['a thread has none', thread(), null, null],
  ])('%s', (_name, item, pull, expected) => {
    expect(primaryCycleAction(item, pull)).toBe(expected);
  });
});

describe('canQueue', () => {
  it.each<[string, Workbench, PRRow | null, boolean]>([
    ['an open PR on a live session', session(), row(), true],
    ['no row yet', session(), null, false],
    ['a merged PR', session(), row({}, { state: 'merged' }), false],
    ['an archived session', session({ archivedAt: '2026-11-09T10:00:00Z' }), row(), false],
    ['a thread', thread(), row(), false],
  ])('%s', (_name, item, pull, expected) => {
    expect(canQueue(item, pull)).toBe(expected);
  });
});

describe('diffTotals', () => {
  it.each([
    ['nothing', {}, null],
    ['an empty diff', { diffStat: { added: 0, removed: 0, files: 0 } }, null],
    ['the legacy diff stat', { diffStat: { added: 4, removed: 2, files: 1 } }, { files: 1, added: 4, removed: 2 }],
    ['committed and uncommitted together', { diffStat: { added: 9, removed: 9, files: 9 }, committedStats: { added: 3, removed: 1, files: 2 },
      uncommittedStats: { added: 1, removed: 1, files: 1 } }, { files: 3, added: 4, removed: 2 }],
    ['committed only', { committedStats: { added: 5, removed: 0, files: 1 } }, { files: 1, added: 5, removed: 0 }],
  ] as const)('%s', (_name, item, expected) => {
    expect(diffTotals({ diffStat: null, ...item } as Parameters<typeof diffTotals>[0])).toEqual(expected);
  });
});
