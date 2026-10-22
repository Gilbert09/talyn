/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import { LinkPullRequestDialog } from '../renderer/components/workbench/LinkPullRequestDialog';
import { api } from '../renderer/lib/api';
import { useWorkbenchStore } from '../renderer/stores/workbenches';

jest.mock('../renderer/lib/api', () => ({
  api: { workbenches: { openPullRequests: jest.fn(), linkPullRequest: jest.fn(), get: jest.fn() } },
}));
const wb = { id: 'wb1', runtime: 'sandbox', repoFullName: 'acme/app', branch: 'feature' } as Workbench;
const pr = { number: 7, title: 'Add search', headRef: 'feature/search', author: 'alice', draft: true, updatedAt: '', state: 'open' as const };

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(api.workbenches.openPullRequests).mockResolvedValue([pr]);
  jest.mocked(api.workbenches.linkPullRequest).mockResolvedValue({ workbench: { ...wb, pullRequestId: 'pr7' } });
  jest.mocked(api.workbenches.get).mockResolvedValue(wb);
});

it('shows PR details and filters with one search input', async () => {
  render(<LinkPullRequestDialog workbench={wb} onClose={jest.fn()} />);
  expect(await screen.findByText('Add search')).toBeInTheDocument();
  expect(screen.getByText('feature/search · alice')).toBeInTheDocument();
  expect(screen.getByText('Draft')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Search pull requests' }), { target: { value: 'missing' } });
  expect(screen.queryByText('Add search')).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Search pull requests' }), { target: { value: 'alice' } });
  expect(screen.getByText('Add search')).toBeInTheDocument();
});

it.each(['42', 'https://github.com/acme/app/pull/42'])('shows and links a direct row for %s', async (value) => {
  const onClose = jest.fn();
  render(<LinkPullRequestDialog workbench={wb} onClose={onClose} />);
  await screen.findByText('Add search');
  fireEvent.change(screen.getByRole('combobox', { name: 'Search pull requests' }), { target: { value } });
  fireEvent.click(screen.getByText('Link #42'));
  await waitFor(() => expect(api.workbenches.linkPullRequest).toHaveBeenCalledWith('wb1', 42));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(useWorkbenchStore.getState().workbenches.wb1.pullRequestId).toBe('pr7');
});

it('requests all states and shows a merged badge', async () => {
  jest.mocked(api.workbenches.openPullRequests).mockResolvedValue([
    { ...pr, number: 8, title: 'Merged work', draft: false, state: 'merged' },
  ]);
  render(<LinkPullRequestDialog workbench={wb} onClose={jest.fn()} />);
  await screen.findByText('Merged work');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show merged and closed' }));
  await waitFor(() => expect(api.workbenches.openPullRequests).toHaveBeenCalledWith('wb1', { state: 'all' }));
  expect(await screen.findByText('Merged')).toBeInTheDocument();
});

it('links the selected row with Enter', async () => {
  jest.mocked(api.workbenches.openPullRequests).mockResolvedValue([
    pr,
    { ...pr, number: 8, title: 'Search results', headRef: 'feature/results' },
  ]);
  render(<LinkPullRequestDialog workbench={wb} onClose={jest.fn()} />);
  await screen.findByText('Add search');
  const input = screen.getByRole('combobox', { name: 'Search pull requests' });
  fireEvent.change(input, { target: { value: 'search' } });
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(api.workbenches.linkPullRequest).toHaveBeenCalledWith('wb1', 8));
});

it('closes with Escape', async () => {
  const onClose = jest.fn();
  render(<LinkPullRequestDialog workbench={wb} onClose={onClose} />);
  const input = screen.getByRole('combobox', { name: 'Search pull requests' });
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(onClose).toHaveBeenCalled();
});

it('shows a link error inline and keeps the dialog open', async () => {
  jest.mocked(api.workbenches.linkPullRequest).mockRejectedValue(new Error('Unlink the current pull request first.'));
  const onClose = jest.fn();
  render(<LinkPullRequestDialog workbench={wb} onClose={onClose} />);
  fireEvent.click((await screen.findByText('Add search')).closest('[cmdk-item]')!);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unlink the current pull request first.');
  expect(onClose).not.toHaveBeenCalled();
});

it('rejects a URL for another repository', async () => {
  render(<LinkPullRequestDialog workbench={wb} onClose={jest.fn()} />);
  await screen.findByText('Add search');
  fireEvent.change(screen.getByRole('combobox', { name: 'Search pull requests' }), {
    target: { value: 'https://github.com/other/app/pull/7' },
  });
  expect(screen.queryByText('Link #7')).not.toBeInTheDocument();
});

it('shows a failed list load inside the list', async () => {
  jest.mocked(api.workbenches.openPullRequests).mockRejectedValue(new Error('Not found'));
  render(<LinkPullRequestDialog workbench={wb} onClose={jest.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load pull requests: Not found.');
  expect(screen.getByRole('combobox', { name: 'Search pull requests' })).toBeEnabled();
});

it('says nothing matches when the search hides every PR', async () => {
  render(<LinkPullRequestDialog workbench={wb} onClose={jest.fn()} />);
  await screen.findByText('Add search');
  fireEvent.change(screen.getByRole('combobox', { name: 'Search pull requests' }), { target: { value: 'missing' } });
  expect(screen.getByText('No pull requests match.')).toBeInTheDocument();
});
