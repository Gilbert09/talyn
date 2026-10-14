/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Features, Workbench, WorkbenchChat } from '@talyn/shared';
import type { PRRow } from '../renderer/lib/api';
import { AppSidebar } from '../renderer/components/layout/AppSidebar';
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
  useWorkspaceStore.setState({ features: features as Features | null, sidebarCollapsed: false, cloudProviders: [] });
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
  useWorkbenchStore.getState().setWorkbenches('ws1', [
    wb('lisbon', { repoFullName: 'acme/web', diffStat: { added: 12, removed: 3, files: 2 } }),
    wb('oslo', { repoFullName: 'acme/api', runtime: 'local' }),
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
    expect(within(api).getAllByRole('button').map((b) => b.textContent)).toEqual(['oslo', 'rome']);
    expect(within(web).getByRole('button')).toHaveTextContent('lisbon');
    expect(screen.queryByText('gone')).not.toBeInTheDocument();
    // acme/api sorts before acme/web.
    expect(api.compareDocumentPosition(web) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the diff stat and the runtime of a row', () => {
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
    expect(within(screen.getByRole('button', { name: /oslo/ })).getByLabelText('Running')).toBeInTheDocument();
    expect(screen.getByText('rome')).toHaveClass('font-semibold');
    expect(screen.getByText('lisbon')).not.toHaveClass('font-semibold');
  });

  it.each<[string, Partial<Workbench>, string]>([
    ['a failed workbench', { status: 'error' }, 'Error'],
    ['a sandbox that failed to start', { sandboxState: 'error' }, 'Error'],
    ['a starting workbench', { status: 'provisioning' }, 'Running'],
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

  it('an idle row with a PR shows the PR state colour', () => {
    useWorkbenchStore.getState().upsertWorkbench(wb('lisbon', { repoFullName: 'acme/web', pullRequestId: 'p9' }));
    usePullRequestStore.setState({ rows: [pr({ id: 'p9', state: 'merged' })] });
    render(<AppSidebar />);
    expect(within(screen.getByRole('button', { name: /lisbon/ })).getByLabelText('Pull request merged')).toBeInTheDocument();
  });

  it('clicking a row opens the workbench route and marks it current', () => {
    render(<AppSidebar />);
    fireEvent.click(screen.getByRole('button', { name: /rome/ }));
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'rome' });
    expect(screen.getByRole('button', { name: /rome/ })).toHaveAttribute('aria-current', 'page');
  });

  it('the Pull requests badge sums My PRs, Review requests, Code review and Merge queue', () => {
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
    // 2 mine + 1 visible review + 1 code review + 1 queued.
    expect(screen.getByText('5', { selector: '[data-attr="nav-pull-requests-badge"]' })).toBeInTheDocument();
  });

  it('leaves Code review out of the badge when it is not offered', () => {
    setFeatures({ workbenches: true, codeReview: false });
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
    [{ workbenches: true, mcpServers: true }, true],
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
