import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RepositoriesSettings } from '../renderer/components/settings/sections/RepositoriesSettings';

const detect = jest.fn();
const uniqueMain = jest.fn();
const set = jest.fn();
const get = jest.fn();
const getScanRoots = jest.fn();
const addScanRoot = jest.fn();
const removeScanRoot = jest.fn();
let saved: Record<string, string> = {};

jest.mock('../renderer/lib/workbenchBridge', () => ({
  getWorkbenchBridge: () => ({
    repoPaths: {
      get, set, detect, uniqueMain, remove: jest.fn(), homeDir: '/Users/tom',
      scanRoots: { get: getScanRoots, add: addScanRoot, remove: removeScanRoot },
    },
    readConfig: jest.fn().mockResolvedValue(null),
  }),
}));
jest.mock('../renderer/components/workbench/new/useRepoPaths', () => ({
  useRepoPaths: () => ({ paths: saved, ready: true, available: true, pickFolder: jest.fn() }),
}));
jest.mock('../renderer/pages/NewWorkbenchPage', () => ({
  localPathFor: (paths: Record<string, string>, name: string) =>
    Object.entries(paths).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null,
}));
jest.mock('../renderer/hooks/useGithubInstallations', () => ({
  useGithubInstallations: () => ({ installations: [], checked: false, loading: false, refresh: jest.fn() }),
}));
jest.mock('../renderer/hooks/useApi', () => ({
  useWorkspaceActions: () => ({ refreshWorkspaces: jest.fn() }),
}));
jest.mock('../renderer/components/widgets/PollingOnlyBadge', () => ({ PollingOnlyBadge: () => null }));
jest.mock('../renderer/components/widgets/GithubInstallStatus', () => ({ GithubInstallStatus: () => null }));
jest.mock('../renderer/lib/api', () => ({
  api: {
    repositories: { list: jest.fn().mockResolvedValue([]), forcePoll: jest.fn().mockResolvedValue(undefined) },
    github: { getStatus: jest.fn().mockResolvedValue({ connected: false }) },
  },
}));
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) => selector({
    currentWorkspaceId: 'ws',
    repositories: [{ id: 'r1', owner: 'PostHog', fullName: 'PostHog/posthog' }],
    setRepositories: jest.fn(),
  }),
}));

beforeEach(() => {
  saved = {};
  get.mockImplementation(async () => ({ ...saved }));
  set.mockImplementation(async ({ repoFullName, path, ifMissing }) => {
    if (!ifMissing || !saved[repoFullName]) saved[repoFullName] = path;
    return { ...saved };
  });
  uniqueMain.mockResolvedValue({});
  getScanRoots.mockResolvedValue([]);
  addScanRoot.mockResolvedValue(null);
  removeScanRoot.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

test('saves one detected checkout and marks it as found', async () => {
  detect.mockResolvedValue({ 'PostHog/posthog': ['/Users/tom/dev/posthog'] });
  render(<RepositoriesSettings />);
  await waitFor(() => expect(set).toHaveBeenCalledWith({
    repoFullName: 'PostHog/posthog', path: '/Users/tom/dev/posthog', ifMissing: true,
  }));
  expect(await screen.findByText('Found automatically')).toBeInTheDocument();
  expect(screen.getByTitle('/Users/tom/dev/posthog')).toBeInTheDocument();
});

test('shows several checkouts and saves the selected path', async () => {
  detect.mockResolvedValue({ 'PostHog/posthog': ['/Users/tom/dev/posthog', '/Users/tom/work/posthog'] });
  render(<RepositoriesSettings />);
  expect(await screen.findByText('Found 2 checkouts')).toBeInTheDocument();
  const select = screen.getByRole('combobox', { name: 'Choose checkout for PostHog/posthog' });
  expect(screen.getByRole('option', { name: '~/dev/posthog' })).toBeInTheDocument();
  fireEvent.change(select, { target: { value: '/Users/tom/work/posthog' } });
  await waitFor(() => expect(set).toHaveBeenCalledWith({
    repoFullName: 'PostHog/posthog', path: '/Users/tom/work/posthog',
  }));
  expect(screen.getByTitle('/Users/tom/work/posthog')).toBeInTheDocument();
});

test('does not detect or replace a saved path', async () => {
  saved = { 'posthog/POSTHOG': '/Users/tom/my-checkout' };
  render(<RepositoriesSettings />);
  expect(screen.getByTitle('/Users/tom/my-checkout')).toBeInTheDocument();
  await waitFor(() => expect(get).toHaveBeenCalled());
  expect(detect).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
});

test('saves the only main checkout when worktrees also exist', async () => {
  detect.mockResolvedValue({ 'PostHog/posthog': ['/Users/tom/dev/posthog', '/Users/tom/work/posthog'] });
  uniqueMain.mockResolvedValue({ 'PostHog/posthog': '/Users/tom/dev/posthog' });
  render(<RepositoriesSettings />);
  await waitFor(() => expect(set).toHaveBeenCalledWith({
    repoFullName: 'PostHog/posthog', path: '/Users/tom/dev/posthog', ifMissing: true,
  }));
  expect(screen.queryByText('Found 2 checkouts')).not.toBeInTheDocument();
});

test('checks again when Refresh is pressed', async () => {
  detect.mockResolvedValue({});
  render(<RepositoriesSettings />);
  await waitFor(() => expect(detect).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByTitle('Check for updates now'));
  await waitFor(() => expect(detect).toHaveBeenCalledTimes(2));
});

test.each([
  '/Users/tom/Documents/work',
  '/Volumes/Projects',
])('adds scan root %s and checks again', async (root) => {
  detect.mockResolvedValue({});
  addScanRoot.mockResolvedValue([root]);
  render(<RepositoriesSettings />);
  await waitFor(() => expect(detect).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Scan another folder…' }));
  await waitFor(() => expect(addScanRoot).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(detect).toHaveBeenCalledTimes(2));
  expect(screen.getByText(root.startsWith('/Users/tom/') ? root.replace('/Users/tom', '~') : root)).toBeInTheDocument();
});

test('removes a scan root', async () => {
  getScanRoots.mockResolvedValue(['/Users/tom/Documents/work']);
  removeScanRoot.mockResolvedValue([]);
  detect.mockResolvedValue({});
  render(<RepositoriesSettings />);
  fireEvent.click(await screen.findByRole('button', { name: 'Stop scanning /Users/tom/Documents/work' }));
  await waitFor(() => expect(removeScanRoot).toHaveBeenCalledWith('/Users/tom/Documents/work'));
  await waitFor(() => expect(screen.queryByText('Also scanning:')).not.toBeInTheDocument());
});
