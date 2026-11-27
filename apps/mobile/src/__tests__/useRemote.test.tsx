import { act, renderHook } from '@testing-library/react-native';

import { useRemote } from '../features/more/useRemote';

const mockLife = { activity: 'active', reachability: 'online' };
const mockLifecycle = { subscribe: () => () => {}, getSnapshot: () => mockLife };
jest.mock('../auth/AuthProvider', () => ({ useMobileRuntime: () => ({ lifecycle: mockLifecycle }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

it.each(['resolve', 'reject'] as const)('ignores an old read that later calls %s', async (outcome) => {
  const old = deferred<string>();
  const load = jest.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce('new');
  const { result } = await renderHook(() => useRemote('prefs', load));
  await act(async () => result.current.refresh());
  await act(async () => {
    if (outcome === 'resolve') old.resolve('old');
    else old.reject(new Error('Unavailable'));
  });
  expect(result.current).toMatchObject({ data: 'new', status: 'ready', refreshing: false });
});

it('keeps an edit when a previous refresh finishes', async () => {
  const old = deferred<string>();
  const load = jest.fn().mockResolvedValueOnce('initial').mockReturnValueOnce(old.promise);
  const { result } = await renderHook(() => useRemote<string>('prefs', load));
  await act(async () => { void result.current.refresh(); });
  await act(async () => result.current.mutate(() => 'edited'));
  await act(async () => old.resolve('old'));
  expect(result.current).toMatchObject({ data: 'edited', refreshing: false });
});

it('keeps the initial read when there is no data to edit', async () => {
  const initial = deferred<string>();
  const { result } = await renderHook(() => useRemote<string>('prefs', () => initial.promise));
  await act(async () => result.current.mutate(() => 'ignored'));
  await act(async () => initial.resolve('initial'));
  expect(result.current).toMatchObject({ data: 'initial', status: 'ready', refreshing: false });
});

it('ignores a completed edit from a previous account', async () => {
  const { result, rerender } = await renderHook(({ user }: { user: string }) => useRemote(user, async () => user), {
    initialProps: { user: 'first' },
  });
  const oldMutate = result.current.mutate;
  await rerender({ user: 'second' });
  await act(async () => oldMutate(() => 'first edit'));
  expect(result.current.data).toBe('second');
});
