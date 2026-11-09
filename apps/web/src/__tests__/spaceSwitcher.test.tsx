import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { SpacesTeam, Workspace } from '@talyn/shared';
import { WorkspaceSwitcher } from '../components/layout/WorkspaceSwitcher';
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
