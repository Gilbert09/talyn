import type { Workbench } from '@talyn/shared';
import {
  isThread,
  liveThreads,
  memoryUseLabel,
  prCiLabel,
  runningSessionCount,
  sessionMentionValue,
  threadCardTitle,
  threadChildren,
  threadMentions,
  threadRepositories,
  threadSummary,
  workbenchPlaceLabel,
} from '../renderer/lib/threads';
import { newestSessions } from '../renderer/lib/sessionOrder';
import { groupByRepository } from '../renderer/components/workbench/workbenchSelectors';
import { availableWorkbenchActions, primaryWorkbenchAction } from '../renderer/lib/workbenchActions';

function wb(id: string, over: Partial<Workbench> = {}): Workbench {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    name: id,
    branch: `b-${id}`,
    baseBranch: 'main',
    runtime: 'sandbox',
    agent: 'claude',
    deviceId: null,
    localPath: null,
    sandboxId: null,
    sandboxState: 'running',
    status: 'ready',
    pullRequestId: null,
    settings: {},
    diffStat: null,
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  } as Workbench;
}

const thread = (id: string, over: Partial<Workbench> = {}) =>
  wb(id, { kind: 'thread', repositoryId: null, repoFullName: '', branch: '', baseBranch: '', ...over });

describe('isThread', () => {
  it.each<[string, Partial<Workbench>, boolean]>([
    ['a thread', { kind: 'thread' }, true],
    ['a session', { kind: 'session' }, false],
    ['an older server with no kind', {}, false],
  ])('%s', (_name, over, expected) => {
    expect(isThread(wb('x', over))).toBe(expected);
  });
});

describe('liveThreads', () => {
  it('keeps live threads only, oldest first', () => {
    const all = [
      thread('t2', { createdAt: '2026-10-14T00:00:00Z' }),
      wb('s1'),
      thread('t1', { createdAt: '2026-10-12T00:00:00Z' }),
      thread('gone', { status: 'archived', archivedAt: '2026-10-13T00:00:00Z' }),
      thread('gone2', { archivedAt: '2026-10-13T00:00:00Z' }),
    ];
    expect(liveThreads(all).map((w) => w.id)).toEqual(['t1', 't2']);
  });

  it('answers an empty list for none', () => {
    expect(liveThreads([wb('s1')])).toEqual([]);
  });
});

describe('threadChildren', () => {
  const all = [
    thread('t1'),
    wb('a', { threadId: 't1', createdAt: '2026-10-15T00:00:00Z' }),
    wb('b', { threadId: 't1', createdAt: '2026-10-14T00:00:00Z' }),
    wb('old', { threadId: 't1', archivedAt: '2026-10-16T00:00:00Z' }),
    wb('other', { threadId: 't2' }),
    wb('free', { threadId: null }),
  ];

  it.each<[boolean, string[]]>([
    [false, ['b', 'a']],
    [true, ['old', 'b', 'a']],
  ])('with includeArchived %s', (includeArchived, ids) => {
    expect(threadChildren(all, 't1', { includeArchived }).map((w) => w.id)).toEqual(ids);
  });

  it('never lists a thread as a child', () => {
    expect(threadChildren([thread('t9', { threadId: 't1' })], 't1')).toEqual([]);
  });
});

describe('threadRepositories', () => {
  it.each<[string[], string[]]>([
    [[], []],
    [['acme/web', 'acme/api', 'acme/web'], ['acme/api', 'acme/web']],
    [['', 'acme/app'], ['acme/app']],
  ])('%j -> %j', (repos, expected) => {
    expect(threadRepositories(repos.map((repoFullName) => ({ repoFullName })))).toEqual(expected);
  });
});

describe('runningSessionCount and threadSummary', () => {
  it.each<[Record<string, Array<{ status: 'running' | 'idle' | 'error' | 'awaiting_input' }>>, number, string]>([
    [{}, 0, ''],
    [{ a: [{ status: 'idle' }] }, 0, ''],
    [{ a: [{ status: 'running' }], b: [{ status: 'idle' }, { status: 'running' }] }, 2, '2 running'],
    [{ a: [{ status: 'running' }, { status: 'running' }] }, 1, '1 running'],
    [{ a: [{ status: 'awaiting_input' }], b: [{ status: 'error' }] }, 0, ''],
  ])('%j', (chats, count, summary) => {
    const n = runningSessionCount([{ id: 'a' }, { id: 'b' }], chats);
    expect(n).toBe(count);
    expect(threadSummary(n)).toBe(summary);
  });
});

describe('workbenchPlaceLabel', () => {
  it.each<[Partial<Workbench>, string]>([
    [{ kind: 'thread', repoFullName: '' }, 'Thread'],
    [{ kind: 'session', repoFullName: 'acme/app' }, 'acme/app'],
    [{ repoFullName: 'acme/web' }, 'acme/web'],
  ])('%j', (over, label) => {
    expect(workbenchPlaceLabel(wb('x', over))).toBe(label);
  });
});

describe('threadCardTitle', () => {
  it.each<[Parameters<typeof threadCardTitle>[0], string]>([
    [{ action: 'session_started', status: 'idle' }, 'Session started'],
    [{ action: 'session_finished', status: 'idle' }, 'Session finished its turn'],
    [{ action: 'session_finished', status: 'error' }, 'Session stopped with an error'],
    [{ action: 'pr_opened', status: 'idle' }, 'Pull request opened'],
    [{ action: 'pr_merged', status: 'idle' }, 'Pull request merged'],
    [{ action: 'needs_input', status: 'awaiting_input' }, 'Session needs an answer'],
    [{ action: 'paused', status: '' }, 'Paused'],
  ])('%j', (event, title) => {
    expect(threadCardTitle(event)).toBe(title);
  });
});

describe('prCiLabel', () => {
  it.each<[string | undefined, string | null]>([
    ['passing', 'CI passing'],
    ['failing_required', 'CI failing'],
    ['failing_optional', 'CI failing'],
    ['running', 'CI running'],
    ['pending', 'CI running'],
    ['none', null],
    [undefined, null],
  ])('%s', (status, label) => {
    expect(prCiLabel(status)).toBe(label);
  });
});

describe('threadMentions', () => {
  const repos = [{ fullName: 'acme/web' }, { fullName: 'acme/api' }, { fullName: 'acme/api' }];
  const sessions = [
    { id: 's1', name: 'lisbon', title: 'Fix login', repoFullName: 'acme/web' },
    { id: 's2', name: 'oslo', title: null, repoFullName: 'acme/api' },
  ];

  it('offers sessions first, then repositories without repeats', () => {
    expect(threadMentions('', repos, sessions)).toEqual([
      { value: 'session:s1', label: 'Fix login · acme/web', kind: 'session' },
      { value: 'session:s2', label: 'oslo · acme/api', kind: 'session' },
      { value: 'acme/api', label: 'acme/api', kind: 'repository' },
      { value: 'acme/web', label: 'acme/web', kind: 'repository' },
    ]);
  });

  it.each<[string, string[]]>([
    ['api', ['session:s2', 'acme/api']],
    ['OSLO', ['session:s2']],
    ['acme/w', ['acme/web', 'session:s1']],
    ['session:s1', ['session:s1']],
    ['nothing', []],
  ])('query %s', (query, values) => {
    expect(threadMentions(query, repos, sessions).map((m) => m.value)).toEqual(values);
  });

  it('caps the list at 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ fullName: `acme/r${String(i).padStart(2, '0')}` }));
    expect(threadMentions('', many, [])).toHaveLength(20);
  });

  it('inserts a session as session:<id>', () => {
    expect(sessionMentionValue('abc')).toBe('session:abc');
  });
});

describe('groupByRepository', () => {
  it('leaves threads out, and keeps a thread session under its repository', () => {
    const groups = groupByRepository([
      thread('t1'),
      wb('a', { repoFullName: 'acme/web', threadId: 't1' }),
      wb('b', { repoFullName: 'acme/api' }),
    ]);
    expect(groups.map((g) => [g.repo, g.items.map((w) => w.id)])).toEqual([
      ['acme/api', ['b']],
      ['acme/web', ['a']],
    ]);
  });
});

describe('session order', () => {
  it.each([
    ['newest created first', [wb('old', { createdAt: '2026-10-12' }), wb('new', { createdAt: '2026-10-14' })], ['new', 'old']],
    ['a later update does not move a session', [wb('new', { createdAt: '2026-10-14', updatedAt: '2026-10-14' }), wb('old', { createdAt: '2026-10-12', updatedAt: '2026-10-20' })], ['new', 'old']],
    ['ID tie', [wb('z'), wb('a')], ['a', 'z']],
  ])('%s', (_case, sessions, expected) => {
    expect(newestSessions(sessions).map((row) => row.id)).toEqual(expected);
  });

  it('orders groups by their newest session', () => {
    const groups = groupByRepository([
      wb('a', { repoFullName: 'acme/a', createdAt: '2026-10-11', updatedAt: '2026-10-20' }),
      wb('b', { repoFullName: 'acme/b', createdAt: '2026-10-14' }),
      wb('c', { repoFullName: 'acme/a', createdAt: '2026-10-13' }),
    ]);
    expect(groups.map((group) => [group.repo, group.items.map((row) => row.id)])).toEqual([
      ['acme/b', ['b']], ['acme/a', ['c', 'a']],
    ]);
  });
});

describe('header actions for a thread', () => {
  it.each<[Partial<Workbench>, ReturnType<typeof primaryWorkbenchAction>, string[]]>([
    [{ kind: 'thread', diffStat: { added: 1, removed: 0, files: 1 } }, null, ['archive']],
    [{ kind: 'thread', archivedAt: '2026-10-13T00:00:00Z' }, null, []],
    [{ kind: 'session', diffStat: { added: 1, removed: 0, files: 1 } }, 'create_pr', ['create_pr', 'archive']],
  ])('%j', (over, primary, available) => {
    expect(primaryWorkbenchAction(wb('x', over), null)).toBe(primary);
    expect(availableWorkbenchActions(wb('x', over), null)).toEqual(available);
  });
});

describe('memoryUseLabel', () => {
  const at = '2026-10-31T00:00:00Z';
  it.each([
    [undefined, null],
    [{ wrote: false, read: false, lastUsedAt: at }, null],
    [{ wrote: true, read: false, lastUsedAt: at }, 'Saved'],
    [{ wrote: false, read: true, lastUsedAt: at }, 'Read'],
    [{ wrote: true, read: true, lastUsedAt: at }, 'Saved · Read'],
  ])('%j is %j', (use, label) => {
    expect(memoryUseLabel(use)).toBe(label);
  });
});
