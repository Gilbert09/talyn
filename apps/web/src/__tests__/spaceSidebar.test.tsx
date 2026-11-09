import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SpacePresenceMember, SpaceSessionRow, SpacesTeam, Workbench, WorkbenchChat, Workspace } from '@talyn/shared';
import { SpaceSidebar } from '../components/layout/SpaceSidebar';
import { spaceSidebarModel, spaceSidebarSessionIds, type SpaceSidebarInput } from '../components/layout/spaceSidebarModel';
import { sessionGroupKey, spaceGroupKeyPrefix } from '../components/workbench/workbenchSelectors';
import { useWorkspaceStore } from '../stores/workspace';
import { useSpacesStore } from '../stores/spaces';
import { useWorkbenchStore } from '../stores/workbenches';
import { useNavigationStore } from '../stores/navigation';
import { usePullRequestStore } from '../stores/pullRequests';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));
vi.mock('../stores/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const TEAM: SpacesTeam = {
  id: 't1',
  name: 'Acme',
  role: 'admin',
  homeWorkspaceId: 'ws1',
  createdAt: '',
  spaces: [{ id: 's1', teamId: 't1', name: 'Web', color: '#10b981', image: null, createdByUserId: null, archivedAt: null, createdAt: '', updatedAt: '' }],
};
const ACTIVE = { team: TEAM, space: TEAM.spaces[0] };
const ANA = { userId: 'ana', githubLogin: 'ana', avatarUrl: null };
const ME = { userId: 'me', githubLogin: 'me', avatarUrl: null };

function row(id: string, patch: Partial<SpaceSessionRow> = {}): SpaceSessionRow {
  return {
    id,
    spaceId: 's1',
    workspaceId: 'ws-ana',
    kind: 'session',
    threadId: null,
    name: id,
    title: null,
    status: 'ready',
    sandboxState: 'running',
    running: false,
    repoFullName: 'acme/web',
    branch: `feat/${id}`,
    baseBranch: 'main',
    agent: 'claude',
    model: null,
    pullRequest: null,
    creator: ANA,
    lastActivityAt: null,
    archivedAt: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...patch,
  };
}

function wb(id: string, patch: Partial<Workbench> = {}): Workbench {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/web',
    name: id,
    branch: `feat/${id}`,
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
    spaceId: 's1',
    archivedAt: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...patch,
  } as Workbench;
}

const mine = (id: string, patch: Partial<SpaceSessionRow> = {}) => row(id, { workspaceId: 'ws1', creator: ME, ...patch });
const viewer = (sessionId: string, patch: Partial<SpacePresenceMember> = {}): SpacePresenceMember => ({
  userId: 'ben',
  githubLogin: 'ben',
  avatarUrl: null,
  sessionId,
  state: 'active',
  at: 0,
  ...patch,
});

function input(patch: Partial<SpaceSidebarInput>): SpaceSidebarInput {
  return {
    rows: [],
    presence: [],
    selfUserId: 'me',
    workbenches: {},
    workspaces: [{ id: 'ws1' } as Workspace],
    currentWorkspaceId: 'ws1',
    activeFirst: true,
    prRows: [],
    chats: {},
    unread: {},
    unseen: {},
    backgrounds: {},
    ...patch,
  };
}

const shape = (model: ReturnType<typeof spaceSidebarModel>) =>
  model.groups.map((g) => `${g.active ? 'Active' : g.repo}: ${g.items.map((i) => i.id).join(',')}`);

describe('spaceSidebarModel', () => {
  const rows = [
    row('busy', { repoFullName: 'acme/api', running: true, createdAt: '2026-11-01T00:00:00Z' }),
    row('watched', { createdAt: '2026-11-02T00:00:00Z' }),
    row('pr', { pullRequest: { number: 4, state: 'open', url: 'u' }, createdAt: '2026-11-03T00:00:00Z' }),
    row('done', { repoFullName: 'acme/api', pullRequest: { number: 5, state: 'merged', url: 'u' }, createdAt: '2026-11-04T00:00:00Z' }),
    row('quiet', { createdAt: '2026-11-05T00:00:00Z' }),
    row('old', { archivedAt: '2026-11-06T00:00:00Z', createdAt: '2026-11-06T00:00:00Z' }),
  ];

  it.each([
    [true, ['Active: pr,watched,busy', 'acme/web: quiet', 'acme/api: done']],
    [false, ['acme/web: quiet,pr,watched', 'acme/api: done,busy']],
  ])('groups like Personal with activeFirst=%s, archived left out', (activeFirst, expected) => {
    const model = spaceSidebarModel(input({ rows, presence: [viewer('watched')], activeFirst }));
    expect(shape(model)).toEqual(expected);
  });

  it.each<[string, Partial<SpacePresenceMember>, boolean]>([
    ['a teammate has it open', {}, true],
    ['I have it open', { userId: 'me' }, false],
    ['a teammate is away', { state: 'away' }, false],
    ['a teammate has another session open', { sessionId: 'other' }, false],
  ])('presence: %s → active %s', (_name, patch, active) => {
    const model = spaceSidebarModel(input({ rows: [row('a')], presence: [viewer('a', patch)] }));
    expect(model.groups[0].active === true).toBe(active);
  });

  it.each<[string, Partial<SpaceSidebarInput>, boolean, boolean]>([
    ['mine and loaded', { workbenches: { a: wb('a') } }, true, false],
    ['mine and loaded, with a running chat in the store', {
      workbenches: { a: wb('a') },
      chats: { a: [{ id: 'c', workbenchId: 'a', status: 'running' } as WorkbenchChat] },
    }, true, true],
    ['mine but not loaded', {}, false, false],
    ['loaded but in a workspace that is not mine', { workbenches: { a: wb('a') }, workspaces: [], currentWorkspaceId: 'other' }, false, false],
  ])('%s: full row %s, active %s', (_name, patch, owned, active) => {
    const model = spaceSidebarModel(input({ rows: [mine('a')], ...patch }));
    expect(model.owned.has('a')).toBe(owned);
    expect(model.groups[0].active === true).toBe(active);
  });

  it('leaves out a loaded session that the store has archived', () => {
    const model = spaceSidebarModel(input({ rows: [mine('a')], workbenches: { a: wb('a', { archivedAt: '2026-11-02T00:00:00Z' }) } }));
    expect(model.groups).toEqual([]);
  });

  it('lists my live threads with their sessions, and keeps the sessions in the groups too', () => {
    const model = spaceSidebarModel(
      input({
        rows: [
          mine('t-old', { kind: 'thread', repoFullName: '', createdAt: '2026-11-01T00:00:00Z' }),
          mine('t-new', { kind: 'thread', repoFullName: '', createdAt: '2026-11-03T00:00:00Z' }),
          mine('t-gone', { kind: 'thread', repoFullName: '', archivedAt: '2026-11-04T00:00:00Z' }),
          mine('c1', { threadId: 't-new', createdAt: '2026-11-04T00:00:00Z' }),
          mine('c2', { threadId: 't-new', createdAt: '2026-11-05T00:00:00Z' }),
          mine('c3', { threadId: 't-new', archivedAt: '2026-11-06T00:00:00Z' }),
          row('solo'),
        ],
        workbenches: { 't-new': wb('t-new', { kind: 'thread' }) },
      }),
    );
    expect(model.threads.map((t) => [t.thread.id, t.children.map((c) => c.id)])).toEqual([
      ['t-new', ['c2', 'c1']],
      ['t-old', []],
    ]);
    expect(model.threads[0].thread.workbench?.id).toBe('t-new');
    expect(model.threads[1].thread.workbench).toBeNull();
    expect(shape(model)).toEqual(['acme/web: c2,c1,solo']);
  });
});

describe('collapsed space groups', () => {
  const model = spaceSidebarModel(input({ rows: [row('a'), row('b', { repoFullName: 'acme/api', running: true })] }));

  it.each<[string, Record<string, true>, string | null, string[]]>([
    ['nothing collapsed', {}, null, ['b', 'a']],
    ["the space's repository group", { 'space:s1:acme/web': true }, null, ['b']],
    ["the space's active group", { 'space:s1:active': true }, null, ['a']],
    ['the same group in Personal', { 'acme/web': true, active: true }, null, ['b', 'a']],
    ['another space', { 'space:s2:acme/web': true }, null, ['b', 'a']],
    ['a collapsed group that holds the open session', { 'space:s1:acme/web': true }, 'a', ['b', 'a']],
  ])('%s', (_name, collapsed, openId, ids) => {
    expect(spaceSidebarSessionIds(model, 's1', collapsed, openId)).toEqual(ids);
  });

  it.each([
    [{ repo: 'Active', active: true }, '', 'active'],
    [{ repo: 'acme/web' }, '', 'acme/web'],
    [{ repo: 'Active', active: true }, spaceGroupKeyPrefix('s1'), 'space:s1:active'],
    [{ repo: 'acme/web' }, spaceGroupKeyPrefix('s1'), 'space:s1:acme/web'],
  ])('sessionGroupKey(%o, %s) = %s', (group, prefix, key) => {
    expect(sessionGroupKey(group, prefix)).toBe(key);
  });
});

describe('SpaceSidebar', () => {
  beforeAll(() => {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    (globalThis as { DOMRect: unknown }).DOMRect = class {
      constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
      static fromRect(rect: { x?: number; y?: number; width?: number; height?: number } = {}) {
        return new (globalThis.DOMRect as new (...args: (number | undefined)[]) => DOMRect)(rect.x, rect.y, rect.width, rect.height);
      }
      get left() { return this.x; }
      get top() { return this.y; }
      get right() { return this.x + this.width; }
      get bottom() { return this.y + this.height; }
    };
  });

  beforeEach(() => {
    localStorage.clear();
    useWorkspaceStore.setState({
      workspaces: [{ id: 'ws1', name: 'Mine', repos: [] } as unknown as Workspace],
      currentWorkspaceId: 'ws1',
      currentContext: { kind: 'space', spaceId: 's1' },
      features: { spaces: true, workbenches: true } as never,
      sidebarOrder: 'active_first',
      collapsedSessionGroups: {},
    });
    useWorkbenchStore.setState({ chats: {}, unread: {}, unseen: {} });
    useWorkbenchStore.getState().setWorkspace('ws1');
    useWorkbenchStore.getState().setWorkbenches('ws1', []);
    usePullRequestStore.setState({ rows: [] });
    useSpacesStore.setState({ teams: [TEAM], sessions: {}, tasks: {}, presence: {}, selfUserId: 'me', dialog: null });
    useNavigationStore.getState().navigate({ view: 'home' });
  });

  afterEach(cleanup);

  const setRows = (items: SpaceSessionRow[], hiddenCount = 0) =>
    useSpacesStore.getState().setSessions('s1', { items, hiddenCount, loaded: true, error: null });

  it('puts working and watched sessions in Active, then repository groups, with who is here', () => {
    setRows([row('quiet'), row('busy', { running: true }), row('watched')], 2);
    useSpacesStore.getState().setPresence('s1', [viewer('watched')]);
    render(<SpaceSidebar active={ACTIVE} />);
    const active = screen.getByRole('group', { name: 'Active' });
    expect(within(active).getAllByText(/busy|watched/)).toHaveLength(2);
    expect(within(active).getByLabelText('Working')).toBeInTheDocument();
    expect(within(active).getAllByTitle('ben is here').length).toBeGreaterThan(0);
    const repo = screen.getByRole('group', { name: 'acme/web' });
    expect(within(repo).getByText('quiet')).toBeInTheDocument();
    expect(within(repo).getByTitle('ana')).toBeInTheDocument();
    expect(screen.getByText("2 items you can't see")).toBeInTheDocument();
  });

  it('groups by repository only when the order says so', () => {
    useWorkspaceStore.setState({ sidebarOrder: 'repository' });
    setRows([row('busy', { running: true }), row('api', { repoFullName: 'acme/api' })]);
    render(<SpaceSidebar active={ACTIVE} />);
    expect(screen.queryByRole('group', { name: 'Active' })).toBeNull();
    expect(screen.getByRole('group', { name: 'acme/web' })).toHaveTextContent('busy');
    expect(screen.getByRole('group', { name: 'acme/api' })).toHaveTextContent('api');
  });

  it.each([
    ['my loaded session', mine('a'), true, 'sidebar-workbench-row'],
    ["a teammate's session", row('a'), false, 'space-session-row'],
    ['my session that is not loaded here', mine('a'), false, 'space-session-row'],
  ])('%s gets the %s row', (_name, item, loaded, attr) => {
    if (loaded) useWorkbenchStore.getState().setWorkbenches('ws1', [wb('a', { diffStat: { files: 1, added: 12, removed: 3 } } as Partial<Workbench>)]);
    setRows([item]);
    const { container } = render(<SpaceSidebar active={ACTIVE} />);
    const el = container.querySelector(`[data-attr="${attr}"]`);
    expect(el).not.toBeNull();
    expect(within(el as HTMLElement).getByTitle(item.creator.githubLogin!)).toBeInTheDocument();
    if (loaded) expect(el).toHaveTextContent('+12');
  });

  it('offers the full Personal menu on my loaded session', async () => {
    useWorkbenchStore.getState().setWorkbenches('ws1', [wb('a', { pr: { number: 3, state: 'open', url: 'https://x/3' } } as Partial<Workbench>)]);
    setRows([mine('a')]);
    render(<SpaceSidebar active={ACTIVE} />);
    fireEvent.contextMenu(screen.getByText('a'));
    for (const name of ['Open', 'Rename', 'Copy branch name', 'Copy session ID', 'Open pull request', 'Move to space…', 'Move to Personal', 'Archive…']) {
      expect(await screen.findByRole('menuitem', { name })).toBeInTheDocument();
    }
  });

  it('saves a collapsed group under the space', () => {
    setRows([row('a')]);
    render(<SpaceSidebar active={ACTIVE} />);
    fireEvent.click(screen.getByTitle('Hide the sessions of acme/web'));
    expect(useWorkspaceStore.getState().collapsedSessionGroups).toEqual({ 'space:s1:acme/web': true });
    expect(screen.queryByText('a')).toBeNull();
    expect(screen.getByTitle('Show the sessions of acme/web')).toHaveTextContent('1');
  });

  it('shows my threads with their sessions, and a New thread button', () => {
    useWorkbenchStore.getState().setWorkbenches('ws1', [wb('plan', { kind: 'thread', repoFullName: '', name: 'plan' })]);
    setRows([
      mine('plan', { kind: 'thread', repoFullName: '' }),
      mine('child', { threadId: 'plan', branch: 'feat/child' }),
    ]);
    render(<SpaceSidebar active={ACTIVE} />);
    const threads = screen.getByRole('group', { name: 'Threads' });
    expect(threads.querySelector('[data-attr="sidebar-thread-row"]')).toHaveTextContent('plan');
    const children = within(threads).getByRole('group', { name: 'Sessions of plan' });
    expect(within(children).getByText('feat/child')).toBeInTheDocument();
    expect(within(threads).getByRole('button', { name: 'New thread' })).toBeInTheDocument();
    fireEvent.click(within(threads).getByRole('button', { name: 'New thread' }));
    expect(useNavigationStore.getState().route).toEqual({ view: 'home', mode: 'thread' });
  });

  it('offers Move to space and Move to Personal on a thread', async () => {
    setRows([mine('plan', { kind: 'thread', repoFullName: '' })]);
    render(<SpaceSidebar active={ACTIVE} />);
    fireEvent.contextMenu(screen.getByText('plan'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to space…' }));
    expect(useSpacesStore.getState().dialog).toEqual({ kind: 'move', target: 'session', id: 'plan', spaceId: 's1' });
  });

  it('says so when the space has no sessions', () => {
    setRows([]);
    render(<SpaceSidebar active={ACTIVE} />);
    expect(screen.getByText('No sessions in this space yet.')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Threads' })).toBeInTheDocument();
  });
});
