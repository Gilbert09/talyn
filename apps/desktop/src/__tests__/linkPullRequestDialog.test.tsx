/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import { LinkPullRequestDialog } from '../renderer/components/workbench/LinkPullRequestDialog';
import { api } from '../renderer/lib/api';
import { toast } from '../renderer/stores/toast';
import { useWorkbenchStore } from '../renderer/stores/workbenches';

jest.mock('../renderer/lib/api', () => ({
  api: { workbenches: { openPullRequests: jest.fn(), linkPullRequest: jest.fn(), get: jest.fn() } },
}));
jest.mock('../renderer/stores/toast', () => ({ toast: { error: jest.fn() } }));
const wb = { id: 'wb1', runtime: 'sandbox', repoFullName: 'acme/app', branch: 'feature' } as Workbench;
const pr = { number: 7, title: 'Add search', headRef: 'feature/search', author: 'alice', draft: true, updatedAt: '' };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(api.workbenches.openPullRequests).mockResolvedValue([pr]);
  jest.mocked(api.workbenches.linkPullRequest).mockResolvedValue({ workbench: { ...wb, pullRequestId: 'pr7' } });
  jest.mocked(api.workbenches.get).mockResolvedValue(wb);
});

it('shows PR details and filters the list', async () => {
  render(<LinkPullRequestDialog workbench={wb} onClose={jest.fn()} />);
  expect(await screen.findByText('#7 Add search')).toBeInTheDocument();
  expect(screen.getByText('feature/search · alice')).toBeInTheDocument();
  expect(screen.getByText('Draft')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Filter pull requests'), { target: { value: 'missing' } });
  expect(screen.queryByText('#7 Add search')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Filter pull requests'), { target: { value: 'alice' } });
  expect(screen.getByText('#7 Add search')).toBeInTheDocument();
});

it.each(['42', 'https://github.com/acme/app/pull/42'])('links input %s and refreshes the store', async (value) => {
  const onClose = jest.fn();
  render(<LinkPullRequestDialog workbench={wb} onClose={onClose} />);
  await screen.findByText('#7 Add search');
  fireEvent.change(screen.getByLabelText('PR number or URL'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  await waitFor(() => expect(api.workbenches.linkPullRequest).toHaveBeenCalledWith('wb1', 42));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(useWorkbenchStore.getState().workbenches.wb1.pullRequestId).toBe('pr7');
});

it('shows the server message in an error toast', async () => {
  jest.mocked(api.workbenches.linkPullRequest).mockRejectedValue(new Error('Unlink the current pull request first.'));
  const onClose = jest.fn();
  render(<LinkPullRequestDialog workbench={wb} onClose={onClose} />);
  fireEvent.click(await screen.findByRole('button', { name: /#7 Add search/ }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      'Could not link the pull request',
      'Unlink the current pull request first.'
    )
  );
  expect(onClose).not.toHaveBeenCalled();
});

it('rejects a URL for another repository', async () => {
  render(<LinkPullRequestDialog workbench={wb} onClose={jest.fn()} />);
  await screen.findByText('#7 Add search');
  fireEvent.change(screen.getByLabelText('PR number or URL'), {
    target: { value: 'https://github.com/other/app/pull/7' },
  });
  expect(screen.getByRole('button', { name: 'Link' })).toBeDisabled();
});
