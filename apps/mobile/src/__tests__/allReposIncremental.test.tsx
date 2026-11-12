import type { GitHubRepo, LoadAllReposOptions } from '@talyn/client/native';
import { act, renderHook } from '@testing-library/react-native';

jest.mock('@talyn/client/native', () => ({ ...jest.requireActual('@talyn/client/native'), loadAllRepos: jest.fn() }));
jest.mock('../auth/AuthProvider', () => ({ useMobileRuntime: jest.fn() }));
jest.mock('../workflow/hooks', () => ({ useResource: jest.fn() }));
jest.mock('../features/more/useRemote', () => ({ useRemote: jest.fn() }));

import { loadAllRepos } from '@talyn/client/native';
import { clearRepoCache, useAllRepos } from '../features/repositories/data';

const repo = (fullName: string, id: number) =>
  ({ id, name: fullName.split('/')[1], full_name: fullName, private: false, owner: { login: fullName.split('/')[0] } }) as GitHubRepo;
const names = (repos: GitHubRepo[]) => repos.map((item) => item.full_name);

let progress: LoadAllReposOptions['onProgress'];
let finish: (repos: GitHubRepo[]) => void;
let fail: (err: Error) => void;

beforeEach(() => {
  clearRepoCache();
  jest.mocked(loadAllRepos).mockReset().mockImplementation((_ws, options) => {
    progress = options?.onProgress;
    return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  });
});

it('shows each page before the whole list has loaded', async () => {
  const { result } = await renderHook(() => useAllRepos('ws1'));
  expect(result.current.firstLoad).toBe(true);
  expect(result.current.loading).toBe(true);

  await act(() => progress?.([repo('me/first', 1)]));
  expect(result.current.firstLoad).toBe(false);
  expect(result.current.loading).toBe(true);
  expect(result.current.fetchedAt).toBeNull();
  expect(names(result.current.repos)).toEqual(['me/first']);

  await act(async () => finish([repo('me/first', 1), repo('acme/second', 2)]));
  expect(result.current.loading).toBe(false);
  expect(result.current.fetchedAt).not.toBeNull();
  expect(names(result.current.repos)).toEqual(['me/first', 'acme/second']);
});

it('keeps the shown repositories and reports a failure when the load fails part way', async () => {
  const { result } = await renderHook(() => useAllRepos('ws1'));
  await act(() => progress?.([repo('me/first', 1)]));
  await act(async () => fail(new Error('GitHub is down')));
  expect(result.current.failed).toBe(true);
  expect(result.current.loading).toBe(false);
  expect(names(result.current.repos)).toEqual(['me/first']);
});

it('keeps the cached list on screen during a refresh and replaces it at the end', async () => {
  const { result } = await renderHook(() => useAllRepos('ws1'));
  await act(async () => finish([repo('me/cached', 9)]));

  await act(async () => { void result.current.refresh(); });
  await act(() => progress?.([repo('me/new', 1)]));
  expect(names(result.current.repos)).toEqual(['me/cached', 'me/new']);

  await act(async () => finish([repo('me/new', 1)]));
  expect(names(result.current.repos)).toEqual(['me/new']);
});

it('stops a load when the workspace changes', async () => {
  const { result, rerender } = await renderHook(({ ws }: { ws: string }) => useAllRepos(ws), { initialProps: { ws: 'ws1' } });
  const first = jest.mocked(loadAllRepos).mock.calls[0][1];
  const finishFirst = finish;

  await rerender({ ws: 'ws2' });
  expect(first?.isCancelled?.()).toBe(true);
  await act(async () => finishFirst([repo('old/repo', 1)]));
  expect(names(result.current.repos)).toEqual([]);
  expect(result.current.loading).toBe(true);
});
