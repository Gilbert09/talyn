import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SpaceSessionRow, SpacesTeam, Workspace } from '@talyn/shared';
import { WorkspaceSwitcher } from '../components/layout/WorkspaceSwitcher';
import { SpaceSidebar } from '../components/layout/SpaceSidebar';
import { useWorkspaceStore } from '../stores/workspace';
import { useSpacesStore } from '../stores/spaces';
import { useNavigationStore } from '../stores/navigation';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));

const TEAM: SpacesTeam = {
  id: 't1',
  name: 'Acme',
  role: 'admin',
  homeWorkspaceId: 'ws1',
  createdAt: '',
  spaces: [
    { id: 's1', teamId: 't1', name: 'Web', color: '#10b981', image: null, createdByUserId: null, archivedAt: null, createdAt: '', updatedAt: '' },
    { id: 's2', teamId: 't1', name: 'Infra', color: null, image: null, createdByUserId: null, archivedAt: null, createdAt: '', updatedAt: '' },
  ],
};

const row = (id: string, patch: Partial<SpaceSessionRow> = {}) =>
  ({
    id,
    spaceId: 's1',
    workspaceId: 'ws-ana',
    name: id,
    title: null,
    status: 'ready',
    running: false,
    repoFullName: 'acme/app',
    creator: { userId: 'ana', githubLogin: 'ana', avatarUrl: null },
    lastActivityAt: '2026-11-05T00:00:00Z',
    archivedAt: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-05T00:00:00Z',
    ...patch,
  }) as SpaceSessionRow;

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({
    workspaces: [{ id: 'ws1', name: 'Mine', repos: [] } as unknown as Workspace],
    currentWorkspaceId: 'ws1',
    currentContext: { kind: 'personal', workspaceId: 'ws1' },
    features: { spaces: true, workbenches: true } as never,
  });
  useSpacesStore.setState({ teams: [TEAM], sessions: {}, tasks: {}, presence: {}, selfUserId: 'me', dialog: null });
});

afterEach(cleanup);

describe('WorkspaceSwitcher', () => {
  it('lists Personal, then each team with its spaces and actions', () => {
    render(<WorkspaceSwitcher collapsed={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Mine/ }));
    expect(screen.getByText('Personal')).toBeInTheDocument();
    const team = screen.getByRole('group', { name: 'Acme' });
    expect(within(team).getByRole('button', { name: 'Web' })).toBeInTheDocument();
    expect(within(team).getByRole('button', { name: 'Infra' })).toBeInTheDocument();
    expect(within(team).getByRole('button', { name: /New space/ })).toBeInTheDocument();
    expect(within(team).getByRole('button', { name: /Team settings/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create team/ })).toBeInTheDocument();
  });

  it('switches to a space, and the button then names the space and its team', () => {
    render(<WorkspaceSwitcher collapsed={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Mine/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Web' }));
    expect(useWorkspaceStore.getState().currentContext).toEqual({ kind: 'space', spaceId: 's1' });
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
    const button = screen.getByRole('button', { name: /Web/ });
    expect(button).toHaveTextContent('Acme');
  });

  it('opens Team settings on that team', () => {
    render(<WorkspaceSwitcher collapsed={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Mine/ }));
    fireEvent.click(screen.getByRole('button', { name: /Team settings/ }));
    expect(useSpacesStore.getState().settingsTeamId).toBe('t1');
    expect(useWorkspaceStore.getState().settingsSection).toBe('teams');
  });

  it('opens the create dialogs', () => {
    render(<WorkspaceSwitcher collapsed={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Mine/ }));
    fireEvent.click(screen.getByRole('button', { name: /New space/ }));
    expect(useSpacesStore.getState().dialog).toEqual({ kind: 'createSpace', teamId: 't1' });
  });

  it('shows no team entries when Spaces is off', () => {
    useWorkspaceStore.setState({ features: { spaces: false } as never });
    render(<WorkspaceSwitcher collapsed={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Mine/ }));
    expect(screen.getByText('Workspaces')).toBeInTheDocument();
    expect(screen.queryByText('Acme')).toBeNull();
    expect(screen.queryByRole('button', { name: /Create team/ })).toBeNull();
  });
});

describe('SpaceSidebar', () => {
  const active = { team: TEAM, space: TEAM.spaces[0] };

  it('groups Active now before Recent, with who is here', () => {
    useSpacesStore.getState().setSessions('s1', {
      items: [row('quiet'), row('busy', { running: true }), row('watched')],
      hiddenCount: 2,
      loaded: true,
    });
    useSpacesStore.getState().setPresence('s1', [
      { userId: 'ben', githubLogin: 'ben', avatarUrl: null, sessionId: 'watched', state: 'active', at: 0 },
    ]);
    render(<SpaceSidebar active={active} />);
    const activeNow = screen.getByRole('group', { name: 'Active now' });
    expect(within(activeNow).getAllByText(/busy|watched/)).toHaveLength(2);
    expect(within(activeNow).getAllByTitle('ben is here').length).toBeGreaterThan(0);
    expect(within(screen.getByRole('group', { name: 'Recent' })).getByText('quiet')).toBeInTheDocument();
    expect(screen.getByText("2 items you can't see")).toBeInTheDocument();
  });

  it('says so when the space has no sessions', () => {
    useSpacesStore.getState().setSessions('s1', { items: [], loaded: true });
    render(<SpaceSidebar active={active} />);
    expect(screen.getByText('No sessions in this space yet.')).toBeInTheDocument();
  });
});
