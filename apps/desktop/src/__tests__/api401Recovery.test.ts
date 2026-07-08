/**
 * @jest-environment jsdom
 *
 * `request` 401 handling: a backend 401 must NOT immediately destroy the
 * session (the 2026-07-07 mass logout). Instead: refresh the session, retry
 * once, and only sign out when the auth server explicitly rejects the
 * refresh token.
 */
jest.mock('../renderer/lib/supabase', () => {
  // Mutable token so getSession reflects a completed refresh, like the real
  // client. Exposed via __auth for the tests to drive.
  const state = { token: 'tok-old' };
  const auth = {
    getSession: jest.fn(async () => ({
      data: { session: { access_token: state.token } },
    })),
    refreshSession: jest.fn(),
    signOut: jest.fn(async () => ({ error: null })),
  };
  return {
    isSupabaseConfigured: () => true,
    getSupabase: () => ({ auth }),
    __auth: auth,
    __state: state,
  };
});

import { workspaces, ApiError } from '../renderer/lib/api';
import { consumeLogoutReason } from '../renderer/lib/logoutReason';
import * as supabaseMock from '../renderer/lib/supabase';

const auth = (supabaseMock as unknown as {
  __auth: {
    getSession: jest.Mock;
    refreshSession: jest.Mock;
    signOut: jest.Mock;
  };
}).__auth;
const state = (supabaseMock as unknown as { __state: { token: string } }).__state;

function jsonResponse(status: number, body: unknown): Response {
  return { status, text: async () => JSON.stringify(body) } as Response;
}

const ok = (data: unknown) => jsonResponse(200, { success: true, data });
const unauthorized = () =>
  jsonResponse(401, { success: false, error: 'Invalid or expired token' });

describe('request — 401 session recovery', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    state.token = 'tok-old';
    auth.refreshSession.mockReset();
    auth.signOut.mockClear();
    auth.getSession.mockClear();
    consumeLogoutReason(); // drop anything a previous test left behind
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('refreshes and retries once on 401, without signing out', async () => {
    auth.refreshSession.mockImplementation(async () => {
      state.token = 'tok-new';
      return { data: { session: { access_token: 'tok-new' } }, error: null };
    });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(ok([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(workspaces.list()).resolves.toEqual([]);
    expect(auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(auth.signOut).not.toHaveBeenCalled();
    // The replay must carry the refreshed token.
    const retryHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer tok-new');
  });

  it('signs out (and tags the reason) only when the refresh is explicitly rejected', async () => {
    auth.refreshSession.mockResolvedValue({
      data: { session: null },
      error: { status: 400, message: 'Invalid Refresh Token' },
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue(unauthorized()) as unknown as typeof fetch;

    await expect(workspaces.list()).rejects.toBeInstanceOf(ApiError);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(consumeLogoutReason()).toBe('api_401_refresh_rejected');
  });

  it.each([
    ['a network failure (no status)', { message: 'fetch failed' }],
    ['a retryable 0 status', { status: 0, message: 'fetch failed' }],
    ['an auth-server 5xx', { status: 502, message: 'bad gateway' }],
  ])('keeps the session when the refresh hits %s', async (_label, error) => {
    auth.refreshSession.mockResolvedValue({ data: { session: null }, error });
    global.fetch = jest
      .fn()
      .mockResolvedValue(unauthorized()) as unknown as typeof fetch;

    await expect(workspaces.list()).rejects.toBeInstanceOf(ApiError);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('does not loop when the retry 401s again', async () => {
    auth.refreshSession.mockImplementation(async () => {
      state.token = 'tok-new';
      return { data: { session: { access_token: 'tok-new' } }, error: null };
    });
    const fetchMock = jest.fn().mockResolvedValue(unauthorized());
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(workspaces.list()).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // original + one retry, no more
    expect(auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('dedupes concurrent 401s into a single refresh', async () => {
    let resolveRefresh!: (v: unknown) => void;
    auth.refreshSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValue(ok([]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const first = workspaces.list();
    const second = workspaces.list();
    // Let both requests hit their 401 and join the shared recovery.
    await new Promise((r) => setTimeout(r, 0));
    state.token = 'tok-new';
    resolveRefresh({ data: { session: { access_token: 'tok-new' } }, error: null });

    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual([]);
    expect(auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('does not attempt recovery on a 503 auth_unavailable', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse(503, {
        success: false,
        error: 'Authentication is temporarily unavailable — try again shortly',
        code: 'auth_unavailable',
      })
    ) as unknown as typeof fetch;

    await expect(workspaces.list()).rejects.toMatchObject({
      status: 503,
      code: 'auth_unavailable',
    });
    expect(auth.refreshSession).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});
