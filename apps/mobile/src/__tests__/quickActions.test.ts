import type { PRRow } from '@talyn/client/native';
import type { Workbench } from '@talyn/shared';

import { canQueue, cycleActions, diffTotals, primaryAction, primaryCycleAction } from '../features/sessions/quickActions';
import { chat, pr, session, thread } from './workflowFixtures';

const row = (summary: Partial<PRRow['summary']> = {}, patch: Partial<PRRow> = {}) => pr({ ...patch, summary: { ...pr().summary, ...summary } });
const mergeable = { mergeable: 'MERGEABLE', ciStatus: 'passing', blockingReason: 'mergeable' } as const;
const conflicts = { mergeable: 'CONFLICTING', blockingReason: 'merge_conflicts' } as const;
const failing = { mergeable: 'MERGEABLE', ciStatus: 'failing_required', blockingReason: 'checks_failed' } as const;
const noPr = (patch: Partial<Workbench> = {}) => session({ pullRequestId: null, pr: null, ...patch });
const changes = { diffStat: { added: 3, removed: 1, files: 2 } };
describe('primaryAction', () => {
  it.each<[string, Workbench, PRRow | null, string | null]>([
    ['an archived session has no next action', session({ archivedAt: '2026-11-09T10:00:00Z' }), row(mergeable), null],
    ['an archived status has no next action', session({ status: 'archived' }), null, null],
    ['an archived thread offers Restore', { ...thread(), archivedAt: '2026-11-09T10:00:00Z' }, null, 'restore'],
    ['no PR and no changes waits', noPr(), null, null],
    ['changes with no PR offer Create PR', noPr(changes), null, 'create_pr'],
    ['committed work also offers Create PR', noPr({ committedStats: { added: 1, removed: 0, files: 1 } }), null, 'create_pr'],
    ['conflicts offer Resolve conflicts', session(), row(conflicts), 'resolve_conflicts'],
    ['failing checks offer Fix checks', session(), row(failing), 'fix_checks'],
    ['a mergeable PR offers Merge', session(), row(mergeable), 'merge'],
    ['a draft PR with passing checks waits', session(), row({ ...mergeable, draft: true }), null],
    ['no checks configured counts as green', session(), row({ mergeable: 'MERGEABLE', ciStatus: 'none' }), 'merge'],
    ['pending checks wait', session(), row({ mergeable: 'MERGEABLE', ciStatus: 'running' }), null],
    ['unknown mergeability waits', session(), row(), null],
    ['a queued PR waits for the merge queue', session(), row(mergeable, { mergeQueued: true }), null],
    ['a queued PR still offers Fix checks', session(), row(failing, { mergeQueued: true }), 'fix_checks'],
    ['a merged PR offers Archive', session(), row({}, { state: 'merged' }), 'archive'],
    ['a closed PR offers Archive', session(), row({}, { state: 'closed' }), 'archive'],
    ['a running turn leaves Stop to the composer', session({ chats: [chat({ status: 'running' })] }), row(conflicts), 'resolve_conflicts'],
    ['a failed start offers Retry', noPr({ status: 'error', error: 'Boom.' }), null, 'retry'],
    ['a failed sandbox offers Retry before Merge', session({ sandboxState: 'error' }), row(mergeable), 'retry'],
    ['a sleeping sandbox leaves Wake to the menu', noPr({ sandboxState: 'suspended' }), null, null],
    ['a sleeping sandbox still offers Merge', session({ sandboxState: 'suspended' }), row(mergeable), 'merge'],
    ['a thread has no PR action', thread(), null, null],
    ['a running thread has no next action', { ...thread(), chats: [chat({ id: 'thread-chat', status: 'running' })] }, null, null],
    ['a sleeping thread has no next action', { ...thread(), sandboxState: 'suspended' }, null, null],
    ['a linked PR still loading waits', session({ diffStat: changes.diffStat }), null, null],
    ['the workbench summary applies before the row loads', session({ pr: { number: 42, url: '', state: 'open', mergeable: 'conflicting', ciStatus: 'success' } }), null, 'resolve_conflicts'],
  ])('%s', (_name, item, pull, expected) => {
    expect(primaryAction(item, pull)?.kind ?? null).toBe(expected);
  });

  it.each([
    ['Create PR', noPr(changes), null, 'Create PR'],
    ['Resolve conflicts', session(), row(conflicts), 'Resolve conflicts'],
    ['Merge', session(), row(mergeable), 'Merge'],
    ['Archive after a merge', session(), row({}, { state: 'merged' }), 'Archive session'],
    ['Archive after a close', session(), row({}, { state: 'closed' }), 'Archive'],
  ] as const)('labels %s', (_name, item, pull, label) => {
    expect(primaryAction(item, pull)?.label).toBe(label);
  });

  it.each([
    ['a local session cannot send prompts', noPr({ ...changes, runtime: 'local' }), null, 'This session runs on a computer with the Talyn desktop app. Open it there.'],
    ['a starting sandbox cannot send prompts', session({ status: 'provisioning' }), row(conflicts), 'The sandbox is starting.'],
    ['merge needs the row', session({ pr: { number: 42, url: '', state: 'open', mergeable: 'mergeable', ciStatus: 'success' } }), null, 'The pull request is still loading.'],
    ['a ready session can act', session(), row(conflicts), null],
  ] as const)('gives a reason when %s', (_name, item, pull, reason) => {
    expect(primaryAction(item, pull)?.disabledReason).toBe(reason);
  });

  it('disables the next action offline', () => {
    expect(primaryAction(session(), row(mergeable), true)?.disabledReason).toBe('You are offline.');
  });

  it('puts the failure in the Retry hint', () => {
    expect(primaryAction(noPr({ status: 'error', error: 'The sandbox did not start.' }), null)?.hint).toBe('The sandbox did not start.');
  });
});

describe('cycleActions', () => {
  it.each<[string, Workbench, PRRow | null, string[]]>([
    ['no PR offers Create PR even before the diff stat', noPr(), null, ['create_pr']],
    ['conflicts offer Resolve but not Merge', session(), row(conflicts), ['resolve_conflicts']],
    ['failing optional checks still offer Fix checks and Merge', session(), row({ mergeable: 'MERGEABLE', ciStatus: 'failing_optional' }), ['fix_checks', 'merge']],
    ['running checks still offer Merge', session(), row({ mergeable: 'MERGEABLE', ciStatus: 'running' }), ['merge']],
    ['a draft with running checks does not offer Merge', session(), row({ draft: true, mergeable: 'MERGEABLE', ciStatus: 'running' }), []],
    ['a draft with passing checks does not offer Merge', session(), row({ ...mergeable, draft: true }), []],
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
