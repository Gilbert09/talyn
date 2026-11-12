import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { loadAllRepos, type GitHubRepo, type LoadAllReposOptions } from '../renderer/lib/api';
import { WatchReposStep } from '../renderer/components/onboarding/steps/WatchReposStep';
import { useWorkspaceStore } from '../renderer/stores/workspace';

jest.mock('../renderer/lib/api', () => {
  const actual = jest.requireActual<typeof import('@talyn/client')>('@talyn/client');
  return {
    loadAllRepos: jest.fn(),
    mergeRepos: actual.mergeRepos,
    api: {
      github: { listInstallations: jest.fn().mockResolvedValue([]) },
      repositories: { add: jest.fn(), remove: jest.fn() },
      workspaces: { list: jest.fn().mockResolvedValue([]) },
    },
  };
});

const repo = (fullName: string, id: number) =>
  ({ id, name: fullName.split('/')[1], full_name: fullName, private: false, owner: { login: fullName.split('/')[0] } }) as GitHubRepo;

let progress: LoadAllReposOptions['onProgress'];
let finish: (repos: GitHubRepo[]) => void;
let fail: (err: Error) => void;

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ repositories: [], workspaces: [] });
  jest.mocked(loadAllRepos).mockReset().mockImplementation((_ws, options) => {
    progress = options?.onProgress;
    return new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  });
});
afterEach(cleanup);

it('shows each page of repositories before the whole list has loaded', async () => {
  render(<WatchReposStep workspaceId="ws1" />);
  expect(await screen.findByText('Loading your repositories from GitHub…')).toBeInTheDocument();

  act(() => progress?.([repo('me/first', 1)]));
  expect(screen.getByText('me/first')).toBeInTheDocument();
  expect(screen.queryByText('Loading your repositories from GitHub…')).not.toBeInTheDocument();
  expect(screen.getByText(/Loading more… 1 found so far\./)).toBeInTheDocument();

  act(() => progress?.([repo('me/first', 1), repo('acme/second', 2)]));
  expect(screen.getByText('acme/second')).toBeInTheDocument();
  expect(screen.getByText(/Loading more… 2 found so far\./)).toBeInTheDocument();

  await act(async () => finish([repo('me/first', 1), repo('acme/second', 2), repo('acme/third', 3)]));
  expect(screen.getByText('acme/third')).toBeInTheDocument();
  expect(screen.getByText(/Updated just now\./)).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('fastowl:github-repos:ws1')!).repos).toHaveLength(3);
});

it('keeps the repositories it showed when the load fails part way', async () => {
  render(<WatchReposStep workspaceId="ws1" />);
  await screen.findByText('Loading your repositories from GitHub…');
  act(() => progress?.([repo('me/first', 1)]));
  await act(async () => fail(new Error('GitHub is down')));
  expect(screen.getByText('me/first')).toBeInTheDocument();
  expect(localStorage.getItem('fastowl:github-repos:ws1')).toBeNull();
});

it('keeps cached repositories on screen while a stale cache refreshes', async () => {
  localStorage.setItem(
    'fastowl:github-repos:ws1',
    JSON.stringify({ repos: [repo('me/cached', 9)], fetchedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 })
  );
  render(<WatchReposStep workspaceId="ws1" />);
  expect(await screen.findByText('me/cached')).toBeInTheDocument();
  expect(screen.getByText(/Refreshing…/)).toBeInTheDocument();

  act(() => progress?.([repo('me/new', 1)]));
  expect(screen.getByText('me/cached')).toBeInTheDocument();
  expect(screen.getByText('me/new')).toBeInTheDocument();

  await act(async () => finish([repo('me/new', 1)]));
  expect(screen.queryByText('me/cached')).not.toBeInTheDocument();
});

it('ignores a load that a newer workspace replaced', async () => {
  const { rerender } = render(<WatchReposStep workspaceId="ws1" />);
  await screen.findByText('Loading your repositories from GitHub…');
  const firstFinish = finish;
  const firstOptions = jest.mocked(loadAllRepos).mock.calls[0][1];

  rerender(<WatchReposStep workspaceId="ws2" />);
  expect(firstOptions?.isCancelled?.()).toBe(true);
  await act(async () => firstFinish([repo('old/repo', 1)]));
  expect(screen.queryByText('old/repo')).not.toBeInTheDocument();
  expect(localStorage.getItem('fastowl:github-repos:ws1')).toBeNull();
});
