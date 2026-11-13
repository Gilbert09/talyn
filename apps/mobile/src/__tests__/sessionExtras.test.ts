import type { Workbench, WorkbenchChangedFile, WorkbenchChanges } from '@talyn/shared';

import { archivedAtOf, archivedItems, emptyHistoryText, historyRows } from '../features/history/model';
import { copyActions, copyEntry } from '../features/sessions/actions';
import { formatCountdown, formatRunTime, jobStatus, keepAwakeLabel, runningJobs, sortWakeups, wakeupWhen } from '../features/sessions/background';
import { changeGroups, clipLine, fileLabel, groupTotals, gutterDigits, needsWake, parseUnifiedDiff, splitPath, storedText,
  visibleDiff, type DiffLine } from '../features/sessions/changes';
import { canCreatePullRequest, changesUnavailable, createPrSentText, hasChanges, sessionTabs, sessionUnavailable } from '../features/sessions/model';
import { session, thread } from './workflowFixtures';

const PR: NonNullable<Workbench['pr']> = {
  number: 42, url: 'https://github.com/example/project/pull/42', state: 'open', mergeable: 'mergeable', ciStatus: 'success',
};
const stat = (files: number) => ({ added: files * 2, removed: files, files });
const file = (patch: Partial<WorkbenchChangedFile> = {}): WorkbenchChangedFile => ({ path: 'src/app.ts', status: 'modified', added: 3, removed: 1, binary: false, ...patch });

describe('session tabs', () => {
  it.each<[string, Partial<Workbench>, number, string[]]>([
    ['a session with a linked PR', {}, 0, ['chat', 'changes', 'pr']],
    ['a session with no PR and no changes', { pullRequestId: null }, 0, ['chat', 'changes']],
    ['a session with no PR and uncommitted work', { pullRequestId: null, diffStat: stat(2) }, 0, ['chat', 'changes', 'pr']],
    ['a session with no PR and committed work', { pullRequestId: null, committedStats: stat(1) }, 0, ['chat', 'changes', 'pr']],
    ['an archived session with work and no PR', { pullRequestId: null, diffStat: stat(2), archivedAt: '2026-11-09T10:00:00Z' }, 0, ['chat', 'changes']],
    ['a local session with work and no PR', { pullRequestId: null, diffStat: stat(2), runtime: 'local' }, 0, ['chat', 'changes']],
    ['a session with jobs', {}, 2, ['chat', 'changes', 'pr', 'jobs']],
    ['a session with jobs and no PR', { pullRequestId: null }, 1, ['chat', 'changes', 'jobs']],
  ])('%s', (_name, patch, jobs, expected) => {
    expect(sessionTabs(session(patch), { jobs })).toEqual(expected);
  });
  it('keeps a thread on Chat only', () => {
    expect(sessionTabs(thread(), { jobs: 3 })).toEqual(['chat']);
  });
  it.each<[Partial<Workbench>, boolean]>([
    [{ diffStat: null, committedStats: null }, false],
    [{ diffStat: stat(0), committedStats: stat(0) }, false],
    [{ diffStat: stat(1) }, true],
    [{ committedStats: stat(1) }, true],
  ])('has changes for %j: %s', (patch, expected) => {
    expect(hasChanges(session(patch))).toBe(expected);
  });
  it.each<[Partial<Workbench>, boolean]>([
    [{ pullRequestId: null, diffStat: stat(1) }, true],
    [{ pullRequestId: 'pr-one', diffStat: stat(1) }, false],
    [{ pullRequestId: null, diffStat: null }, false],
    [{ pullRequestId: null, diffStat: stat(1), status: 'archived' }, false],
  ])('can create a PR for %j: %s', (patch, expected) => {
    expect(canCreatePullRequest(session(patch))).toBe(expected);
  });
});

describe('availability', () => {
  it.each<[string, Partial<Workbench>, string | null, string | null]>([
    ['a ready session', {}, null, null],
    ['an archived session', { archivedAt: '2026-11-09T10:00:00Z' }, 'This session is archived.', null],
    ['a failed start', { status: 'error', error: 'Boom.' }, 'Boom.', 'Boom.'],
    ['a failed sandbox with no message', { sandboxState: 'error' }, 'The sandbox failed to start.', 'The sandbox failed to start.'],
    ['a lost sandbox', { sandboxState: 'lost' }, 'The sandbox was lost. Talyn is starting a new one.', 'The sandbox was lost. Talyn is starting a new one.'],
    ['a starting sandbox', { status: 'provisioning' }, 'The sandbox is starting.', 'The sandbox is starting.'],
    ['a local session', { runtime: 'local' }, expect.stringContaining('desktop app'), expect.stringContaining('desktop app')],
  ])('%s', (_name, patch, session_, changes) => {
    expect(sessionUnavailable(session(patch))).toEqual(session_);
    expect(changesUnavailable(session(patch))).toEqual(changes);
  });
});

describe('changes', () => {
  const base: WorkbenchChanges = { files: [file()], base: 'abc', headSha: 'def' };
  it('uses one combined group on an older server', () => {
    expect(changeGroups(base).map((group) => group.scope)).toEqual(['combined']);
  });
  it('splits uncommitted and committed when the server does', () => {
    const groups = changeGroups({ ...base, uncommitted: [file()], committed: [] });
    expect(groups.map((group) => [group.scope, group.files.length])).toEqual([['uncommitted', 1], ['committed', 0]]);
  });
  it('totals a group', () => {
    expect(groupTotals([file({ added: 2, removed: 5 }), file({ added: 1, removed: 0 })])).toEqual({ added: 3, removed: 5 });
  });
  it.each<[Partial<WorkbenchChangedFile>, string]>([
    [{}, 'Modified: src/app.ts. 3 added, 1 removed.'],
    [{ status: 'renamed', oldPath: 'src/old.ts' }, 'Renamed: src/old.ts to src/app.ts. 3 added, 1 removed.'],
    [{ status: 'added', binary: true }, 'Added: src/app.ts. Binary file.'],
  ])('labels %j', (patch, expected) => {
    expect(fileLabel(file(patch))).toBe(expected);
  });
  it.each([
    ['src/app.ts', { dir: 'src/', name: 'app.ts' }],
    ['README.md', { dir: '', name: 'README.md' }],
    ['a/b/c/d.tsx', { dir: 'a/b/c/', name: 'd.tsx' }],
  ])('splits %s', (path, expected) => {
    expect(splitPath(path)).toEqual(expected);
  });
  const now = Date.parse('2026-11-09T12:00:00Z');
  it.each<[Partial<WorkbenchChanges>, string | null]>([
    [{}, null],
    [{ snapshotAt: '2026-11-09T11:55:00Z' }, 'Sandbox is asleep. Showing changes from 5 minutes ago.'],
    [{ snapshotAt: '2026-11-09T11:55:00Z', storedReason: 'archived' }, 'This session is archived. Showing changes from 5 minutes ago.'],
    [{ snapshotAt: '2026-11-09T11:55:00Z', stale: 'list_newer' }, 'Sandbox is asleep. Showing changes from 5 minutes ago. This copy is out of date: the session has newer changes.'],
    [{ snapshotAt: '2026-11-09T11:55:00Z', stale: 'sandbox_replaced' }, 'Sandbox is asleep. Showing changes from 5 minutes ago. This copy is from an earlier sandbox.'],
  ])('says where the copy came from for %j', (patch, expected) => {
    expect(storedText({ ...base, ...patch }, now)).toBe(expected);
  });
  it.each<[unknown, boolean]>([
    [{ code: 'snapshot_unavailable', status: 409 }, true],
    [{ code: 'other', status: 409 }, false],
    [new Error('boom'), false],
    [null, false],
    ['snapshot_unavailable', false],
  ])('needs a wake for %j: %s', (error, expected) => {
    expect(needsWake(error)).toBe(expected);
  });
});

describe('unified diff', () => {
  const patch = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 111..222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -10,4 +10,5 @@ export function app() {',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' ',
    '\\ No newline at end of file',
    '@@ -40 +41,2 @@',
    '-old',
    '+new',
    '+--- not a header',
    '',
  ].join('\n');
  const lines = parseUnifiedDiff(patch);
  const pick = (line: DiffLine) => [line.kind, line.text, line.oldLine, line.newLine];
  it('numbers each line from its hunk', () => {
    expect(lines.map(pick)).toEqual([
      ['header', 'diff --git a/src/app.ts b/src/app.ts', null, null],
      ['header', 'index 111..222 100644', null, null],
      ['header', '--- a/src/app.ts', null, null],
      ['header', '+++ b/src/app.ts', null, null],
      ['hunk', '@@ -10,4 +10,5 @@ export function app() {', null, null],
      ['context', 'const a = 1;', 10, 10],
      ['del', 'const b = 2;', 11, null],
      ['add', 'const b = 3;', null, 11],
      ['add', 'const c = 4;', null, 12],
      ['context', '', 12, 13],
      ['note', 'No newline at end of file', null, null],
      ['hunk', '@@ -40 +41,2 @@', null, null],
      ['del', 'old', 40, null],
      ['add', 'new', null, 41],
      ['add', '--- not a header', null, 42],
    ]);
  });
  it.each([
    ['an empty patch', '', []],
    ['CRLF line ends', '@@ -1 +1 @@\r\n-a\r\n+b\r\n', [['hunk', '@@ -1 +1 @@', null, null], ['del', 'a', 1, null], ['add', 'b', null, 1]]],
    ['a second file resets to headers', '@@ -1 +1 @@\n+a\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3 +3 @@\n-z',
      [['hunk', '@@ -1 +1 @@', null, null], ['add', 'a', null, 1], ['header', 'diff --git a/x b/x', null, null], ['header', '--- a/x', null, null],
        ['header', '+++ b/x', null, null], ['hunk', '@@ -3 +3 @@', null, null], ['del', 'z', 3, null]]],
  ])('parses %s', (_name, text, expected) => {
    expect(parseUnifiedDiff(text).map(pick)).toEqual(expected);
  });
  it.each([
    [400, 11, 0],
    [5, 5, 6],
    [0, 0, 11],
  ])('shows %d lines at most, without headers', (limit, shown, hidden) => {
    const result = visibleDiff(lines, limit);
    expect(result.shown).toHaveLength(shown);
    expect(result.hidden).toBe(hidden);
    expect(result.shown.some((line) => line.kind === 'header')).toBe(false);
  });
  it.each([
    ['short', 10, { text: 'short', cut: 0 }],
    ['abcdefghij', 4, { text: 'abcd', cut: 6 }],
    ['abcd', 4, { text: 'abcd', cut: 0 }],
  ])('clips %s at %d', (text, max, expected) => {
    expect(clipLine(text, max)).toEqual(expected);
  });
  it.each<[DiffLine[], number]>([
    [[], 2],
    [[{ kind: 'context', text: '', oldLine: 9, newLine: 9 }], 2],
    [[{ kind: 'add', text: '', oldLine: null, newLine: 1234 }], 4],
    [[{ kind: 'del', text: '', oldLine: 99999, newLine: null }], 5],
  ])('sizes the gutter', (input, digits) => {
    expect(gutterDigits(input)).toBe(digits);
  });
});

describe('background jobs', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  it.each([
    ['2026-11-09T11:59:18Z', null, '42s'],
    ['2026-11-09T11:56:55Z', null, '3m 05s'],
    ['2026-11-09T09:50:00Z', null, '2h 10m'],
    ['2026-11-09T11:00:00Z', '2026-11-09T11:00:30Z', '30s'],
    ['2026-11-09T12:05:00Z', null, '0s'],
  ])('runs from %s to %s: %s', (start, end, expected) => {
    expect(formatRunTime(start, end, now)).toBe(expected);
  });
  it.each([
    [null, null],
    ['2026-11-09T11:00:00Z', null],
    ['2026-11-09T12:00:00Z', null],
  ])('keep-awake for %s is %s', (until, expected) => {
    expect(keepAwakeLabel(until, now)).toBe(expected);
  });
  it('says until when the box stays awake, in local time', () => {
    const until = new Date(now + 90 * 60_000);
    const hh = String(until.getHours()).padStart(2, '0'); const mm = String(until.getMinutes()).padStart(2, '0');
    expect(keepAwakeLabel(until.toISOString(), now)).toBe(`Keeps the box awake until ${hh}:${mm}`);
  });
  it.each([
    [30_000, 'Wakes in less than a minute'],
    [5 * 60_000, 'Wakes in 5 min'],
    [60 * 60_000, 'Wakes in 1 h'],
    [125 * 60_000, 'Wakes in 2 h 5 min'],
    [36 * 3600_000, 'Wakes in 2 days'],
    [24 * 3600_000, 'Wakes in 1 day'],
  ])('counts down %d ms', (delta, expected) => {
    expect(formatCountdown(new Date(now + delta).toISOString(), now)).toBe(expected);
  });
  it.each([
    ['a timed wake-up', null, ['Wakes in 5 min']],
    ['a CI wake-up', { pullRequestId: 'p1', headSha: 'abcdef1234567890abcdef1234567890abcdef12' }, ['Waits for CI on abcdef1', 'Wakes in 5 min at the latest']],
  ])('says when %s fires', (_name, ci, expected) => {
    expect(wakeupWhen({ wakeAt: new Date(now + 5 * 60_000).toISOString(), ci }, now)).toEqual(expected);
  });
  it.each<[{ status: 'running' | 'exited' | 'stopped' | 'lost'; exitCode: number | null }, { label: string; tone: string }]>([
    [{ status: 'running', exitCode: null }, { label: 'Running', tone: 'success' }],
    [{ status: 'exited', exitCode: 0 }, { label: 'Exited', tone: 'muted' }],
    [{ status: 'exited', exitCode: 2 }, { label: 'Failed (exit 2)', tone: 'destructive' }],
    [{ status: 'exited', exitCode: null }, { label: 'Failed (exit unknown)', tone: 'destructive' }],
    [{ status: 'stopped', exitCode: null }, { label: 'Stopped', tone: 'muted' }],
    [{ status: 'lost', exitCode: null }, { label: 'Lost', tone: 'warning' }],
  ])('describes a job %j', (job, expected) => {
    expect(jobStatus(job)).toEqual(expected);
  });
  it('counts running jobs', () => {
    expect(runningJobs(null)).toBe(0);
    expect(runningJobs({ workbenchId: 'x', wakeups: [], jobs: [{ status: 'running' }, { status: 'exited' }, { status: 'running' }] as never })).toBe(2);
  });
  it('orders wake-ups: scheduled soonest first, then the rest newest first', () => {
    const wakeup = (id: string, status: string, wakeAt: string, createdAt: string) => ({ id, status, wakeAt, createdAt }) as never;
    const sorted = sortWakeups([
      wakeup('old', 'fired', '2026-11-09T09:00:00Z', '2026-11-09T08:00:00Z'),
      wakeup('late', 'scheduled', '2026-11-09T15:00:00Z', '2026-11-09T08:00:00Z'),
      wakeup('new', 'cancelled', '2026-11-09T10:00:00Z', '2026-11-09T09:30:00Z'),
      wakeup('soon', 'scheduled', '2026-11-09T13:00:00Z', '2026-11-09T08:00:00Z'),
    ]);
    expect(sorted.map((item: { id: string }) => item.id)).toEqual(['soon', 'late', 'new', 'old']);
  });
});

describe('copy and create PR copy', () => {
  it.each<[Workbench, string[]]>([
    [session(), ['copy_link', 'copy_branch', 'copy_id']],
    [session({ branch: '' }), ['copy_link', 'copy_id']],
    [thread(), ['copy_link', 'copy_id']],
    [session({ pr: PR }), ['copy_link', 'copy_pr_link', 'copy_pr_markdown', 'copy_branch', 'copy_id']],
    [session({ pr: { ...PR, state: 'merged' } }), ['copy_link', 'copy_pr_link', 'copy_pr_markdown', 'copy_branch', 'copy_id']],
    [session({ pr: { ...PR, url: 'javascript:alert(1)' } }), ['copy_link', 'copy_branch', 'copy_id']],
  ])('offers copy entries', (item, expected) => {
    expect(copyActions(item)).toEqual(expected);
  });
  it.each([
    ['copy_link', session(), { label: 'Copy link', text: expect.stringMatching(/\/s\/session-one$/), done: 'Link copied.' }],
    ['copy_branch', session(), { label: 'Copy branch name', text: 'tom/example', done: 'Branch name copied.' }],
    ['copy_id', session(), { label: 'Copy session ID', text: 'session-one', done: 'Session ID copied.' }],
    ['copy_id', thread(), { label: 'Copy thread ID', text: 'thread-one', done: 'Thread ID copied.' }],
    ['copy_pr_link', session({ pr: PR }), { label: 'Copy pull request link', text: PR.url, done: 'Pull request link copied.' }],
    ['copy_pr_markdown', session({ pr: PR }),
      { label: 'Copy pull request as Markdown link', text: `[PR #42](${PR.url})`, done: 'Markdown link copied.' }],
  ] as const)('%s', (kind, item, expected) => {
    expect(copyEntry(kind, item)).toEqual(expected);
  });
  it.each([
    ['Fix the bug', `[Fix the bug](${PR.url})`],
    ['  ', `[PR #42](${PR.url})`],
    [undefined, `[PR #42](${PR.url})`],
  ])('names the Markdown PR link with the title %j', (title, expected) => {
    expect(copyEntry('copy_pr_markdown', session({ pr: PR }), title).text).toBe(expected);
  });
  it.each<[boolean, Partial<Workbench>, string]>([
    [false, {}, 'Sent to the agent. It opens the pull request when its turn ends.'],
    [true, {}, 'Queued. It runs when the current turn ends.'],
    [true, { status: 'provisioning' }, 'Queued. It runs when the sandbox is ready.'],
  ])('confirms a Create PR send (queued %s)', (queued, patch, expected) => {
    expect(createPrSentText(queued, session(patch))).toBe(expected);
  });
});

describe('history', () => {
  const archived = (id: string, patch: Partial<Workbench> = {}) => session({ id, archivedAt: '2026-11-09T10:00:00Z', ...patch });
  const all = [
    session({ id: 'live' }),
    archived('a', { title: 'Fix login', repoFullName: 'acme/web', archivedAt: '2026-11-08T10:00:00Z' }),
    archived('b', { title: 'Add search', repoFullName: 'acme/api', branch: 'tom/search', archivedAt: '2026-11-09T10:00:00Z' }),
    archived('c', { title: 'Tidy', repoFullName: 'acme/web', archivedAt: '2026-11-07T10:00:00Z' }),
    archived('s', { status: 'archived', archivedAt: null, updatedAt: '2026-11-06T10:00:00Z', title: 'Old status' }),
    { ...thread(), id: 't', archivedAt: '2026-11-09T09:00:00Z' },
  ];
  it.each<[string, 'session' | 'thread', string, string[]]>([
    ['sessions, newest archived first', 'session', '', ['b', 'a', 'c', 's']],
    ['threads only', 'thread', '', ['t']],
    ['a title search', 'session', 'LOGIN', ['a']],
    ['a branch search', 'session', 'tom/search', ['b']],
    ['a repository search', 'session', 'acme/web', ['a', 'c']],
    ['a search with spaces around it', 'session', '  tidy ', ['c']],
    ['a search that matches nothing', 'session', 'zzz', []],
  ])('%s', (_name, kind, query, expected) => {
    expect(archivedItems(all, kind, query).map((item) => item.id)).toEqual(expected);
  });
  it('falls back to the last change for a row with no archive time', () => {
    expect(archivedAtOf({ archivedAt: null, updatedAt: '2026-11-06T10:00:00Z' })).toBe('2026-11-06T10:00:00Z');
  });
  it('groups sessions by repository in archive order', () => {
    const rows = historyRows(archivedItems(all, 'session', ''), 'session');
    expect(rows.map((row) => row.type === 'section' ? `# ${row.repo}` : `${row.item.id}${row.last ? '.' : ''}`))
      .toEqual(['# acme/api', 'b.', '# acme/web', 'a', 'c.', '# example/project', 's.']);
  });
  it('lists threads without sections', () => {
    expect(historyRows(archivedItems(all, 'thread', ''), 'thread').map((row) => row.type)).toEqual(['row']);
  });
  it.each<['session' | 'thread', number, string, { title: string; detail: string }]>([
    ['session', 0, '', { title: 'No archived sessions', detail: 'Archived sessions in this workspace show here.' }],
    ['thread', 0, 'x', { title: 'No archived threads', detail: 'Archived threads in this workspace show here.' }],
    ['session', 3, 'zzz', { title: 'No matches', detail: 'No archived sessions match your search.' }],
  ])('empty text for %s', (kind, total, query, expected) => {
    expect(emptyHistoryText(kind, total, query)).toEqual(expected);
  });
});
