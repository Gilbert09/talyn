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
jest.mock('../renderer/lib/readiness', () => ({
  ...jest.requireActual('../renderer/lib/readiness'),
  useReadiness: () => ({ sandbox: null, local: null, loading: false, refresh: async () => {} }),
}));

function wb(id: string, over: Partial<Workbench> = {}): Workbench {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    name: id,
    branch: `tom/${id}`,
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

const thread = (id: string, over: Partial<Workbench> = {}) =>
  wb(id, { kind: 'thread', repositoryId: null, repoFullName: '', branch: '', baseBranch: '', ...over });

const chat = (id: string, workbenchId: string, status: WorkbenchChat['status']) =>
  ({ id, workbenchId, status, createdAt: '2026-10-13T00:00:00Z' }) as WorkbenchChat;

function setWorkbenches(list: Workbench[]) {
  useWorkbenchStore.getState().setWorkspace('ws1');
  useWorkbenchStore.getState().setWorkbenches('ws1', list);
}

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  useWorkspaceStore.setState({ features: { workbenches: true } as Features, sidebarCollapsed: false, cloudProviders: [] });
  useWorkbenchStore.setState({ chats: {}, unread: {} });
  usePullRequestStore.setState({ rows: [] });
  useNavigationStore.getState().navigate({ view: 'home' });
  setWorkbenches([
    thread('fleet', { title: 'Talyn fleet hardening', createdAt: '2026-10-10T00:00:00Z' }),
    thread('slack', { title: 'Slack integration', createdAt: '2026-10-11T00:00:00Z' }),
    thread('old', { title: 'Old thread', archivedAt: '2026-10-12T00:00:00Z' }),
    wb('skillpack', { repoFullName: 'gilbert09/talyn', threadId: 'fleet', pullRequestId: null }),
    wb('vsock', { repoFullName: 'yas/yas', threadId: 'fleet', pullRequestId: 'pr7' }),
    wb('flaky', { repoFullName: 'posthog/posthog', threadId: 'slack', title: 'fix flaky insight test' }),
    wb('solo', { repoFullName: 'posthog/posthog' }),
  ]);
  useWorkbenchStore.getState().setChats('skillpack', [chat('c1', 'skillpack', 'running')]);
  useWorkbenchStore.getState().setChats('vsock', [chat('c2', 'vsock', 'running')]);
  usePullRequestStore.setState({
    rows: [{ id: 'pr7', number: 7, state: 'open', summary: { draft: false, ciStatus: 'passing' } } as unknown as PRRow],
  });
});

afterEach(() => cleanup());

describe('Sidebar threads', () => {
  it('lists live threads above the sessions, with a running summary', () => {
    render(<AppSidebar />);
    const section = screen.getByRole('group', { name: 'Threads' });
    const rows = within(section).getAllByRole('button').filter((b) => b.getAttribute('data-attr') === 'sidebar-thread-row');
    expect(rows.map((r) => r.textContent)).toEqual(['Talyn fleet hardening2 running', 'Slack integrationidle']);
    expect(within(section).queryByText('Old thread')).not.toBeInTheDocument();
    // Above the repository groups in document order.
    const sessions = screen.getByRole('group', { name: 'posthog/posthog' });
    expect(section.compareDocumentPosition(sessions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows each thread session as repo · branch, with its PR mark', () => {
    render(<AppSidebar />);
    const fleet = screen.getByRole('group', { name: 'Sessions of Talyn fleet hardening' });
    const children = within(fleet).getAllByRole('button');
    expect(children.map((c) => c.textContent)).toEqual(['talyn · tom/skillpack', 'yas · tom/vsock#7']);
  });

  it('opens a thread and a thread session on click', () => {
    render(<AppSidebar />);
    const section = screen.getByRole('group', { name: 'Threads' });
    fireEvent.click(within(section).getByText('Talyn fleet hardening'));
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'fleet' });
    fireEvent.click(within(section).getByText('tom/vsock'));
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'vsock' });
  });

  it('collapses and expands a thread with aria-expanded', () => {
    render(<AppSidebar />);
    const toggle = screen.getByRole('button', { name: 'Hide the sessions of Talyn fleet hardening' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(screen.queryByRole('group', { name: 'Sessions of Talyn fleet hardening' })).not.toBeInTheDocument();
    const again = screen.getByRole('button', { name: 'Show the sessions of Talyn fleet hardening' });
    expect(again).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(again);
    expect(screen.getByRole('group', { name: 'Sessions of Talyn fleet hardening' })).toBeInTheDocument();
  });

  it('keeps thread sessions under their repository, with a thread tag', () => {
    render(<AppSidebar />);
    const repo = screen.getByRole('group', { name: 'posthog/posthog' });
    const rows = within(repo).getAllByRole('button');
    expect(rows.map((r) => r.textContent)).toEqual(['fix flaky insight testSlack integration', 'solo']);
    expect(within(rows[0]).getByTitle('Part of the thread Slack integration')).toBeInTheDocument();
    // A thread is never a repository group of its own.
    expect(screen.queryByRole('group', { name: '' })).not.toBeInTheDocument();
  });

  it('hides the section when there are no live threads', () => {
    setWorkbenches([wb('solo'), thread('old', { archivedAt: '2026-10-12T00:00:00Z' })]);
    render(<AppSidebar />);
    expect(screen.queryByRole('group', { name: 'Threads' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'acme/app' })).toBeInTheDocument();
  });

  it('opens the new page in thread mode from the Threads header', () => {
    render(<AppSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'New thread' }));
    expect(useNavigationStore.getState().route).toEqual({ view: 'home', mode: 'thread' });
  });
});
