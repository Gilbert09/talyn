/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import { SidebarWorkbenchList } from '../renderer/components/layout/SidebarWorkbenchList';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { installNavigation, useNavigationStore } from '../renderer/stores/navigation';
import { usePullRequestStore } from '../renderer/stores/pullRequests';
import { toast } from '../renderer/stores/toast';

const archiveMany = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: { workbenches: { archiveMany: (...a: unknown[]) => archiveMany(...a), update: jest.fn() } },
}));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
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
    sandboxState: 'running',
    status: 'ready',
    pullRequestId: null,
    diffStat: null,
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  } as Workbench;
}

const merged = { number: 2, url: 'https://github.com/acme/app/pull/2', state: 'merged', mergeable: 'unknown', ciStatus: 'none' } as const;

const lisbon = wb('lisbon');
const oslo = wb('oslo', { pullRequestId: 'pr1' });
const porto = wb('porto', { pullRequestId: 'pr2', pr: merged });
const rome = wb('rome', { chats: [{ id: 'c1', status: 'running' }] as never });

function setSessions(list: Workbench[]) {
  useWorkbenchStore.getState().setWorkbenches('ws1', list);
}

function StoreList() {
  const workbenches = useWorkbenchStore((s) => s.workbenches);
  return <SidebarWorkbenchList workbenches={Object.values(workbenches)} />;
}

function renderList() {
  return render(<StoreList />);
}

const archiveAllButton = () => screen.getByRole('button', { name: 'Archive all sessions without an open pull request' });

const archivedRow = (id: string) => ({ ...wb(id), status: 'archived', archivedAt: '2026-11-06T00:00:00Z' });

beforeAll(() => installNavigation());

beforeEach(() => {
  archiveMany.mockReset();
  archiveMany.mockImplementation(async (ids: string[]) => ({ archived: ids.map(archivedRow), failed: [] }));
  jest.mocked(toast.success).mockClear();
  jest.mocked(toast.error).mockClear();
  useWorkbenchStore.getState().setWorkspace('ws1');
  setSessions([lisbon, oslo, porto, rome]);
  useWorkbenchStore.setState({ listLoaded: true, chats: {} });
  usePullRequestStore.setState({
    rows: [{ id: 'pr1', number: 4, state: 'open', summary: { draft: false, url: 'https://github.com/acme/app/pull/4' } }] as never,
  });
  useNavigationStore.getState().navigate({ view: 'home' });
});

afterEach(() => cleanup());

describe('sidebar archive all', () => {
  it('names the count in the button title', () => {
    renderList();
    expect(archiveAllButton()).toHaveAttribute('title', 'Archive all sessions without an open pull request (2)');
    expect(archiveAllButton()).toBeEnabled();
  });

  it('archives only the sessions without an open PR that do not work now', async () => {
    renderList();
    fireEvent.click(archiveAllButton());
    expect(await screen.findByText('Archive 2 sessions?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive all' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Archived 2 sessions'));
    expect(archiveMany).toHaveBeenCalledTimes(1);
    expect([...archiveMany.mock.calls[0][0]].sort()).toEqual(['lisbon', 'porto']);
    await waitFor(() => expect(screen.queryByText('Archive 2 sessions?')).not.toBeInTheDocument());
  });

  it('archives nothing when the person cancels', async () => {
    renderList();
    fireEvent.click(archiveAllButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(archiveMany).not.toHaveBeenCalled();
  });

  it('is disabled when every session has an open PR or works now', () => {
    setSessions([oslo, rome]);
    renderList();
    expect(archiveAllButton()).toBeDisabled();
    expect(archiveAllButton()).toHaveAttribute('title', 'No session to archive: each one has an open pull request or works now');
  });

  it('clears the selection when the open session is archived', async () => {
    useNavigationStore.getState().navigate({ view: 'workbench', id: 'lisbon' });
    useWorkbenchStore.getState().selectWorkbench('lisbon');
    renderList();
    fireEvent.click(archiveAllButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Archive all' }));
    await waitFor(() => expect(archiveMany).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useWorkbenchStore.getState().selectedWorkbenchId).toBeNull());
  });

  it('counts only the sessions that archived when one fails', async () => {
    archiveMany.mockImplementation(async (ids: string[]) => ({
      archived: ids.filter((id) => id !== 'porto').map(archivedRow),
      failed: [{ id: 'porto', error: 'boom' }],
    }));
    renderList();
    fireEvent.click(archiveAllButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Archive all' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Archived 1 session'));
    expect(toast.error).toHaveBeenCalledWith('Could not archive 1 session', 'boom');
  });

  it('hides every session at once and closes the dialog before the server answers', async () => {
    let answer: (value: unknown) => void = () => {};
    archiveMany.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    renderList();
    expect(screen.getByText('lisbon')).toBeInTheDocument();
    fireEvent.click(archiveAllButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Archive all' }));

    await waitFor(() => expect(screen.queryByText('Archive 2 sessions?')).not.toBeInTheDocument());
    expect(screen.queryByText('lisbon')).not.toBeInTheDocument();
    expect(screen.queryByText('porto')).not.toBeInTheDocument();
    expect(screen.getByText('oslo')).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();

    answer({ archived: ['lisbon', 'porto'].map(archivedRow), failed: [] });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Archived 2 sessions'));
  });

  it('shows a session again when the server could not archive it', async () => {
    archiveMany.mockImplementation(async () => ({
      archived: [archivedRow('lisbon')],
      failed: [{ id: 'porto', error: 'boom' }],
    }));
    renderList();
    fireEvent.click(archiveAllButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Archive all' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not archive 1 session', 'boom'));
    expect(useWorkbenchStore.getState().workbenches.porto).toEqual(porto);
    expect(useWorkbenchStore.getState().workbenches.lisbon.status).toBe('archived');
  });

  it('shows every session again when the request fails', async () => {
    archiveMany.mockRejectedValue(new Error('down'));
    renderList();
    fireEvent.click(archiveAllButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Archive all' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not archive the sessions', 'down'));
    expect(useWorkbenchStore.getState().workbenches.lisbon).toEqual(lisbon);
    expect(useWorkbenchStore.getState().workbenches.porto).toEqual(porto);
  });

  it('keeps a newer row from the server when the request fails', async () => {
    const newer = { ...archivedRow('lisbon'), name: 'lisbon-from-server' } as Workbench;
    archiveMany.mockImplementation(async () => {
      useWorkbenchStore.getState().upsertWorkbench(newer);
      throw new Error('timeout');
    });
    renderList();
    fireEvent.click(archiveAllButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Archive all' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not archive the sessions', 'timeout'));
    expect(useWorkbenchStore.getState().workbenches.lisbon).toBe(newer);
    expect(useWorkbenchStore.getState().workbenches.porto).toEqual(porto);
  });

  it('shows one error and no success when the request fails', async () => {
    archiveMany.mockRejectedValue(new Error('down'));
    renderList();
    fireEvent.click(archiveAllButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Archive all' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not archive the sessions', 'down'));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
  });
});
