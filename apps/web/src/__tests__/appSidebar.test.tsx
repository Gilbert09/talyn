import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, within, act } from '@testing-library/react';
import type { Features, Workbench, WorkbenchChat } from '@talyn/shared';
import type { PRRow } from '../lib/api';
import { AppSidebar } from '../components/layout/AppSidebar';
import { useWorkspaceStore } from '../stores/workspace';
import { useWorkbenchStore } from '../stores/workbenches';
import { useNavigationStore } from '../stores/navigation';
import { usePullRequestStore } from '../stores/pullRequests';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../components/auth/AuthProvider', () => ({ useAuth: () => ({ user: null }) }));

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
    currentWorkspaceId: 'ws1',
    features: features as Features | null,
    sidebarCollapsed: false,
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
  setFeatures({ workbenches: true, codeReview: true });
  useWorkbenchStore.getState().setWorkspace('ws1');
  useWorkbenchStore
    .getState()
    .setWorkbenches('ws1', [
      wb('lisbon', { repoFullName: 'acme/web', diffStat: { added: 12, removed: 3, files: 2 } }),
      wb('oslo', { repoFullName: 'acme/api' }),
      wb('rome', { repoFullName: 'acme/api', createdAt: '2026-10-14T00:00:00Z' }),
      wb('gone', { repoFullName: 'acme/api', status: 'archived', archivedAt: '2026-10-13T02:00:00Z' }),
    ]);
  usePullRequestStore.setState({ rows: [] });
  useNavigationStore.getState().navigate({ view: 'home' });
});

afterEach(() => cleanup());

describe('AppSidebar', () => {
  it('groups live workbenches by repository, repositories alphabetical, archived left out', () => {
    render(<AppSidebar />);
    const api = screen.getByRole('group', { name: 'acme/api' });
    const web = screen.getByRole('group', { name: 'acme/web' });
    expect(
      within(api)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['oslo', 'rome']);
    expect(within(web).getByRole('button')).toHaveTextContent('lisbon');
    expect(screen.queryByText('gone')).not.toBeInTheDocument();
    // acme/api sorts before acme/web.
    expect(api.compareDocumentPosition(web) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the diff stat of a row', () => {
    render(<AppSidebar />);
    const row = screen.getByRole('button', { name: /lisbon/ });
    expect(row).toHaveTextContent('+12');
    expect(row).toHaveTextContent('−3');
  });

  it('a row shows a spinner while a chat runs, and bold while unread', () => {
    useWorkbenchStore
      .getState()
      .setChats('oslo', [{ id: 'c1', workbenchId: 'oslo', status: 'running', createdAt: 'a' } as WorkbenchChat]);
    useWorkbenchStore
      .getState()
      .setChats('rome', [{ id: 'c2', workbenchId: 'rome', status: 'idle', createdAt: 'a' } as WorkbenchChat]);
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
      workspaces: [
        { id: 'w', name: 'Acme', repos: Array.from({ length: count }, (_, i) => ({ id: `r${i}` })) },
      ] as never,
      currentWorkspaceId: 'w',
    });
    render(<AppSidebar />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('an idle row with a merged PR shows it is done', () => {
    useWorkbenchStore.getState().upsertWorkbench(wb('lisbon', { repoFullName: 'acme/web', pullRequestId: 'p9' }));
    usePullRequestStore.setState({ rows: [pr({ id: 'p9', state: 'merged' })] });
    render(<AppSidebar />);
    expect(
      within(screen.getByRole('button', { name: /lisbon/ })).getByLabelText(/^Done: #\d+ merged$/)
    ).toBeInTheDocument();
  });

  it.each(['merged', 'closed'] as const)('uses the embedded %s PR and hides the diff stat', (state) => {
    useWorkbenchStore.getState().upsertWorkbench(
      wb('lisbon', {
        repoFullName: 'acme/web',
        pullRequestId: 'p9',
        diffStat: { added: 12, removed: 3, files: 2 },
        pr: { number: 9, url: 'https://github.com/acme/web/pull/9', state, mergeable: 'unknown', ciStatus: 'none' },
      })
    );
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
    setFeatures({ workbenches: true, codeReview: false });
    usePullRequestStore.setState({
      rows: [pr({ id: 'a', authored: true }), pr({ id: 'e', codeReview: { openCount: 1 } } as Partial<PRRow>)],
    });
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

  it.each([null, { workbenches: false }])('hides sessions when features are %p', (features) => {
    setFeatures(features);
    render(<AppSidebar />);
    expect(screen.queryByText('lisbon')).not.toBeInTheDocument();
    expect(screen.queryByText('History')).not.toBeInTheDocument();
    expect(screen.queryByText('New session')).not.toBeInTheDocument();
    expect(screen.getByText('Add repository')).toBeInTheDocument();
  });

  it('Search opens the palette, Add repository opens the repo picker, History opens history', () => {
    render(<AppSidebar />);
    fireEvent.click(screen.getByText('Search'));
    expect(useNavigationStore.getState().paletteOpen).toBe(true);
    fireEvent.click(screen.getByText('Add repository'));
    expect(useNavigationStore.getState().addRepositoryOpen).toBe(true);
    fireEvent.click(screen.getByText('History'));
    expect(useNavigationStore.getState().route).toEqual({ view: 'history' });
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
    expect(screen.getByRole('button', { name: 'Pull requests' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(useWorkspaceStore.getState().sidebarCollapsed).toBe(false);
  });
});
