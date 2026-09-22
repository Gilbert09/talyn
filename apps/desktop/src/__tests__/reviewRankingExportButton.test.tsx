import '@testing-library/jest-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReviewRankingExportButton } from '../renderer/components/panels/github/ReviewRankingExportButton';
import { exportReviewRankingData } from '../renderer/components/panels/github/useReviewRankingCapture';
import type { ReviewRankingExportResult } from '../main/reviewRankingExport';

jest.mock('../renderer/components/panels/github/useReviewRankingCapture', () => ({
  exportReviewRankingData: jest.fn(),
}));

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

it.each([
  [{ status: 'saved' }, 'Ranking data saved.', 'status'],
  [{ status: 'canceled' }, 'Export canceled.', 'status'],
  [{ status: 'error', message: 'Disk full.' }, 'Disk full.', 'alert'],
] as const)('reports the actual result: %j', async (result, message, role) => {
  jest.mocked(exportReviewRankingData).mockResolvedValue(result);
  render(<ReviewRankingExportButton workspaceId="workspace" />);
  fireEvent.click(screen.getByRole('button'));
  expect(await screen.findByRole(role)).toHaveTextContent(message);
  expect(exportReviewRankingData).toHaveBeenCalledWith('workspace');
  expect(screen.getByRole('button')).toBeEnabled();
});

it('reports archive or IPC failures and permits a retry', async () => {
  jest.mocked(exportReviewRankingData).mockRejectedValueOnce(new Error('storage failure'))
    .mockResolvedValueOnce({ status: 'saved' });
  render(<ReviewRankingExportButton workspaceId="workspace" />);
  fireEvent.click(screen.getByRole('button'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not export ranking data. Try again.');
  fireEvent.click(screen.getByRole('button'));
  expect(await screen.findByRole('status')).toHaveTextContent('Ranking data saved.');
});

it('blocks duplicate clicks until the write finishes', async () => {
  let finish!: (result: ReviewRankingExportResult) => void;
  jest.mocked(exportReviewRankingData).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  render(<ReviewRankingExportButton workspaceId="workspace" />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('button')).toBeDisabled();
  fireEvent.click(screen.getByRole('button'));
  expect(exportReviewRankingData).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ status: 'saved' }); });
  expect(screen.getByRole('button')).toBeEnabled();
});
