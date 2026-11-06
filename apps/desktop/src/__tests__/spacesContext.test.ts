import type { SpacePresenceMember, SpaceSessionRow, SpaceTaskRow, SpacesTeam, Workbench, Workspace } from '@talyn/shared';

jest.mock('../renderer/lib/api', () => {
  class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) {
      super(message);
    }
  }
  return { ApiError, api: { workbenches: { get: jest.fn() } }, wsClient: { on: jest.fn(() => () => {}) } };
});

import { ApiError } from '../renderer/lib/api';
import { CONTEXT_PREF_KEY, readStoredContext, useWorkspaceStore, type AppContext } from '../renderer/stores/workspace';
import { useSpacesStore } from '../renderer/stores/spaces';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { useNavigationStore } from '../renderer/stores/navigation';
import {
  activeSpace,
  contextEntries,
  contextsEqual,
  groupSpaceSessions,
  isWorkbenchOwner,
  presenceSentence,
  promptRefusal,
  switchContext,
  viewersOf,
} from '../renderer/lib/spaces';

const WS_KEY = 'fastowl-current-workspace';

const team = (id: string, spaces: string[]): SpacesTeam => ({
  id,
  name: `Team ${id}`,
  role: 'member',
  homeWorkspaceId: 'ws1',
  createdAt: '2026-11-01T00:00:00Z',
  spaces: spaces.map((s) => ({
    id: s,
    teamId: id,
    name: `Space ${s}`,
    color: '#6366f1',
    createdByUserId: null,
    archivedAt: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  })),
});

const workspace = (id: string) => ({ id, name: id, repos: [] }) as unknown as Workspace;

function row(id: string, patch: Partial<SpaceSessionRow> = {}): SpaceSessionRow {
  return {
    id,
    spaceId: 's1',
    workspaceId: 'ws-ana',
    name: id,
    title: null,
    status: 'ready',
    sandboxState: 'running',
    running: false,
    repoFullName: 'acme/app',
    branch: id,
    baseBranch: 'main',
    agent: 'claude',
    model: null,
    pullRequest: null,
    creator: { userId: 'ana', githubLogin: 'ana', avatarUrl: null },
    lastActivityAt: '2026-11-05T00:00:00Z',
    archivedAt: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-05T00:00:00Z',
    ...patch,
  };
}

function wb(id: string, patch: Partial<Workbench> = {}): Workbench {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    name: id,
    branch: id,
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
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...patch,
  };
}

const presence = (userId: string, sessionId: string | null, state: 'active' | 'away' = 'active'): SpacePresenceMember => ({
  userId,
  githubLogin: userId,
  avatarUrl: null,
  sessionId,
  state,
  at: 0,
});

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1',
    currentContext: { kind: 'personal', workspaceId: 'ws1' },
    workspaces: [workspace('ws1'), workspace('ws2')],
    features: { spaces: true } as never,
  });
  useSpacesStore.setState({ teams: [team('t1', ['s1', 's2']), team('t2', ['s3'])], sessions: {}, tasks: {}, presence: {}, selfUserId: 'me' });
  useWorkbenchStore.setState({ workspaceId: 'ws1', workbenches: {}, extraWorkbenchIds: {} });
});

describe('readStoredContext', () => {
  it.each<[string, string | null, string | null, AppContext]>([
    ['nothing stored', null, null, { kind: 'personal', workspaceId: null }],
    ['a workspace only', 'ws2', null, { kind: 'personal', workspaceId: 'ws2' }],
    ['a space', 'ws2', JSON.stringify({ kind: 'space', spaceId: 's1' }), { kind: 'space', spaceId: 's1' }],
    ['broken JSON', 'ws2', '{nope', { kind: 'personal', workspaceId: 'ws2' }],
    ['a space with no id', 'ws2', JSON.stringify({ kind: 'space', spaceId: '' }), { kind: 'personal', workspaceId: 'ws2' }],
    ['an unknown kind', null, JSON.stringify({ kind: 'team', spaceId: 's1' }), { kind: 'personal', workspaceId: null }],
  ])('%s', (_name, workspaceId, context, expected) => {
    if (workspaceId) localStorage.setItem(WS_KEY, workspaceId);
    if (context) localStorage.setItem(CONTEXT_PREF_KEY, context);
    expect(readStoredContext()).toEqual(expected);
  });
});

describe('setContext', () => {
  it('enters a space, keeps the Personal workspace and persists the space', () => {
    useWorkspaceStore.getState().setContext({ kind: 'space', spaceId: 's1' });
    const state = useWorkspaceStore.getState();
    expect(state.currentContext).toEqual({ kind: 'space', spaceId: 's1' });
    expect(state.currentWorkspaceId).toBe('ws1');
    expect(JSON.parse(localStorage.getItem(CONTEXT_PREF_KEY)!)).toEqual({ kind: 'space', spaceId: 's1' });
    expect(readStoredContext()).toEqual({ kind: 'space', spaceId: 's1' });
  });

  it('goes back to Personal on a workspace and clears the stored space', () => {
    useWorkspaceStore.getState().setContext({ kind: 'space', spaceId: 's1' });
    useWorkspaceStore.getState().setContext({ kind: 'personal', workspaceId: 'ws2' });
    const state = useWorkspaceStore.getState();
    expect(state.currentContext).toEqual({ kind: 'personal', workspaceId: 'ws2' });
    expect(state.currentWorkspaceId).toBe('ws2');
    expect(localStorage.getItem(CONTEXT_PREF_KEY)).toBeNull();
    expect(localStorage.getItem(WS_KEY)).toBe('ws2');
  });

  it('Personal with no workspace keeps the current one', () => {
    useWorkspaceStore.getState().setContext({ kind: 'space', spaceId: 's1' });
    useWorkspaceStore.getState().setContext({ kind: 'personal', workspaceId: null });
    expect(useWorkspaceStore.getState().currentContext).toEqual({ kind: 'personal', workspaceId: 'ws1' });
  });

  it('setCurrentWorkspace leaves a space for Personal', () => {
    useWorkspaceStore.getState().setContext({ kind: 'space', spaceId: 's1' });
    useWorkspaceStore.getState().setCurrentWorkspace('ws2');
    expect(useWorkspaceStore.getState().currentContext).toEqual({ kind: 'personal', workspaceId: 'ws2' });
    expect(localStorage.getItem(CONTEXT_PREF_KEY)).toBeNull();
  });
});

describe('activeSpace', () => {
  it.each<[string, AppContext, boolean, string | null]>([
    ['a known space', { kind: 'space', spaceId: 's3' }, true, 's3'],
    ['Personal', { kind: 'personal', workspaceId: 'ws1' }, true, null],
    ['a space that is gone', { kind: 'space', spaceId: 'gone' }, true, null],
    ['the flag is off', { kind: 'space', spaceId: 's1' }, false, null],
  ])('%s', (_name, context, offered, expected) => {
    useWorkspaceStore.setState({ currentContext: context, features: { spaces: offered } as never });
    expect(activeSpace()?.space.id ?? null).toBe(expected);
  });
});

describe('switchContext', () => {
  it('switches and lands on the home of the context', () => {
    useNavigationStore.getState().navigate({ view: 'prs', tab: 'my_prs' });
    switchContext({ kind: 'space', spaceId: 's2' });
    expect(useWorkspaceStore.getState().currentContext).toEqual({ kind: 'space', spaceId: 's2' });
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
  });

  it('does nothing for the context the app is already in', () => {
    useNavigationStore.getState().navigate({ view: 'prs', tab: 'my_prs' });
    switchContext({ kind: 'personal', workspaceId: 'ws1' });
    expect(useNavigationStore.getState().route).toEqual({ view: 'prs', tab: 'my_prs' });
  });
});

describe('contextEntries', () => {
  it('lists my workspaces, then every team space in order', () => {
    const { workspaces } = useWorkspaceStore.getState();
    expect(contextEntries(workspaces, useSpacesStore.getState().teams)).toEqual([
      { kind: 'personal', workspaceId: 'ws1' },
      { kind: 'personal', workspaceId: 'ws2' },
      { kind: 'space', spaceId: 's1' },
      { kind: 'space', spaceId: 's2' },
      { kind: 'space', spaceId: 's3' },
    ]);
  });

  it('is only the workspaces before the teams load', () => {
    expect(contextEntries([workspace('ws1')], null)).toEqual([{ kind: 'personal', workspaceId: 'ws1' }]);
  });

  it.each<[AppContext, AppContext, boolean]>([
    [{ kind: 'space', spaceId: 'a' }, { kind: 'space', spaceId: 'a' }, true],
    [{ kind: 'space', spaceId: 'a' }, { kind: 'space', spaceId: 'b' }, false],
    [{ kind: 'personal', workspaceId: 'a' }, { kind: 'personal', workspaceId: 'a' }, true],
    [{ kind: 'personal', workspaceId: 'a' }, { kind: 'space', spaceId: 'a' }, false],
  ])('contextsEqual(%j, %j) is %s', (a, b, expected) => {
    expect(contextsEqual(a, b)).toBe(expected);
  });
});

describe('isWorkbenchOwner', () => {
  it.each<[string, string, string | null, boolean]>([
    ['the current workspace', 'ws1', 'ws1', true],
    ['another of my workspaces', 'ws2', 'ws1', true],
    ["a teammate's workspace", 'ws-ana', 'ws1', false],
  ])('%s', (_name, workspaceId, current, expected) => {
    expect(isWorkbenchOwner({ workspaceId }, [workspace('ws1'), workspace('ws2')], current)).toBe(expected);
  });
});

describe('workbench store extras', () => {
  it('holds a teammate session, takes its updates, and keeps it across a re-list', () => {
    const store = useWorkbenchStore.getState();
    store.upsertWorkbench(wb('theirs', { workspaceId: 'ws-ana' }));
    expect(useWorkbenchStore.getState().workbenches.theirs).toBeUndefined();

    store.addExtraWorkbench(wb('theirs', { workspaceId: 'ws-ana' }));
    store.upsertWorkbench(wb('theirs', { workspaceId: 'ws-ana', title: 'Renamed' }));
    expect(useWorkbenchStore.getState().workbenches.theirs.title).toBe('Renamed');

    store.setWorkbenches('ws1', [wb('mine')]);
    expect(Object.keys(useWorkbenchStore.getState().workbenches).sort()).toEqual(['mine', 'theirs']);

    store.removeWorkbench('theirs');
    expect(useWorkbenchStore.getState().extraWorkbenchIds).toEqual({});
  });

  it('adding my own session of the current workspace is not an extra', () => {
    useWorkbenchStore.getState().addExtraWorkbench(wb('mine'));
    expect(useWorkbenchStore.getState().extraWorkbenchIds).toEqual({});
    expect(useWorkbenchStore.getState().workbenches.mine).toBeDefined();
  });

  it('switching workspace drops the extras', () => {
    useWorkbenchStore.getState().addExtraWorkbench(wb('theirs', { workspaceId: 'ws-ana' }));
    useWorkbenchStore.getState().setWorkspace('ws2');
    expect(useWorkbenchStore.getState().workbenches).toEqual({});
    expect(useWorkbenchStore.getState().extraWorkbenchIds).toEqual({});
  });
});

describe('spaces store live updates', () => {
  beforeEach(() => {
    useSpacesStore.getState().setSessions('s1', { items: [row('a'), row('b')], hiddenCount: 1, loaded: true });
    useSpacesStore.getState().setSessions('s2', { items: [], loaded: true });
  });

  it('patches a status change and a rename', () => {
    const missing = useSpacesStore.getState().applyWorkbench(
      wb('a', { spaceId: 's1', title: 'New title', status: 'provisioning', chats: [{ status: 'running' } as never] }),
    );
    expect(missing).toBe(false);
    const a = useSpacesStore.getState().sessions.s1.items.find((r) => r.id === 'a')!;
    expect(a).toMatchObject({ title: 'New title', status: 'provisioning', running: true });
  });

  it('marks an archive on the row', () => {
    useSpacesStore.getState().applyWorkbench(wb('b', { spaceId: 's1', archivedAt: '2026-11-06T00:00:00Z', status: 'archived' }));
    expect(useSpacesStore.getState().sessions.s1.items.find((r) => r.id === 'b')!.archivedAt).toBe('2026-11-06T00:00:00Z');
  });

  it('drops a session that left the space', () => {
    useSpacesStore.getState().applyWorkbench(wb('a', { spaceId: null }));
    expect(useSpacesStore.getState().sessions.s1.items.map((r) => r.id)).toEqual(['b']);
  });

  it.each<[string, Partial<Workbench>, boolean]>([
    ['a new session in a loaded space', { spaceId: 's2' }, true],
    ['a new archived session', { spaceId: 's2', archivedAt: '2026-11-06T00:00:00Z' }, false],
    ['a session in a space not loaded', { spaceId: 's9' }, false],
    ['a Personal session', { spaceId: null }, false],
  ])('asks for a re-list for %s: %s', (_name, patch, expected) => {
    expect(useSpacesStore.getState().applyWorkbench(wb('new', patch))).toBe(expected);
  });

  it('a chat turn sets running', () => {
    useSpacesStore.getState().applyChat({ workbenchId: 'b', status: 'running', updatedAt: '2026-11-06T01:00:00Z' } as never);
    expect(useSpacesStore.getState().sessions.s1.items.find((r) => r.id === 'b')).toMatchObject({ running: true, lastActivityAt: '2026-11-06T01:00:00Z' });
  });

  it('a delete removes the row', () => {
    useSpacesStore.getState().removeSession('a');
    expect(useSpacesStore.getState().sessions.s1.items.map((r) => r.id)).toEqual(['b']);
  });

  it('task status, move and delete', () => {
    const task = { id: 't1', spaceId: 's1', status: 'queued', title: 'Fix it' } as SpaceTaskRow;
    useSpacesStore.getState().setTasks('s1', { items: [task], loaded: true });
    useSpacesStore.getState().setTasks('s2', { items: [], loaded: true });
    useSpacesStore.getState().applyTaskStatus('t1', 'in_progress');
    expect(useSpacesStore.getState().tasks.s1.items[0].status).toBe('in_progress');
    expect(useSpacesStore.getState().applyTaskUpdate('t1', { spaceId: 's2' })).toBe(true);
    expect(useSpacesStore.getState().tasks.s1.items).toEqual([]);
    useSpacesStore.getState().setTasks('s2', { items: [task] });
    useSpacesStore.getState().removeTask('t1');
    expect(useSpacesStore.getState().tasks.s2.items).toEqual([]);
  });
});

describe('groupSpaceSessions', () => {
  it('puts viewed and running sessions in Active now, newest first, and leaves archived out', () => {
    const rows = [
      row('old', { lastActivityAt: '2026-11-01T00:00:00Z' }),
      row('viewed', { lastActivityAt: '2026-11-02T00:00:00Z' }),
      row('running', { running: true, lastActivityAt: '2026-11-03T00:00:00Z' }),
      row('new', { lastActivityAt: '2026-11-04T00:00:00Z' }),
      row('archived', { archivedAt: '2026-11-04T00:00:00Z' }),
      row('mine-open', { lastActivityAt: '2026-11-05T00:00:00Z' }),
      row('away', { lastActivityAt: '2026-11-00T00:00:00Z' }),
    ];
    const groups = groupSpaceSessions(
      rows,
      [presence('ben', 'viewed'), presence('me', 'mine-open'), presence('cy', 'away', 'away')],
      'me',
    );
    expect(groups.active.map((r) => r.id)).toEqual(['running', 'viewed']);
    expect(groups.recent.map((r) => r.id)).toEqual(['mine-open', 'new', 'old', 'away']);
  });
});

describe('presence', () => {
  it('lists the teammates on a session and leaves me and the away ones out', () => {
    const members = [presence('me', 'a'), presence('ana', 'a'), presence('ben', 'b'), presence('cy', 'a', 'away')];
    expect(viewersOf(members, 'a', 'me').map((m) => m.userId)).toEqual(['ana']);
  });

  it.each<[string[], string | null]>([
    [[], null],
    [['ana'], 'ana is here'],
    [['ana', 'ben'], 'ana and ben are here'],
    [['ana', 'ben', 'cy'], 'ana, ben and 1 other are here'],
    [['ana', 'ben', 'cy', 'dee'], 'ana, ben and 2 others are here'],
  ])('%j reads %s', (logins, expected) => {
    expect(presenceSentence(logins.map((githubLogin) => ({ githubLogin })))).toBe(expected);
  });
});

describe('promptRefusal', () => {
  it.each<[string, unknown, string | null]>([
    ['payer busy', new ApiError("Waiting for ana's turn to finish.", 409, 'payer_busy'), "Waiting for ana's turn to finish."],
    ['no agent account', new ApiError('Connect Claude or Codex to prompt this session.', 403, 'no_agent_account'), 'Connect Claude or Codex to prompt this session.'],
    ['no push access', new ApiError('You cannot push to acme/app.', 409, 'no_push_access'), 'You cannot push to acme/app.'],
    ['a server error', new ApiError('Boom', 500), null],
    ['a plain error', new Error('offline'), null],
  ])('%s', (_name, err, expected) => {
    expect(promptRefusal(err)).toBe(expected);
  });
});
