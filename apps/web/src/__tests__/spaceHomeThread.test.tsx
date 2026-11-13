import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SpaceSessionRow, SpacesTeam, Workbench, Workspace } from '@talyn/shared';
import { SpaceHomePage } from '../components/spaces/SpaceHomePage';
import { useWorkspaceStore } from '../stores/workspace';
import { useSpacesStore } from '../stores/spaces';
import { useNavigationStore, type Route } from '../stores/navigation';
import { useWorkbenchStore } from '../stores/workbenches';

const { createSession, listSessions, updateChat } = vi.hoisted(() => ({
  createSession: vi.fn(),
  listSessions: vi.fn(),
  updateChat: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));
vi.mock('../lib/api', async () => ({
  ...(await vi.importActual('../lib/api')),
  api: { spaces: { createSession, sessions: listSessions }, workbenches: { updateChat } },
}));
vi.mock('../lib/readiness', async () => ({
  ...(await vi.importActual('../lib/readiness')),
  useReadiness: () => ({ sandbox: null, local: null, loading: false, refresh: async () => {} }),
}));

const TEAM: SpacesTeam = {
  id: 't1',
  name: 'Acme',
  role: 'member',
  homeWorkspaceId: 'ws1',
  createdAt: '',
  spaces: [{ id: 's1', teamId: 't1', name: 'Web', color: null, image: null, createdByUserId: null, archivedAt: null, createdAt: '', updatedAt: '' }],
};
const ACTIVE = { team: TEAM, space: TEAM.spaces[0] };
const CREATED = { id: 'new', workspaceId: 'ws1', spaceId: 's1', kind: 'thread', settings: {} } as unknown as Workbench;

beforeAll(() => {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  localStorage.clear();
  createSession.mockResolvedValue({ workbench: CREATED });
  listSessions.mockResolvedValue({ items: [], hiddenCount: 0 });
  useWorkspaceStore.setState({
    workspaces: [{ id: 'ws1', name: 'Mine', repos: [{ name: 'acme/web' }], settings: {} } as unknown as Workspace],
    currentWorkspaceId: 'ws1',
    currentContext: { kind: 'space', spaceId: 's1' },
    features: { spaces: true, workbenches: true } as never,
  });
  useWorkbenchStore.getState().setWorkspace('ws1');
  useSpacesStore.setState({
    teams: [TEAM],
    sessions: {},
    tasks: {},
    presence: {},
    selfUserId: 'me',
    repositories: { s1: [{ spaceId: 's1', repoFullName: 'acme/web', githubRepoId: 1, createdAt: '' }] },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const composer = () => screen.getByRole('textbox', { name: 'Task' }) as HTMLTextAreaElement;

describe('SpaceHomePage modes', () => {
  it.each<[string, Route, RegExp, Record<string, unknown>, boolean]>([
    ['thread', { view: 'home', mode: 'thread' }, /^Start a thread in Web\./, { kind: 'thread' }, false],
    ['session', { view: 'home' }, /^Start a session in Web\./, { repoFullName: 'acme/web' }, true],
  ])('a %s: placeholder and create body', async (_name, route, placeholder, body, hasRepo) => {
    act(() => useNavigationStore.getState().navigate(route));
    render(<SpaceHomePage active={ACTIVE} />);
    expect(composer().placeholder).toMatch(placeholder);
    fireEvent.change(composer(), { target: { value: 'plan the work' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    const [spaceId, sent] = createSession.mock.calls[0];
    expect(spaceId).toBe('s1');
    expect(sent).toMatchObject({ ...body, agent: expect.any(String), model: expect.any(String), prompt: 'plan the work' });
    expect('repoFullName' in sent).toBe(hasRepo);
    expect('kind' in sent).toBe(!hasRepo);
    await waitFor(() => expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'new' }));
    expect(listSessions).toHaveBeenCalledWith('s1');
  });

  it('switches between thread and session as the route changes', () => {
    act(() => useNavigationStore.getState().navigate({ view: 'home', mode: 'thread' }));
    render(<SpaceHomePage active={ACTIVE} />);
    expect(screen.getByText('Any repository')).toBeInTheDocument();
    expect(screen.queryByText(/Adds acme\/web to/)).toBeNull();
    act(() => useNavigationStore.getState().navigate({ view: 'home' }));
    expect(composer().placeholder).toMatch(/^Start a session in Web\./);
    expect(screen.getByText('acme/web')).toBeInTheDocument();
    act(() => useNavigationStore.getState().navigate({ view: 'home', mode: 'thread' }));
    expect(composer().placeholder).toMatch(/^Start a thread in Web\./);
  });
});

describe('SpaceHomePage composer, like the personal one', () => {
  const sessionCreated = (extra: Partial<Workbench> = {}) =>
    ({ id: 'new', workspaceId: 'ws1', spaceId: 's1', kind: 'session', settings: {}, chats: [{ id: 'chat-new' }], ...extra }) as unknown as Workbench;

  beforeEach(() => {
    act(() => useNavigationStore.getState().navigate({ view: 'home' }));
    updateChat.mockImplementation(async (id: string, patch: object) => ({ id, ...patch }));
  });

  it.each<[string, string]>([
    ['the image button', 'Attach images'],
    ['the repository picker', 'Repository'],
    ['the base branch', 'Base branch'],
    ['Create from', 'Create from'],
    ['the agent picker', 'Agent'],
    ['the effort picker', 'Reasoning effort'],
    ['Internet access', 'Internet access'],
  ])('shows %s', (_name, label) => {
    render(<SpaceHomePage active={ACTIVE} />);
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  });

  it('shows the plan toggle beside Send', () => {
    render(<SpaceHomePage active={ACTIVE} />);
    const plan = screen.getByRole('button', { name: 'Plan' });
    expect(plan.parentElement).toContainElement(screen.getByRole('button', { name: 'Create and start' }));
  });

  it.each<[string, Route, string[], string[]]>([
    ['a session', { view: 'home' }, ['Base branch', 'Create from'], []],
    ['a thread', { view: 'home', mode: 'thread' }, [], ['Base branch', 'Create from']],
  ])('in %s, shows only the branch controls that apply', (_name, route, shown, hidden) => {
    act(() => useNavigationStore.getState().navigate(route));
    render(<SpaceHomePage active={ACTIVE} />);
    for (const label of shown) expect(screen.getByLabelText(label)).toBeInTheDocument();
    for (const label of hidden) expect(screen.queryByLabelText(label)).toBeNull();
  });

  it('sends the base branch and the auto pull request setting', async () => {
    createSession.mockResolvedValue({ workbench: sessionCreated() });
    render(<SpaceHomePage active={ACTIVE} />);
    fireEvent.change(screen.getByLabelText('Base branch'), { target: { value: 'develop' } });
    fireEvent.change(composer(), { target: { value: 'fix it' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession.mock.calls[0][1]).toMatchObject({
      repoFullName: 'acme/web', baseBranch: 'develop', autoCreatePr: true, prompt: 'fix it',
    });
    expect('kind' in createSession.mock.calls[0][1]).toBe(false);
  });

  it.each<[string, boolean, number]>([
    ['puts plan mode on the first chat', true, 1],
    ['leaves the first chat alone without plan mode', false, 0],
  ])('%s', async (_name, plan, calls) => {
    createSession.mockResolvedValue({ workbench: sessionCreated() });
    render(<SpaceHomePage active={ACTIVE} />);
    if (plan) fireEvent.keyDown(composer(), { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Plan' })).toHaveAttribute('aria-pressed', String(plan));
    fireEvent.change(composer(), { target: { value: 'think first' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'new' }));
    expect(updateChat).toHaveBeenCalledTimes(calls);
    if (plan) expect(updateChat).toHaveBeenCalledWith('chat-new', expect.objectContaining({ planMode: true }));
  });

  it.each<[string, string, boolean]>([
    ['in the shown workspace', 'ws1', false],
    ['in another of my workspaces', 'ws2', true],
  ])('opens a new session %s', async (_name, workspaceId, extra) => {
    createSession.mockResolvedValue({ workbench: sessionCreated({ workspaceId }) });
    render(<SpaceHomePage active={ACTIVE} />);
    fireEvent.change(composer(), { target: { value: 'go' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'new' }));
    const store = useWorkbenchStore.getState();
    expect(store.workbenches.new?.workspaceId).toBe(workspaceId);
    expect(Boolean(store.extraWorkbenchIds.new)).toBe(extra);
    expect(composer().value).toBe('');
  });

  it('keeps the prompt and shows the error when the create fails', async () => {
    createSession.mockRejectedValue(new Error('No sandbox left'));
    render(<SpaceHomePage active={ACTIVE} />);
    fireEvent.change(composer(), { target: { value: 'keep me' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('No sandbox left');
    expect(composer().value).toBe('keep me');
  });
});

function feedRow(overrides: Partial<SpaceSessionRow>): SpaceSessionRow {
  return {
    id: 'r1',
    spaceId: 's1',
    workspaceId: 'ws-other',
    kind: 'session',
    threadId: null,
    name: 'fix-login',
    title: 'Fix the login',
    status: 'ready',
    sandboxState: 'running',
    running: false,
    repoFullName: 'acme/web',
    branch: 'fix-login',
    baseBranch: 'main',
    agent: 'claude',
    model: null,
    pullRequest: null,
    creator: { userId: 'u2', githubLogin: 'teammate', avatarUrl: null },
    lastActivityAt: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as SpaceSessionRow;
}

describe('SpaceHomePage session feed', () => {
  it.each<[string, Partial<SpaceSessionRow>, string]>([
    ['idle', {}, 'Idle'],
    ['running', { running: true }, 'Working'],
    ['starting', { status: 'provisioning', sandboxState: 'creating' }, 'Starting'],
    ['failed', { status: 'error' }, 'Failed to start'],
    ['open PR', { pullRequest: { number: 12, state: 'open', url: 'https://x/12' } }, '#12 open, waiting on checks or review'],
    ['merged PR', { pullRequest: { number: 13, state: 'merged', url: 'https://x/13' } }, 'Done: #13 merged'],
    ['closed PR', { pullRequest: { number: 14, state: 'closed', url: 'https://x/14' } }, '#14 closed'],
  ])('shows the %s state on the row', async (_name, overrides, label) => {
    const row = feedRow(overrides);
    listSessions.mockResolvedValue({ items: [row], hiddenCount: 0 });
    useSpacesStore.setState({ sessions: { s1: { items: [row], hiddenCount: 0, loaded: true, error: null } } });
    render(<SpaceHomePage active={ACTIVE} />);
    const state = await screen.findByText(label, { selector: '[data-attr="space-feed-session-state"] span' });
    expect(state.closest('[data-attr="space-feed-session"]')).toHaveTextContent('Fix the login');
    expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.queryByText(/· working/)).toBeNull();
  });
});
