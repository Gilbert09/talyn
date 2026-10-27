import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import { HistoryView } from '../renderer/pages/HistoryView';
import { useWorkbenchStore } from '../renderer/stores/workbenches';

const mockArchive = jest.fn();
const mockRestore = jest.fn();
const mockFailed = { id: 'archive-failed', workspaceId: 'ws', name: 'Oslo', repoFullName: 'o/r', branch: 'work', baseBranch: 'main',
  status: 'archiveError', statusMessage: 'Access was revoked.', archivedAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z' } as Workbench;
jest.mock('../renderer/lib/api', () => ({ api: { workbenches: {
  archive: (...args: unknown[]) => mockArchive(...args), restore: (...args: unknown[]) => mockRestore(...args),
} } }));
jest.mock('../renderer/components/workbench/workbenchSelectors', () => ({
  isArchived: (wb: Workbench) => Boolean(wb.archivedAt), useWorkspaceWorkbenches: () => [mockFailed],
}));
jest.mock('../renderer/components/workbench/WorkbenchBadges', () => ({ PrPill: () => null }));

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
