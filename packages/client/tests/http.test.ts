import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  ApiNetworkError,
  ClientInactiveError,
  configureApiClient,
  workspaces,
  type ApiClientConfig,
} from '../src/native';
import { rawRequest } from '../src/http';
import { deferred, Lifecycle, response } from './helpers';

let lifecycle: Lifecycle;
let config: ApiClientConfig;
let token: string;
const fetchMock = vi.fn<typeof fetch>();
const recover = vi.fn<() => Promise<boolean>>();

beforeEach(() => {
  vi.useFakeTimers();
  lifecycle = new Lifecycle();
  token = 'old-token';
  fetchMock.mockReset();
  recover.mockReset().mockResolvedValue(false);
  config = {
    baseUrl: 'https://example.test///',
    clientVersion: 'native/test',
    getAccessToken: async () => token,
    recoverSession: recover,
    runtime: { lifecycle, fetch: fetchMock },
  };
  configureApiClient(config);
});
afterEach(() => {
  expect(lifecycle.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

async function outcome<T>(promise: Promise<T>) {
  const result = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  await vi.advanceTimersByTimeAsync(0);
  return { result };
}

describe('REST retry and cancellation', () => {
  it('reports a transport failure once after the retry fails', async () => {
    const report = vi.fn();
    configureApiClient({ ...config, onRequestError: report });
    fetchMock.mockRejectedValue(new Error('Failed'));
    const { result } = await outcome(workspaces.list());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ error: { name: 'ApiNetworkError' } });
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: '/workspaces' })
    );
  });

  it('does not call old error handlers after an account change', async () => {
    const report = vi.fn();
    const pendingResponse = deferred<Response>();
    configureApiClient({ ...config, onRequestError: report });
    fetchMock.mockReturnValueOnce(pendingResponse.promise);
    const { result } = await outcome(workspaces.list());
    configureApiClient({ ...config, baseUrl: 'https://new.test' });
    pendingResponse.resolve(response());
    expect(await result).toMatchObject({ error: { name: 'ClientInactiveError' } });
    expect(report).not.toHaveBeenCalled();
  });

  it('retries GET once, using the same origin and headers', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(response());
    const pending = workspaces.list();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual([]);
    expect(fetchMock.mock.calls).toEqual(
      Array(2).fill([
        'https://example.test/api/v1/workspaces',
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer old-token',
            'X-Talyn-Client-Version': 'native/test',
          },
          body: undefined,
        },
      ])
    );
  });

  it.each(['suspend', 'offline', 'configure', 'abort'] as const)(
    'cancels the pending retry on %s',
    async (action) => {
      fetchMock.mockRejectedValue(new Error('Failed'));
      const abort = new AbortController();
      const { result } = await outcome(rawRequest('GET', '/raw', { signal: abort.signal }));
      expect(vi.getTimerCount()).toBe(1);
      if (action === 'suspend') lifecycle.update({ activity: 'suspended' });
      if (action === 'offline') lifecycle.update({ reachability: 'offline' });
      if (action === 'configure') configureApiClient({ ...config, baseUrl: 'https://new.test' });
      if (action === 'abort') abort.abort(new Error('Aborted'));
      expect(vi.getTimerCount()).toBe(0);
      await expect(result).resolves.toMatchObject({
        error: { name: action === 'abort' ? 'Error' : 'ClientInactiveError' },
      });
      lifecycle.update({ activity: 'active', reachability: 'online' });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it('does not start requests while suspended', async () => {
    lifecycle.update({ activity: 'suspended' });
    await expect(workspaces.list()).rejects.toBeInstanceOf(ClientInactiveError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not replay a POST after a transport failure', async () => {
    fetchMock.mockRejectedValue(new Error('Failed'));
    await expect(workspaces.create({ name: 'Test' })).rejects.toBeInstanceOf(ApiNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['offline', 'unknown', 'online'] as const)(
    'records reachability as %s',
    async (reachability) => {
      lifecycle.update({ reachability });
      fetchMock.mockRejectedValue(new Error('Failed'));
      const { result } = await outcome(workspaces.list());
      if (reachability !== 'offline') await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toMatchObject({
        error: { name: 'ApiNetworkError', reachability, online: reachability !== 'offline' },
      });
      expect(fetchMock).toHaveBeenCalledTimes(reachability === 'offline' ? 1 : 2);
    }
  );

  it('treats absent navigator.onLine as unknown without a browser global', async () => {
    configureApiClient({ ...config, runtime: { fetch: fetchMock } });
    fetchMock.mockRejectedValue(new Error('Failed'));
    const { result } = await outcome(workspaces.list());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ error: { reachability: 'unknown' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['suspend', 'configure'] as const)(
    'discards a token lookup across %s',
    async (action) => {
      const pendingToken = deferred<string>();
      configureApiClient({ ...config, getAccessToken: () => pendingToken.promise });
      const { result } = await outcome(workspaces.list());
      if (action === 'configure') configureApiClient({ ...config, baseUrl: 'https://new.test' });
      else {
        lifecycle.update({ activity: 'suspended' });
        lifecycle.update({ activity: 'active' });
      }
      pendingToken.resolve('stale-token');
      expect(await result).toMatchObject({ error: { name: 'ClientInactiveError' } });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

describe('REST authentication recovery', () => {
  it('deduplicates concurrent 401 recovery and replays with the refreshed token', async () => {
    const refresh = deferred<boolean>();
    recover.mockReturnValue(refresh.promise);
    fetchMock
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(401))
      .mockResolvedValue(response());
    const first = workspaces.list();
    const second = workspaces.list();
    await vi.advanceTimersByTimeAsync(0);
    expect(recover).toHaveBeenCalledTimes(1);
    token = 'new-token';
    refresh.resolve(true);
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls.slice(2)) {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer new-token' });
    }
  });

  it.each(['false', 'throw', 'repeated', 'anonymous'] as const)(
    'bounds recovery when %s',
    async (failure) => {
      fetchMock.mockResolvedValue(response(401));
      if (failure === 'throw') recover.mockRejectedValue(new Error('Unavailable'));
      if (failure === 'repeated') recover.mockResolvedValue(true);
      if (failure === 'anonymous') token = '';
      await expect(workspaces.list()).rejects.toBeInstanceOf(ApiError);
      expect(fetchMock).toHaveBeenCalledTimes(failure === 'repeated' ? 2 : 1);
      expect(recover).toHaveBeenCalledTimes(failure === 'anonymous' ? 0 : 1);
    }
  );

  it.each(['suspend', 'configure'] as const)(
    'does not replay old requests when recovery completes after %s',
    async (action) => {
      const refresh = deferred<boolean>();
      recover.mockReturnValueOnce(refresh.promise);
      fetchMock.mockResolvedValueOnce(response(401)).mockResolvedValue(response());
      const { result } = await outcome(workspaces.list());
      if (action === 'suspend') {
        lifecycle.update({ activity: 'suspended' });
        lifecycle.update({ activity: 'active' });
      } else configureApiClient({ ...config, baseUrl: 'https://new.test' });
      refresh.resolve(true);
      expect(await result).toMatchObject({ error: { name: 'ClientInactiveError' } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(workspaces.list()).resolves.toEqual([]);
    }
  );

  it('keeps recovery promises separate across account changes', async () => {
    const oldRefresh = deferred<boolean>();
    recover.mockReturnValueOnce(oldRefresh.promise);
    fetchMock.mockResolvedValue(response(401));
    const { result: old } = await outcome(workspaces.list());
    const nextRecover = vi.fn(async () => false);
    configureApiClient({ ...config, recoverSession: nextRecover });
    await expect(workspaces.list()).rejects.toBeInstanceOf(ApiError);
    expect(nextRecover).toHaveBeenCalledOnce();
    oldRefresh.resolve(true);
    expect(await old).toMatchObject({ error: { name: 'ClientInactiveError' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
