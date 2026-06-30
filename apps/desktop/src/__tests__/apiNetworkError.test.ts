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

describe('request — network-error wrapping', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('wraps a transport-level fetch rejection in ApiNetworkError', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;
    await expect(workspaces.list()).rejects.toBeInstanceOf(ApiNetworkError);
  });

  it('carries method, path, online state, and the original cause', async () => {
    const cause = new TypeError('Failed to fetch');
    global.fetch = jest.fn().mockRejectedValue(cause) as unknown as typeof fetch;
    expect.assertions(5);
    try {
      await workspaces.list();
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
    await expect(workspaces.list()).rejects.toThrow(expected);
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
