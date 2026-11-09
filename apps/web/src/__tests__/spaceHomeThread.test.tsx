import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SpacesTeam, Workbench, Workspace } from '@talyn/shared';
import { SpaceHomePage } from '../components/spaces/SpaceHomePage';
import { useWorkspaceStore } from '../stores/workspace';
import { useSpacesStore } from '../stores/spaces';
import { useNavigationStore, type Route } from '../stores/navigation';
import { useWorkbenchStore } from '../stores/workbenches';

const { createSession, listSessions } = vi.hoisted(() => ({ createSession: vi.fn(), listSessions: vi.fn() }));

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));
vi.mock('../lib/api', async () => ({
  ...(await vi.importActual('../lib/api')),
  api: { spaces: { createSession, sessions: listSessions } },
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
const CREATED = { id: 'new', workspaceId: 'ws1', spaceId: 's1', kind: 'thread' } as Workbench;

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
