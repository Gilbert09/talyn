/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Features, SpaceSessionRow, SpacesTeam, Workbench, Workspace } from '@talyn/shared';
import { api } from '../renderer/lib/api';
import { CommandPalette } from '../renderer/components/CommandPalette';
import { buildAppShortcuts } from '../renderer/components/layout/appShortcuts';
import { clearShortcuts, formatKeys, registerShortcuts } from '../renderer/lib/shortcuts';
import { CONTEXT_JUMP_KEYS } from '../renderer/components/layout/appShortcuts';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { useNavigationStore } from '../renderer/stores/navigation';
import { useSpacesStore } from '../renderer/stores/spaces';
import { openExternal } from '../renderer/lib/openExternal';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/lib/api', () => ({
  api: {
    workbenches: { list: jest.fn(), restore: jest.fn() },
    workflows: { list: jest.fn(() => Promise.resolve([])) },
    loops: { list: jest.fn(() => Promise.resolve([])) },
    pullRequests: {},
  },
}));
jest.mock('../renderer/lib/openExternal', () => ({ openExternal: jest.fn() }));

function wb(id: string, over: Partial<Workbench> = {}): Workbench {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    name: id,
    branch: `feat/${id}`,
    baseBranch: 'main',
    runtime: 'sandbox',
    agent: 'claude',
    status: 'ready',
    pullRequestId: null,
    settings: {},
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  } as Workbench;
}

function workspace(id: string, name: string): Workspace {
  return { id, name, repos: [], integrations: {}, settings: {}, createdAt: '', updatedAt: '' } as unknown as Workspace;
}

const TEAMS: SpacesTeam[] = [
  {
    id: 't1',
    name: 'Platform',
    role: 'member',
    homeWorkspaceId: 'ws1',
    createdAt: '',
    spaces: [
      { id: 's1', teamId: 't1', name: 'Infra', color: null, createdByUserId: null, archivedAt: null, createdAt: '', updatedAt: '' },
    ],
  },
] as SpacesTeam[];

const SPACE_FEATURES = { workbenches: true, workflows: true, spaces: true } as Features;

/** The palette row whose text includes `text`. */
function row(text: string): HTMLElement {
  return screen.getByText(text).closest('[cmdk-item]') as HTMLElement;
}

function open(): void {
  useNavigationStore.setState({ paletteOpen: true });
  render(<CommandPalette />);
}

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = jest.fn();
});

let unregister: () => void = () => {};
const writeText = jest.fn();

beforeEach(() => {
  jest.mocked(api.workbenches.list).mockReset().mockResolvedValue([]);
  jest.mocked(openExternal).mockReset();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  useWorkspaceStore.setState({
    workspaces: [workspace('ws1', 'Acme'), workspace('ws2', 'Side project')],
    currentWorkspaceId: 'ws1',
    currentContext: { kind: 'personal', workspaceId: 'ws1' },
    features: { workbenches: true, workflows: true } as Features,
    createWorkspaceOpen: false,
    theme: 'light',
    sidebarOrder: 'active_first',
  });
  useSpacesStore.setState({ teams: null, sessions: {}, dialog: null, settingsTeamId: null });
  useWorkbenchStore.getState().setWorkspace('ws1');
  useWorkbenchStore.getState().setWorkbenches('ws1', [wb('oslo')]);
  useNavigationStore.setState({ addRepositoryOpen: false });
  useNavigationStore.getState().navigate({ view: 'home' });
  unregister = registerShortcuts(buildAppShortcuts());
});

afterEach(() => {
  cleanup();
  unregister();
  clearShortcuts();
});

describe('palette: workspaces and spaces', () => {
  it('lists every workspace and marks the current one', () => {
    open();
    expect(screen.getByText('Workspaces')).toBeInTheDocument();
    expect(within(row('Switch to Acme')).getByLabelText('Current')).toBeInTheDocument();
    expect(within(row('Switch to Side project')).queryByLabelText('Current')).not.toBeInTheDocument();
    expect(screen.getByText('Switch to Side project')).toBeInTheDocument();
    expect(screen.queryByText('Create team…')).not.toBeInTheDocument();
  });

  it('switches workspace without Spaces', () => {
    open();
    fireEvent.click(screen.getByText('Switch to Side project'));
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe('ws2');
    expect(useNavigationStore.getState().paletteOpen).toBe(false);
  });

  it('lists spaces, team actions and context keys with Spaces on', () => {
    useWorkspaceStore.setState({ features: SPACE_FEATURES });
    useSpacesStore.setState({ teams: TEAMS });
    open();
    expect(screen.getByText('Workspaces and spaces')).toBeInTheDocument();
    expect(screen.getByText('Switch to Infra')).toBeInTheDocument();
    expect(screen.getByText(formatKeys(CONTEXT_JUMP_KEYS(1)))).toBeInTheDocument();
    expect(screen.getByText(formatKeys(CONTEXT_JUMP_KEYS(3)))).toBeInTheDocument();
    expect(screen.getByText('New space in Platform…')).toBeInTheDocument();
    expect(screen.getByText('Team settings: Platform')).toBeInTheDocument();
    expect(screen.getByText('Create team…')).toBeInTheDocument();
  });

  it('switches to a space and lands on its home', () => {
    useWorkspaceStore.setState({ features: SPACE_FEATURES });
    useSpacesStore.setState({ teams: TEAMS });
    act(() => useNavigationStore.getState().navigate({ view: 'insights' }));
    open();
    fireEvent.click(screen.getByText('Switch to Infra'));
    expect(useWorkspaceStore.getState().currentContext).toEqual({ kind: 'space', spaceId: 's1' });
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
  });

  it.each([
    ['New workspace…', () => expect(useWorkspaceStore.getState().createWorkspaceOpen).toBe(true)],
    ['Add repository', () => expect(useNavigationStore.getState().addRepositoryOpen).toBe(true)],
    ['New space in Platform…', () => expect(useSpacesStore.getState().dialog).toEqual({ kind: 'createSpace', teamId: 't1' })],
    ['Create team…', () => expect(useSpacesStore.getState().dialog).toEqual({ kind: 'createTeam' })],
    [
      'Team settings: Platform',
      () => {
        expect(useSpacesStore.getState().settingsTeamId).toBe('t1');
        expect(useNavigationStore.getState().route).toEqual({ view: 'settings', section: 'teams' });
      },
    ],
  ])('"%s" opens its dialog or page', (label, check) => {
    useWorkspaceStore.setState({ features: SPACE_FEATURES });
    useSpacesStore.setState({ teams: TEAMS });
    open();
    fireEvent.click(screen.getByText(label));
    check();
    expect(useNavigationStore.getState().paletteOpen).toBe(false);
  });

  it('in a space, adds a repository to the space and lists its sessions', async () => {
    useWorkspaceStore.setState({ features: SPACE_FEATURES, currentContext: { kind: 'space', spaceId: 's1' } });
    useSpacesStore.setState({
      teams: TEAMS,
      sessions: {
        s1: {
          items: [
            {
              id: 'oslo',
              name: 'oslo',
              title: 'Teammate fix',
              repoFullName: 'acme/infra',
              creator: { githubLogin: 'sam' },
            } as unknown as SpaceSessionRow,
          ],
          hiddenCount: 0,
          loaded: true,
          error: null,
        },
      },
    });
    open();
    expect(within(row('Switch to Infra')).getByLabelText('Current')).toBeInTheDocument();
    expect(within(row('Switch to Acme')).queryByLabelText('Current')).not.toBeInTheDocument();
    expect(screen.getByText('Infra sessions')).toBeInTheDocument();
    expect(screen.getByText('@sam')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Teammate fix'));
    await waitFor(() => expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'oslo' }));
  });

  it('in a space, "Add repository to Infra…" opens the space dialog', () => {
    useWorkspaceStore.setState({ features: SPACE_FEATURES, currentContext: { kind: 'space', spaceId: 's1' } });
    useSpacesStore.setState({ teams: TEAMS });
    open();
    expect(screen.queryByText('Add repository')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Add repository to Infra…'));
    expect(useSpacesStore.getState().dialog).toEqual({ kind: 'addRepository', spaceId: 's1' });
  });
});

describe('palette: this session', () => {
  it('is absent outside a session', () => {
    open();
    expect(screen.queryByText('Copy session ID')).not.toBeInTheDocument();
  });

  it.each([
    ['Copy branch name', 'feat/oslo'],
    ['Copy session ID', 'oslo'],
  ])('"%s" copies to the clipboard', async (label, text) => {
    act(() => useNavigationStore.getState().navigate({ view: 'workbench', id: 'oslo' }));
    open();
    expect(screen.getByText('This session: oslo')).toBeInTheDocument();
    fireEvent.click(screen.getByText(label));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
  });

  it('opens the pull request when there is one', () => {
    useWorkbenchStore.getState().setWorkbenches('ws1', [
      wb('oslo', { pr: { number: 3, url: 'https://github.com/acme/app/pull/3', state: 'open', mergeable: 'unknown', ciStatus: 'pending' } }),
    ]);
    act(() => useNavigationStore.getState().navigate({ view: 'workbench', id: 'oslo' }));
    open();
    fireEvent.click(screen.getByText('Open pull request on GitHub'));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/app/pull/3');
  });

  it('hides "Move to space…" for a local session', () => {
    useWorkspaceStore.setState({ features: { workbenches: true, spaces: true } as Features });
    useWorkbenchStore.getState().setWorkbenches('ws1', [wb('oslo', { runtime: 'local' })]);
    act(() => useNavigationStore.getState().navigate({ view: 'workbench', id: 'oslo' }));
    open();
    expect(screen.getByText('Copy session ID')).toBeInTheDocument();
    expect(screen.queryByText('Move to space…')).not.toBeInTheDocument();
  });

  it.each([
    [false, false],
    [true, true],
  ])('shows "Move to space…" only with Spaces on (spaces=%s)', (spaces, shown) => {
    useWorkspaceStore.setState({ features: { workbenches: true, spaces } as Features });
    act(() => useNavigationStore.getState().navigate({ view: 'workbench', id: 'oslo' }));
    open();
    if (!shown) {
      expect(screen.queryByText('Move to space…')).not.toBeInTheDocument();
      return;
    }
    fireEvent.click(screen.getByText('Move to space…'));
    expect(useSpacesStore.getState().dialog).toEqual({ kind: 'move', target: 'session', id: 'oslo', spaceId: null });
  });
});

describe('palette: preferences', () => {
  it.each([
    ['Theme: Dark', () => expect(useWorkspaceStore.getState().theme).toBe('dark')],
    ['Theme: System', () => expect(useWorkspaceStore.getState().theme).toBe('system')],
    ['Sidebar: Group by repository', () => expect(useWorkspaceStore.getState().sidebarOrder).toBe('repository')],
  ])('"%s" applies the preference', (label, check) => {
    open();
    fireEvent.click(screen.getByText(label));
    check();
  });

  it('hides the sidebar order and sign-out when they do not apply', () => {
    useWorkspaceStore.setState({ features: { workbenches: false } as Features });
    open();
    expect(screen.getByText('Theme: Light')).toBeInTheDocument();
    expect(screen.queryByText(/^Sidebar:/)).not.toBeInTheDocument();
    // No <AuthProvider>, so there is no signed-in user.
    expect(screen.queryByText('Sign out')).not.toBeInTheDocument();
  });
});
