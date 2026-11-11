import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  MAX_SPLIT_PANES,
  addSplitPane,
  moveSplitPane,
  parseSplitPanes,
  removeSplitPane,
  splitGridShape,
  splitViewOffered,
  type Features,
  type Workbench,
} from '@talyn/shared';
import { SplitView } from '../components/workbench/SplitView';
import { useSplitViewStore } from '../stores/splitView';
import { useWorkbenchStore } from '../stores/workbenches';
import { useNavigationStore } from '../stores/navigation';
import { useWorkspaceStore } from '../stores/workspace';
import { pathForRoute, routeForPath } from '../lib/routes';
import { openInSplitView } from '../lib/splitView';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../components/auth/AuthProvider', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../lib/workbenchData', () => ({ loadWorkbench: vi.fn(), ensureChatHistory: vi.fn(), loadOlderEvents: vi.fn() }));
vi.mock('../lib/wakeWorkbench', () => ({ wakeWorkbench: vi.fn() }));
vi.mock('../hooks/useSessionBackground', () => ({ useWorkbenchBackgroundLoad: () => undefined }));
vi.mock('../components/widgets/PRDetailSheet', () => ({ PRDetailSheet: () => null }));
vi.mock('../components/workbench/Composer', () => ({
  Composer: ({ workbench, autoFocus }: { workbench: Workbench; autoFocus?: boolean }) => (
    <div data-testid={`composer-${workbench.id}`} data-autofocus={String(autoFocus)} />
  ),
}));

function wb(id: string, over: Partial<Workbench> = {}): Workbench {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    name: id,
    branch: `branch-${id}`,
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
    ...over,
  } as Workbench;
}

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  useWorkspaceStore.setState({ currentWorkspaceId: 'ws1', features: { workbenches: true, splitView: true } as Features });
  useWorkbenchStore.setState({ chats: {}, unread: {}, unseen: {}, prDetailId: null });
  useWorkbenchStore.getState().setWorkspace('ws1');
  useWorkbenchStore.getState().setWorkbenches('ws1', [wb('alpha'), wb('beta'), wb('gamma')]);
  useSplitViewStore.setState({ panes: [], focusedId: null });
  useNavigationStore.setState({ route: { view: 'home' }, backStack: [], forwardStack: [] });
});

afterEach(cleanup);

describe('split view pane rules', () => {
  it('is offered only with the flag and the session surface', () => {
    expect(splitViewOffered({ splitView: true, workbenches: true })).toBe(true);
    expect(splitViewOffered({ splitView: true, workbenches: false })).toBe(false);
    expect(splitViewOffered({ splitView: false, workbenches: true })).toBe(false);
    expect(splitViewOffered(null)).toBe(false);
  });

  it('keeps an open session in place and drops the oldest pane when full', () => {
    expect(addSplitPane(['a', 'b'], 'a')).toEqual(['a', 'b']);
    expect(addSplitPane(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    const full = ['a', 'b', 'c', 'd'].slice(0, MAX_SPLIT_PANES);
    expect(addSplitPane(full, 'e')).toEqual([...full.slice(1), 'e']);
    expect(removeSplitPane(['a', 'b'], 'a')).toEqual(['b']);
    expect(moveSplitPane(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveSplitPane(['a', 'b'], 'a', -1)).toEqual(['a', 'b']);
  });

  it('reads a saved list defensively', () => {
    expect(parseSplitPanes('nope')).toEqual([]);
    expect(parseSplitPanes(['a', 'a', '', 3, 'b'])).toEqual(['a', 'b']);
    expect(parseSplitPanes(['a', 'b', 'c', 'd', 'e', 'f'])).toHaveLength(MAX_SPLIT_PANES);
  });

  it('lays panes side by side up to three, then two by two', () => {
    expect(splitGridShape(1)).toEqual({ columns: 1, rows: 1 });
    expect(splitGridShape(3)).toEqual({ columns: 3, rows: 1 });
    expect(splitGridShape(4)).toEqual({ columns: 2, rows: 2 });
  });

  it('has a /split route', () => {
    expect(pathForRoute({ view: 'split' })).toBe('/split');
    expect(routeForPath('/split')).toEqual({ view: 'split' });
  });
});

describe('SplitView', () => {
  it('opening a session in split view adds a pane and shows the page', () => {
    openInSplitView('alpha', 'test');
    openInSplitView('beta', 'test');
    expect(useNavigationStore.getState().route).toEqual({ view: 'split' });
    expect(useSplitViewStore.getState()).toMatchObject({ panes: ['alpha', 'beta'], focusedId: 'beta' });
    // Split view never selects a workbench: that would navigate away from it.
    expect(useWorkbenchStore.getState().selectedWorkbenchId).toBeNull();
  });

  it('shows a transcript and a composer per pane, and only the focused one takes focus', () => {
    useSplitViewStore.setState({ panes: ['alpha', 'beta'], focusedId: 'beta' });
    render(<SplitView />);
    const panes = screen.getAllByRole('region');
    expect(panes).toHaveLength(2);
    expect(within(panes[0]).getByText('alpha')).toBeInTheDocument();
    expect(screen.getByTestId('composer-alpha')).toHaveAttribute('data-autofocus', 'false');
    expect(screen.getByTestId('composer-beta')).toHaveAttribute('data-autofocus', 'true');

    fireEvent.mouseDown(panes[0]);
    expect(useSplitViewStore.getState().focusedId).toBe('alpha');
    expect(screen.getByTestId('composer-alpha')).toHaveAttribute('data-autofocus', 'true');
    expect(screen.getByTestId('composer-beta')).toHaveAttribute('data-autofocus', 'false');
  });

  it('closes a pane, moves one, and opens the full session', () => {
    useSplitViewStore.setState({ panes: ['alpha', 'beta'], focusedId: 'alpha' });
    render(<SplitView />);
    fireEvent.click(screen.getByRole('button', { name: 'Move alpha right' }));
    expect(useSplitViewStore.getState().panes).toEqual(['beta', 'alpha']);

    fireEvent.click(screen.getByRole('button', { name: 'Close alpha in split view' }));
    expect(useSplitViewStore.getState()).toMatchObject({ panes: ['beta'], focusedId: 'beta' });

    fireEvent.click(screen.getByRole('button', { name: 'Open beta' }));
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'beta' });
  });

  it('closes the pane of a session that is archived', () => {
    useSplitViewStore.setState({ panes: ['alpha', 'beta'], focusedId: 'alpha' });
    render(<SplitView />);
    act(() => {
      useWorkbenchStore.getState().upsertWorkbench(wb('alpha', { status: 'archived', archivedAt: '2026-11-02T00:00:00Z' }));
    });
    expect(useSplitViewStore.getState()).toMatchObject({ panes: ['beta'], focusedId: 'beta' });
  });

  it('offers a way in when no session is open', () => {
    render(<SplitView />);
    expect(screen.getByText('Work on several sessions at once')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Add session/ }).length).toBeGreaterThan(0);
  });
});

describe('split view entry points', () => {
  it('the sidebar offers split view only behind the flag', async () => {
    const { AppSidebar } = await import('../components/layout/AppSidebar');
    const { unmount } = render(<AppSidebar />);
    expect(screen.getByRole('button', { name: /Split view/ })).toBeInTheDocument();
    unmount();
    useWorkspaceStore.setState({ features: { workbenches: true, splitView: false } as Features });
    render(<AppSidebar />);
    expect(screen.queryByRole('button', { name: /Split view/ })).not.toBeInTheDocument();
  });

  it('in split view a sidebar row adds its session as a pane instead of leaving', async () => {
    const { SidebarWorkbenchList } = await import('../components/layout/SidebarWorkbenchList');
    useNavigationStore.setState({ route: { view: 'split' } });
    useSplitViewStore.setState({ panes: ['alpha'], focusedId: 'alpha' });
    const all = Object.values(useWorkbenchStore.getState().workbenches);
    render(<SidebarWorkbenchList workbenches={all} />);
    fireEvent.click(screen.getByText('gamma'));
    expect(useSplitViewStore.getState()).toMatchObject({ panes: ['alpha', 'gamma'], focusedId: 'gamma' });
    expect(useNavigationStore.getState().route).toEqual({ view: 'split' });
  });
});
