import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import { HistoryView } from '../renderer/pages/HistoryView';
import { useWorkbenchStore } from '../renderer/stores/workbenches';

const mockArchive = jest.fn();
const mockRestore = jest.fn();
const mockInspect = jest.fn();
const mockRemoveWorktree = jest.fn();
let mockRows: Workbench[] = [];
const mockFailed = { id: 'archive-failed', workspaceId: 'ws', name: 'Oslo', repoFullName: 'o/r', branch: 'work', baseBranch: 'main',
  status: 'archiveError', statusMessage: 'Access was revoked.', archivedAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z' } as Workbench;
jest.mock('../renderer/lib/api', () => ({ api: { workbenches: {
  archive: (...args: unknown[]) => mockArchive(...args), restore: (...args: unknown[]) => mockRestore(...args),
} } }));
jest.mock('../renderer/components/workbench/workbenchSelectors', () => ({
  isArchived: (wb: Workbench) => Boolean(wb.archivedAt), useWorkspaceWorkbenches: () => mockRows,
}));
jest.mock('../renderer/lib/workbenchBridge', () => ({
  getWorkbenchBridge: () => ({ inspectWorktree: mockInspect, removeWorktree: mockRemoveWorktree }),
  getDeviceId: () => 'device-1',
}));
jest.mock('../renderer/components/workbench/WorkbenchBadges', () => ({ PrPill: () => null }));

beforeEach(() => {
  mockRows = [mockFailed];
  jest.clearAllMocks();
});
afterEach(cleanup);
it('shows the archive failure and lets the user retry or restore', async () => {
  useWorkbenchStore.setState({ listLoaded: true, listError: null });
  mockArchive.mockResolvedValue({ ...mockFailed, status: 'archived', statusMessage: null });
  mockRestore.mockResolvedValue({ ...mockFailed, status: 'ready', archivedAt: null });
  render(<HistoryView />);
  expect(screen.getByText('Access was revoked.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(mockArchive).toHaveBeenCalledWith('archive-failed'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Restore Oslo' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Restore Oslo' }));
  await waitFor(() => expect(mockRestore).toHaveBeenCalledWith('archive-failed'));
});

it('shows a kept worktree and deletes it with force after naming the lost files', async () => {
  const path = '/managed/repo/session';
  mockRows = [{ ...mockFailed, id: 'local-1', runtime: 'local', deviceId: 'device-1', localPath: path,
    keptWorktree: { reason: 'uncommitted', files: 2, path, names: ['draft.txt', 'notes.txt'] } }];
  mockInspect.mockResolvedValue({ managed: true, exists: true, branch: 'work', uncommitted: ['draft.txt', 'notes.txt'],
    uncommittedCount: 2, unpushed: 0 });
  mockRemoveWorktree.mockResolvedValue(undefined);
  useWorkbenchStore.setState({ workspaceId: 'ws', listLoaded: true, listError: null,
    workbenches: { 'local-1': mockRows[0] } });

  render(<HistoryView />);
  expect(screen.getByText(`Worktree kept: 2 uncommitted files in ${path}`)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Delete worktree' }));
  expect(await screen.findByText('draft.txt')).toBeInTheDocument();
  expect(screen.getByText('notes.txt')).toBeInTheDocument();
  expect(mockRemoveWorktree).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete worktree and lose changes' }));
  await waitFor(() => expect(mockRemoveWorktree).toHaveBeenCalledWith({ path, workbenchId: 'local-1', force: true }));
  await waitFor(() => expect(useWorkbenchStore.getState().workbenches['local-1'].keptWorktree).toBeNull());
});

it('does not offer a worktree action for another computer', () => {
  mockRows = [{ ...mockFailed, runtime: 'local', deviceId: 'other-device', localPath: '/other/mac/worktree',
    keptWorktree: { reason: 'uncommitted', files: 1, path: '/other/mac/worktree', names: ['draft.txt'] } }];
  useWorkbenchStore.setState({ workspaceId: 'ws', listLoaded: true, listError: null });
  render(<HistoryView />);
  expect(screen.queryByRole('button', { name: 'Delete worktree' })).not.toBeInTheDocument();
  expect(mockInspect).not.toHaveBeenCalled();
});
