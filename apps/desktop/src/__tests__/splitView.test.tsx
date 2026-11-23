/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import {
  MAX_SPLIT_PANES,
  addSplitPane,
  moveSplitPane,
  parseSplitPanes,
  placeSplitPane,
  removeSplitPane,
  splitDropPosition,
  splitGridShape,
  splitViewOffered,
  type Features,
  type Workbench,
} from '@talyn/shared';
import { SplitView } from '../renderer/components/workbench/SplitView';
import { useSplitViewStore } from '../renderer/stores/splitView';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { isRoute, useNavigationStore } from '../renderer/stores/navigation';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { SESSION_DRAG_TYPE, openInSplitView } from '../renderer/lib/splitView';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/components/auth/AuthProvider', () => ({ useAuth: () => ({ user: null }) }));
jest.mock('../renderer/lib/workbenchData', () => ({ loadWorkbench: jest.fn(), ensureChatHistory: jest.fn(), loadOlderEvents: jest.fn() }));
jest.mock('../renderer/lib/wakeWorkbench', () => ({ wakeWorkbench: jest.fn() }));
jest.mock('../renderer/hooks/useSessionBackground', () => ({ useWorkbenchBackgroundLoad: () => undefined }));
jest.mock('../renderer/components/widgets/PRDetailSheet', () => ({ PRDetailSheet: () => null }));
jest.mock('../renderer/components/workbench/GitPanel', () => ({ GitPanel: () => null }));
jest.mock('../renderer/components/workbench/WorkPanel', () => ({ WorkPanel: () => null }));
jest.mock('../renderer/lib/workbenchBridge', () => ({
  ...jest.requireActual('../renderer/lib/workbenchBridge'),
  getDeviceId: () => 'this-mac',
  getWorkbenchBridge: () => null,
}));
jest.mock('../renderer/components/workbench/Composer', () => ({
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

/** jsdom has no DataTransfer: enough of one for a session drag. */
function transfer(id?: string) {
  const data = new Map<string, string>();
  if (id) data.set(SESSION_DRAG_TYPE, id);
  return {
    get types() {
      return [...data.keys()];
    },
    getData: (type: string) => data.get(type) ?? '',
    setData: (type: string, value: string) => void data.set(type, value),
    dropEffect: 'none',
    effectAllowed: 'all',
  };
}

/** Fire a drag event at `x` pixels across an element 100 pixels wide. */
function drag(kind: 'dragOver' | 'drop', element: HTMLElement, dataTransfer: ReturnType<typeof transfer>, x = 50) {
  element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
  const event = createEvent[kind](element, { dataTransfer });
  Object.defineProperty(event, 'clientX', { value: x });
  fireEvent(element, event);
}

/** Drag from `source` and drop on `target` at `x`, as a person does. */
function dragOnto(source: HTMLElement, target: HTMLElement, x = 50) {
  const dataTransfer = transfer();
  fireEvent.dragStart(source, { dataTransfer });
  drag('dragOver', target, dataTransfer, x);
  drag('drop', target, dataTransfer, x);
  fireEvent.dragEnd(source, { dataTransfer });
}

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

  it.each([
    ['replaces the target with a new session', ['a', 'b'], 'c', 'b', 'replace', ['a', 'c']],
    ['swaps two open panes', ['a', 'b', 'c'], 'a', 'c', 'replace', ['c', 'b', 'a']],
    ['adds a new session before the target', ['a', 'b'], 'c', 'b', 'before', ['a', 'c', 'b']],
    ['adds a new session after the target', ['a', 'b'], 'c', 'a', 'after', ['a', 'c', 'b']],
    ['moves an open pane after the target', ['a', 'b', 'c'], 'a', 'c', 'after', ['b', 'c', 'a']],
    ['moves an open pane before the target', ['a', 'b', 'c'], 'c', 'a', 'before', ['c', 'a', 'b']],
    ['moves an open pane in full panes', ['a', 'b', 'c', 'd'], 'd', 'a', 'before', ['d', 'a', 'b', 'c']],
    ['replaces the target when a new session cannot fit', ['a', 'b', 'c', 'd'], 'e', 'b', 'after', ['a', 'e', 'c', 'd']],
    ['does nothing when dropped on itself', ['a', 'b'], 'a', 'a', 'replace', ['a', 'b']],
    ['adds a session when the target is not a pane', ['a'], 'b', 'zzz', 'replace', ['a', 'b']],
    ['ignores a blank session', ['a'], '', 'a', 'replace', ['a']],
  ] as const)('a drop %s', (_name, panes, id, target, position, expected) => {
    expect(placeSplitPane(panes, id, target, position)).toEqual(expected);
  });

  it.each([
    [10, true, 'before'],
    [24, true, 'before'],
    [50, true, 'replace'],
    [76, true, 'after'],
    [99, true, 'after'],
    [10, false, 'replace'],
    [90, false, 'replace'],
  ] as const)('a drop at %s of 100 (room beside: %s) goes %s', (x, canAddBeside, expected) => {
    expect(splitDropPosition(x, 100, canAddBeside)).toBe(expected);
  });

  it('a drop on a pane with no width replaces it', () => {
    expect(splitDropPosition(0, 0, true)).toBe('replace');
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

  it('is a route the app can come back to after a relaunch', () => {
    expect(isRoute({ view: 'split' })).toBe(true);
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

  it('a local session on another device cannot be prompted from its pane', () => {
    useWorkbenchStore.getState().upsertWorkbench(wb('delta', { runtime: 'local', deviceId: 'other-mac' }));
    useSplitViewStore.setState({ panes: ['delta'], focusedId: 'delta' });
    render(<SplitView />);
    expect(screen.getByText('This session runs on another device. Open it to continue it here.')).toBeInTheDocument();
  });

  it('offers a way in when no session is open', () => {
    render(<SplitView />);
    expect(screen.getByText('Work on several sessions at once')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Add session/ }).length).toBeGreaterThan(0);
  });
});

describe('SplitView drag and drop', () => {
  it('shows a dropped session in the pane under the pointer', () => {
    useSplitViewStore.setState({ panes: ['alpha', 'beta'], focusedId: 'alpha' });
    render(<SplitView />);
    const panes = screen.getAllByRole('region');
    const dataTransfer = transfer('gamma');
    drag('dragOver', panes[1], dataTransfer);
    expect(within(panes[1]).getByText('Show here')).toBeInTheDocument();
    drag('drop', panes[1], dataTransfer);
    expect(useSplitViewStore.getState()).toMatchObject({ panes: ['alpha', 'gamma'], focusedId: 'gamma' });
    expect(screen.queryByText('Show here')).not.toBeInTheDocument();
  });

  it('adds a dropped session beside a pane at its edge', () => {
    useSplitViewStore.setState({ panes: ['alpha', 'beta'], focusedId: 'alpha' });
    render(<SplitView />);
    const panes = screen.getAllByRole('region');
    const dataTransfer = transfer('gamma');
    drag('dragOver', panes[0], dataTransfer, 90);
    expect(within(panes[0]).getByText('Add beside')).toBeInTheDocument();
    drag('drop', panes[0], dataTransfer, 90);
    expect(useSplitViewStore.getState().panes).toEqual(['alpha', 'gamma', 'beta']);
  });

  it('replaces a pane at its edge when split view is full', () => {
    useWorkbenchStore.getState().setWorkbenches('ws1', ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((id) => wb(id)));
    useSplitViewStore.setState({ panes: ['alpha', 'beta', 'gamma', 'delta'], focusedId: 'alpha' });
    render(<SplitView />);
    const panes = screen.getAllByRole('region');
    drag('drop', panes[0], transfer('epsilon'), 5);
    expect(useSplitViewStore.getState().panes).toEqual(['epsilon', 'beta', 'gamma', 'delta']);
  });

  it('swaps two panes when one header is dropped on the other pane', () => {
    useSplitViewStore.setState({ panes: ['alpha', 'beta', 'gamma'], focusedId: 'alpha' });
    render(<SplitView />);
    const panes = screen.getAllByRole('region');
    const header = panes[0].querySelector('[data-attr="split-view-pane-header"]') as HTMLElement;
    dragOnto(header, panes[2]);
    expect(useSplitViewStore.getState()).toMatchObject({ panes: ['gamma', 'beta', 'alpha'], focusedId: 'alpha' });
  });

  it('a pane is not a drop target for its own header', () => {
    useSplitViewStore.setState({ panes: ['alpha', 'beta'], focusedId: 'alpha' });
    render(<SplitView />);
    const pane = screen.getAllByRole('region')[0];
    const header = pane.querySelector('[data-attr="split-view-pane-header"]') as HTMLElement;
    const dataTransfer = transfer();
    fireEvent.dragStart(header, { dataTransfer });
    drag('dragOver', pane, dataTransfer);
    expect(pane.querySelector('[data-attr="split-view-drop-target"]')).toBeNull();
    fireEvent.dragEnd(header, { dataTransfer });
    expect(useSplitViewStore.getState().panes).toEqual(['alpha', 'beta']);
  });

  it('ignores a drag that carries no session', () => {
    useSplitViewStore.setState({ panes: ['alpha'], focusedId: 'alpha' });
    render(<SplitView />);
    const pane = screen.getByRole('region');
    const dataTransfer = transfer();
    dataTransfer.setData('text/plain', 'beta');
    drag('dragOver', pane, dataTransfer);
    expect(pane.querySelector('[data-attr="split-view-drop-target"]')).toBeNull();
    drag('drop', pane, dataTransfer);
    expect(useSplitViewStore.getState().panes).toEqual(['alpha']);
  });

  it('adds a session dropped on the empty split view', () => {
    render(<SplitView />);
    const empty = screen.getByText('Work on several sessions at once').closest('[data-attr="split-view-empty"]') as HTMLElement;
    drag('drop', empty, transfer('beta'));
    expect(useSplitViewStore.getState()).toMatchObject({ panes: ['beta'], focusedId: 'beta' });
  });

  it('a sidebar row drags its session onto a pane', async () => {
    const { SidebarWorkbenchList } = await import('../renderer/components/layout/SidebarWorkbenchList');
    useNavigationStore.setState({ route: { view: 'split' } });
    useSplitViewStore.setState({ panes: ['alpha'], focusedId: 'alpha' });
    const all = Object.values(useWorkbenchStore.getState().workbenches);
    render(
      <>
        <SidebarWorkbenchList workbenches={all} />
        <SplitView />
      </>,
    );
    const row = screen.getAllByText('gamma')[0].closest('[data-attr="sidebar-workbench-row"]') as HTMLElement;
    expect(row).toHaveAttribute('draggable', 'true');
    dragOnto(row, screen.getByRole('region'));
    expect(useSplitViewStore.getState()).toMatchObject({ panes: ['gamma'], focusedId: 'gamma' });
  });

  it('a sidebar row does not drag when split view is off', async () => {
    useWorkspaceStore.setState({ features: { workbenches: true, splitView: false } as Features });
    const { SidebarWorkbenchList } = await import('../renderer/components/layout/SidebarWorkbenchList');
    const all = Object.values(useWorkbenchStore.getState().workbenches);
    render(<SidebarWorkbenchList workbenches={all} />);
    const row = screen.getByText('gamma').closest('[data-attr="sidebar-workbench-row"]') as HTMLElement;
    expect(row).not.toHaveAttribute('draggable');
  });
});

describe('split view entry points', () => {
  it('the sidebar offers split view only behind the flag', async () => {
    const { AppSidebar } = await import('../renderer/components/layout/AppSidebar');
    const { unmount } = render(<AppSidebar />);
    expect(screen.getByRole('button', { name: /Split view/ })).toBeInTheDocument();
    unmount();
    useWorkspaceStore.setState({ features: { workbenches: true, splitView: false } as Features });
    render(<AppSidebar />);
    expect(screen.queryByRole('button', { name: /Split view/ })).not.toBeInTheDocument();
  });

  it('in split view a sidebar row adds its session as a pane instead of leaving', async () => {
    const { SidebarWorkbenchList } = await import('../renderer/components/layout/SidebarWorkbenchList');
    useNavigationStore.setState({ route: { view: 'split' } });
    useSplitViewStore.setState({ panes: ['alpha'], focusedId: 'alpha' });
    const all = Object.values(useWorkbenchStore.getState().workbenches);
    render(<SidebarWorkbenchList workbenches={all} />);
    fireEvent.click(screen.getByText('gamma'));
    expect(useSplitViewStore.getState()).toMatchObject({ panes: ['alpha', 'gamma'], focusedId: 'gamma' });
    expect(useNavigationStore.getState().route).toEqual({ view: 'split' });
  });
});
