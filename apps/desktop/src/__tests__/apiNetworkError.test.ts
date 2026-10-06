/**
 * @jest-environment jsdom
 */
import { ApiNetworkError, workspaces } from '../renderer/lib/api';

// No Supabase in tests — keeps getAuthToken from touching the network and lets
// us drive `request` purely through the mocked global fetch.
jest.mock('../renderer/lib/supabase', () => ({
  isSupabaseConfigured: () => false,
  getSupabase: () => {
    throw new Error('getSupabase should not be called when unconfigured');
  },
}));

/** Settle a request, running the timer that delays its transport retry. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  await jest.runAllTimersAsync();
  const result = await outcome;
  if ('error' in result) throw result.error;
  return result.value;
}

const ok = (data: unknown) =>
  ({
    status: 200,
    text: async () => JSON.stringify({ success: true, data }),
  }) as Response;

describe('request — network-error wrapping', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('wraps a transport-level fetch rejection in ApiNetworkError', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;
    await expect(settle(workspaces.list())).rejects.toBeInstanceOf(ApiNetworkError);
  });

  it('carries method, path, online state, and the original cause', async () => {
    const cause = new TypeError('Failed to fetch');
    global.fetch = jest.fn().mockRejectedValue(cause) as unknown as typeof fetch;
    expect.assertions(5);
    try {
      await settle(workspaces.list());
    } catch (e) {
      const err = e as ApiNetworkError;
      expect(err).toBeInstanceOf(ApiNetworkError);
      expect(err.method).toBe('GET');
      expect(err.path).toBe('/workspaces');
      expect(err.cause).toBe(cause);
      expect(err.message).toContain('GET /workspaces');
    }
  });

  it.each([
    [true, /backend unreachable/],
    [false, /browser is offline/],
  ])('message reflects navigator.onLine=%s', async (online, expected) => {
    Object.defineProperty(navigator, 'onLine', { value: online, configurable: true });
    global.fetch = jest
      .fn()
      .mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;
    await expect(settle(workspaces.list())).rejects.toThrow(expected);
  });

  it('does NOT wrap an HTTP error status — those resolve, not reject', async () => {
    // A 5xx with a non-JSON body is the edge-proxy outage path; it must stay the
    // existing "Backend unreachable (HTTP …)" error, not an ApiNetworkError.
    global.fetch = jest.fn().mockResolvedValue({
      status: 500,
      text: async () => 'upstream error',
    } as Response) as unknown as typeof fetch;
    await expect(workspaces.list()).rejects.toThrow(/Backend unreachable \(HTTP 500/);
  });
});

describe('request — transport retry', () => {
  // After sleep, the reconnect catch-up GETs failed with "Failed to fetch"
  // while a fresh WebSocket to the same backend had just been accepted. The
  // catch-up was lost. One retry recovers it; a real outage still throws.
  const realFetch = global.fetch;
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });
  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('retries a GET once and returns the data when the retry succeeds', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(ok([{ id: 'ws1' }]));
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(settle(workspaces.list())).resolves.toEqual([{ id: 'ws1' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('waits before the retry instead of sending it at once', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(ok([]));
    global.fetch = fetchMock as unknown as typeof fetch;
    const pending = workspaces.list();
    await jest.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws the second failure when the retry also fails', async () => {
    const second = new TypeError('Failed to fetch');
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(second);
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(settle(workspaces.list())).rejects.toMatchObject({
      name: 'ApiNetworkError',
      cause: second,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a POST, which may already have reached the server', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      settle(workspaces.create({ name: 'x' } as Parameters<typeof workspaces.create>[0]))
    ).rejects.toBeInstanceOf(ApiNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the browser is offline', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const fetchMock = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(settle(workspaces.list())).rejects.toBeInstanceOf(ApiNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
