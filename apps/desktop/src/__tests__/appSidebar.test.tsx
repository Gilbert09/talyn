/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, within, act } from '@testing-library/react';
import type { Features, Workbench, WorkbenchChat } from '@talyn/shared';
import type { PRRow } from '../renderer/lib/api';
import { AppSidebar } from '../renderer/components/layout/AppSidebar';
import { buildAppShortcuts, orderedLiveWorkbenches } from '../renderer/components/layout/appShortcuts';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { useNavigationStore } from '../renderer/stores/navigation';
import { usePullRequestStore } from '../renderer/stores/pullRequests';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/components/auth/AuthProvider', () => ({ useAuth: () => ({ user: null }) }));

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
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  } as Workbench;
}

function pr(over: Partial<PRRow>): PRRow {
  return {
    id: 'pr',
    number: 1,
    state: 'open',
    authored: false,
    watching: false,
    reviewRequested: false,
    mergeQueued: false,
    summary: { draft: false },
    ...over,
  } as unknown as PRRow;
}

function setFeatures(features: Partial<Features> | null) {
  useWorkspaceStore.setState({
    features: features as Features | null,
    sidebarCollapsed: false,
    sidebarOrder: 'active_first',
    cloudProviders: [],
  });
}

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  setFeatures({ workbenches: true });
  useWorkbenchStore.setState({ chats: {}, unread: {}, unseen: {} });
  useWorkbenchStore.getState().setWorkspace('ws1');
  useWorkbenchStore.getState().setWorkbenches('ws1', [
    wb('lisbon', { repoFullName: 'acme/web' }),
    wb('oslo', { repoFullName: 'acme/api', runtime: 'local' }),
    wb('rome', { repoFullName: 'acme/api', createdAt: '2026-10-14T00:00:00Z' }),
    wb('gone', { repoFullName: 'acme/api', status: 'archived', archivedAt: '2026-10-13T02:00:00Z' }),
  ]);
  usePullRequestStore.setState({ rows: [] });
  useNavigationStore.getState().navigate({ view: 'home' });
});

afterEach(() => cleanup());

describe('AppSidebar', () => {
  it('groups live workbenches by repository, repositories by activity, archived left out', () => {
    render(<AppSidebar />);
    const api = screen.getByRole('group', { name: 'acme/api' });
    const web = screen.getByRole('group', { name: 'acme/web' });
    expect(within(api).getAllByRole('button').map((b) => b.textContent)).toEqual(['rome', 'oslo']);
    expect(within(web).getByRole('button')).toHaveTextContent('lisbon');
    expect(screen.queryByText('gone')).not.toBeInTheDocument();
    // The newest acme/api session puts its group first.
    expect(api.compareDocumentPosition(web) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts sessions that work or have an open pull request in one active group', () => {
    useWorkbenchStore.getState().setChats('oslo', [
      { id: 'c1', workbenchId: 'oslo', status: 'running', createdAt: 'a' } as WorkbenchChat,
    ]);
    useWorkbenchStore.getState().upsertWorkbench(wb('lisbon', { repoFullName: 'acme/web', pullRequestId: 'p9' }));
    usePullRequestStore.setState({ rows: [pr({ id: 'p9' })] });

    render(<AppSidebar />);

    const active = screen.getByRole('group', { name: 'Active' });
    expect(within(active).getAllByRole('button').map((row) => row.textContent)).toEqual(['lisbon', 'oslo']);
    expect(within(screen.getByRole('group', { name: 'acme/api' })).getByRole('button')).toHaveTextContent('rome');
    expect(orderedLiveWorkbenches().map((row) => row.id)).toEqual(['lisbon', 'oslo', 'rome']);

    act(() => useWorkspaceStore.getState().setSidebarOrder('repository'));
    expect(screen.queryByRole('group', { name: 'Active' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'acme/api' })).getAllByRole('button').map((row) => row.textContent))
      .toEqual(['rome', 'oslo']);
  });


  it('keeps the creation order when a session changes, and the shortcuts follow it', () => {
    useWorkbenchStore.getState().upsertWorkbench(wb('lisbon', {
      repoFullName: 'acme/web', updatedAt: '2026-10-16T00:00:00Z',
    }));
    render(<AppSidebar />);
    const rows = screen.getAllByRole('button').filter((row) => row.getAttribute('data-attr') === 'sidebar-workbench-row');
    expect(rows.map((row) => row.textContent)).toEqual(['rome', 'oslo', 'lisbon']);
    expect(orderedLiveWorkbenches().map((row) => row.id)).toEqual(['rome', 'oslo', 'lisbon']);
    act(() => buildAppShortcuts().find((shortcut) => shortcut.id === 'workbench.jump.1')?.run());
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'rome' });
  });

  it('shows the diff stat and the runtime of a row', () => {
    useWorkbenchStore.getState().upsertWorkbench(wb('lisbon', {
      repoFullName: 'acme/web',
      diffStat: { added: 12, removed: 3, files: 2 },
    }));
    render(<AppSidebar />);
    const row = screen.getByRole('button', { name: /lisbon/ });
    expect(row).toHaveTextContent('+12');
    expect(row).toHaveTextContent('−3');
    expect(within(screen.getByRole('group', { name: 'acme/api' })).getByLabelText('Local worktree')).toBeInTheDocument();
  });

  it('a row shows a spinner while a chat runs, and bold while unread', () => {
    useWorkbenchStore.getState().setChats('oslo', [{ id: 'c1', workbenchId: 'oslo', status: 'running', createdAt: 'a' } as WorkbenchChat]);
    useWorkbenchStore.getState().setChats('rome', [{ id: 'c2', workbenchId: 'rome', status: 'idle', createdAt: 'a' } as WorkbenchChat]);
    useWorkbenchStore.setState({ unread: { c2: true } });
    render(<AppSidebar />);
    expect(within(screen.getByRole('button', { name: /oslo/ })).getByLabelText('Working')).toBeInTheDocument();
    expect(screen.getByText('rome')).toHaveClass('font-semibold');
    expect(screen.getByText('lisbon')).not.toHaveClass('font-semibold');
  });

  it.each<[string, Partial<Workbench>, string]>([
    ['a failed workbench', { status: 'error' }, 'Failed to start'],
    ['a sandbox that failed to start', { sandboxState: 'error' }, 'Failed to start'],
    ['a starting workbench', { status: 'provisioning' }, 'Starting'],
    ['a ready idle workbench', {}, 'Idle'],
  ])('%s shows the %s dot', (_name, over, label) => {
    useWorkbenchStore.getState().upsertWorkbench(wb('lisbon', { repoFullName: 'acme/web', ...over }));
    render(<AppSidebar />);
    expect(within(screen.getByRole('button', { name: /lisbon/ })).getByLabelText(label)).toBeInTheDocument();
  });

  it('stacks New workbench over Search, so both fit the sidebar', () => {
    render(<AppSidebar />);
    const newWb = screen.getByText('New session').closest('button')!;
    const search = screen.getByText('Search').closest('button')!;
    expect(newWb.parentElement).toBe(search.parentElement);
    expect(newWb.parentElement).toHaveClass('flex-col');
    expect(newWb).not.toHaveClass('flex-1');
  });

  it.each([
    [1, '1 repo'],
    [2, '2 repos'],
    [0, '0 repos'],
  ])('the workspace switcher counts %p repositories as %p', (count, text) => {
    useWorkspaceStore.setState({
      workspaces: [{ id: 'w', name: 'Acme', repos: Array.from({ length: count }, (_, i) => ({ id: `r${i}` })) }] as never,
      currentWorkspaceId: 'w',
    });
    render(<AppSidebar />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('an idle row with a merged PR shows it is done', () => {
    useWorkbenchStore.getState().upsertWorkbench(wb('lisbon', { repoFullName: 'acme/web', pullRequestId: 'p9' }));
    usePullRequestStore.setState({ rows: [pr({ id: 'p9', state: 'merged' })] });
    render(<AppSidebar />);
    expect(within(screen.getByRole('button', { name: /lisbon/ })).getByLabelText(/^Done: #\d+ merged$/)).toBeInTheDocument();
  });

  it.each(['merged', 'closed'] as const)('uses the embedded %s PR and hides the diff stat', (state) => {
    useWorkbenchStore.getState().upsertWorkbench(wb('lisbon', {
      repoFullName: 'acme/web',
      pullRequestId: 'p9',
      diffStat: { added: 12, removed: 3, files: 2 },
      pr: { number: 9, url: 'https://github.com/acme/web/pull/9', state, mergeable: 'unknown', ciStatus: 'none' },
    }));
    render(<AppSidebar />);
    const row = screen.getByRole('button', { name: /lisbon/ });
    const mark = within(row).getByLabelText(state === 'merged' ? 'Done: #9 merged' : '#9 closed');
    expect(mark).toHaveClass(state === 'merged' ? 'text-merged' : 'text-destructive');
    expect(row).not.toHaveTextContent('+12');
    expect(row).not.toHaveTextContent('−3');
    // The name dims; the state mark keeps its full colour.
    expect(row).not.toHaveClass('opacity-60');
    expect(within(row).getByText('lisbon')).toHaveClass('opacity-60');
    expect(mark.closest('.opacity-60')).toBeNull();
  });

  it('clicking a row opens the workbench route and marks it current', () => {
    render(<AppSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /rome/ }));
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'rome' });
    expect(screen.getByRole('button', { name: /rome/ })).toHaveAttribute('aria-current', 'page');
  });

  it('Pull requests, Review requests and Merge queue each count their own page', () => {
    usePullRequestStore.setState({
      rows: [
        pr({ id: 'a', authored: true }),
        pr({ id: 'b', watching: true }),
        pr({ id: 'c', reviewRequested: true }),
        pr({ id: 'd', reviewRequested: true, reviewHiddenAt: '2026-10-13T00:00:00Z' } as Partial<PRRow>),
        pr({ id: 'e', codeReview: { openCount: 2 } } as Partial<PRRow>),
        pr({ id: 'f', mergeQueued: true }),
      ],
    });
    render(<AppSidebar />);
    // 2 mine; 1 visible review (the hidden one is not counted); 1 queued.
    expect(screen.getByText('2', { selector: '[data-attr="nav-pull-requests-badge"]' })).toBeInTheDocument();
    expect(screen.getByText('1', { selector: '[data-attr="nav-review-requests-badge"]' })).toBeInTheDocument();
    expect(screen.getByText('1', { selector: '[data-attr="nav-merge-queue-badge"]' })).toBeInTheDocument();
  });

  it.each<[string, string, string]>([
    ['Review requests', 'reviews', 'nav-review-requests'],
    ['Merge queue', 'merge_queue', 'nav-merge-queue'],
  ])('%s opens its own page and marks only itself current', (label, tab) => {
    render(<AppSidebar />);
    fireEvent.click(screen.getByText(label));
    expect(useNavigationStore.getState().route).toEqual({ view: 'prs', tab });
  });

  it('Pull requests stays on its tab, but leaves Review requests for PRs', () => {
    useNavigationStore.getState().navigate({ view: 'prs', tab: 'queue' });
    render(<AppSidebar />);
    fireEvent.click(screen.getByText('Pull requests'));
    expect(useNavigationStore.getState().route).toEqual({ view: 'prs', tab: 'queue' });
    act(() => useNavigationStore.getState().navigate({ view: 'prs', tab: 'reviews' }));
    fireEvent.click(screen.getByText('Pull requests'));
    expect(useNavigationStore.getState().route).toEqual({ view: 'prs', tab: 'my_prs' });
  });

  it('the Pull requests badge counts PRs only, not Code review', () => {
    setFeatures({ workbenches: true });
    usePullRequestStore.setState({ rows: [pr({ id: 'a', authored: true }), pr({ id: 'e', codeReview: { openCount: 1 } } as Partial<PRRow>)] });
    render(<AppSidebar />);
    expect(screen.getByText('1', { selector: '[data-attr="nav-pull-requests-badge"]' })).toBeInTheDocument();
  });

  it('Pull requests opens the PR area', () => {
    render(<AppSidebar />);
    fireEvent.click(screen.getByText('Pull requests'));
    expect(useNavigationStore.getState().route).toEqual({ view: 'prs', tab: 'my_prs' });
  });

  it.each([
    [{ workbenches: true }, false],
    [{ workbenches: true, workflows: true }, true],
    [{ workbenches: true, loops: true }, true],
    // MCP servers is in Settings, so it alone does not offer Automations.
    [{ workbenches: true, mcpServers: true }, false],
    [null, false],
  ])('Automations appears only when something is offered (%p → %s)', (features, shown) => {
    setFeatures(features as Partial<Features> | null);
    render(<AppSidebar />);
    expect(screen.queryByText('Automations') !== null).toBe(shown);
  });

  it('Automations opens the first offered tab', () => {
    setFeatures({ workbenches: true, loops: true, mcpServers: true });
    render(<AppSidebar />);
    fireEvent.click(screen.getByText('Automations'));
    expect(useNavigationStore.getState().route).toEqual({ view: 'automations', tab: 'loops' });
  });

  it('hides the workbench list, History and New workbench when workbenches are not offered', () => {
    setFeatures({ workbenches: false });
    render(<AppSidebar />);
    expect(screen.queryByText('lisbon')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'History' })).not.toBeInTheDocument();
    expect(screen.queryByText('New session')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Switch workspace'));
    expect(screen.getByRole('button', { name: 'Add repository' })).toBeInTheDocument();
  });

  it('moves History to the top strip and Add repository to the switcher', () => {
    render(<AppSidebar />);
    expect(document.querySelector('[data-attr="sidebar-pinned"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add repository' })).not.toBeInTheDocument();
    const history = screen.getByRole('button', { name: 'History' });
    expect(history).toHaveAttribute('title', 'History');
    expect(history).toHaveAttribute('data-attr', 'sidebar-history');
    expect(history).toHaveAttribute('aria-pressed', 'false');
    expect(history.nextElementSibling).toHaveAttribute('data-attr', 'nav-back');
    fireEvent.click(screen.getByText('Search'));
    expect(useNavigationStore.getState().paletteOpen).toBe(true);
    fireEvent.click(screen.getByTitle('Switch workspace'));
    const addRepository = screen.getByRole('button', { name: 'Add repository' });
    expect(addRepository).toHaveAttribute('data-attr', 'sidebar-add-repository');
    expect(addRepository.nextElementSibling).toHaveTextContent('Workspace settings');
    fireEvent.click(addRepository);
    expect(useNavigationStore.getState().addRepositoryOpen).toBe(true);
    expect(screen.queryByRole('button', { name: 'Add repository' })).not.toBeInTheDocument();
    fireEvent.click(history);
    expect(useNavigationStore.getState().route).toEqual({ view: 'history' });
    expect(history).toHaveAttribute('aria-pressed', 'true');
    useNavigationStore.setState({ paletteOpen: false, addRepositoryOpen: false });
  });

  it('New workbench goes home and asks the new-workbench page for a fresh start', () => {
    useNavigationStore.getState().navigate({ view: 'prs', tab: 'reviews' });
    const before = useWorkbenchStore.getState().newWorkbench.seq;
    render(<AppSidebar />);
    fireEvent.click(screen.getByText('New session'));
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
    expect(useWorkbenchStore.getState().newWorkbench).toEqual({ seq: before + 1, prefill: null });
  });

  it('collapses to an icon rail with the toggle', () => {
    render(<AppSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(useWorkspaceStore.getState().sidebarCollapsed).toBe(true);
    expect(screen.queryByText('lisbon')).not.toBeInTheDocument();
    expect(document.querySelector('[data-attr="sidebar-pinned"]')).toBeNull();
    const history = screen.getByRole('button', { name: 'History' });
    const addRepository = screen.getByRole('button', { name: 'Add repository' });
    expect(history).toHaveAttribute('data-attr', 'sidebar-history');
    expect(addRepository).toHaveAttribute('data-attr', 'sidebar-add-repository');
    fireEvent.click(history);
    expect(useNavigationStore.getState().route).toEqual({ view: 'history' });
    expect(history).toHaveAttribute('aria-current', 'page');
    fireEvent.click(addRepository);
    expect(useNavigationStore.getState().addRepositoryOpen).toBe(true);
    expect(screen.getByRole('button', { name: 'Pull requests' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(useWorkspaceStore.getState().sidebarCollapsed).toBe(false);
    useNavigationStore.setState({ addRepositoryOpen: false });
  });
});

 it.each([
   [{ files: 1, added: 2, removed: 1 }, true],
   [{ files: 0, added: 0, removed: 0 }, false],
   [null, false],
 ] as const)('shows only uncommitted sidebar totals: %j', (uncommittedStats, shown) => {
   useWorkbenchStore.getState().upsertWorkbench(wb('lisbon', {
     diffStat: { files: 2, added: 99, removed: 88 },
     uncommittedStats,
     committedStats: { files: 2, added: 97, removed: 87 },
   }));
   render(<AppSidebar />);
   const row = screen.getByRole('button', { name: /lisbon/ });
   expect(row).not.toHaveTextContent('+99');
   expect(row).not.toHaveTextContent('−88');
   expect(row).not.toHaveTextContent('+97');
   if (shown) {
     expect(row).toHaveTextContent('+2');
     expect(row).toHaveTextContent('−1');
   } else {
     expect(row).not.toHaveTextContent(/\+\d|−\d/);
   }
 });
