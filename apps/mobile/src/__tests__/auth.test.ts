import type { Session } from '@supabase/supabase-js';

import { ATTEMPT_TTL_MS } from '../auth/callback';
import { AuthController, type AuthGateway, isRefreshRejection } from '../auth/controller';
import { SecureSessionStorage } from '../auth/storage';

const callback = 'talyn-mobile-development://auth/callback';
const session = (id = 'alice', token = 'access'): Session => ({
  access_token: token, refresh_token: 'refresh', token_type: 'bearer', expires_in: 3600,
  user: { id, email: `${id}@example.com`, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' },
});
const result = (value: Session | null = null, error: unknown = null) => ({ data: { session: value }, error });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
async function setup(restored: Session | null = null) {
  const values = new Map<string, string>(); let id = 0;
  const storage = new SecureSessionStorage({
    getItemAsync: async (key) => values.get(key) ?? null,
    setItemAsync: async (key, value) => { values.set(key, value); },
    deleteItemAsync: async (key) => { values.delete(key); },
  }, 'auth', () => `revision-${++id}`);
  const auth: jest.Mocked<AuthGateway> = {
    getSession: jest.fn(async () => result(restored)), refreshSession: jest.fn(async () => result(restored)),
    signInWithOAuth: jest.fn<ReturnType<AuthGateway['signInWithOAuth']>, Parameters<AuthGateway['signInWithOAuth']>>(async () => {
      await storage.setItem('session-code-verifier', 'library-verifier');
      return { data: { url: 'https://supabase.test/auth/v1/authorize?state=library-state' }, error: null };
    }),
    exchangeCodeForSession: jest.fn<ReturnType<AuthGateway['exchangeCodeForSession']>, Parameters<AuthGateway['exchangeCodeForSession']>>(async () => result(session())), signOut: jest.fn<ReturnType<AuthGateway['signOut']>, Parameters<AuthGateway['signOut']>>(async () => ({ error: null })),
    startAutoRefresh: jest.fn(), stopAutoRefresh: jest.fn(),
  };
  const response = deferred<{ type: string; url?: string }>();
  const browser = { open: jest.fn(() => response.promise), dismiss: jest.fn() };
  const boundary = jest.fn(async () => {});
  let now = 1000;
  const make = () => new AuthController(auth, storage, browser, callback, boundary, () => now);
  const controller = make(); await controller.restore();
  const begin = async () => {
    const task = controller.signIn();
    for (let i = 0; i < 80 && !browser.open.mock.calls.length; i++) await Promise.resolve();
    return { task };
  };
  return { auth, storage, browser, response, controller, begin, boundary, values, make, advance: () => { now += ATTEMPT_TTL_MS; } };
}

describe('native authentication', () => {
  it('restores without exposing credentials in the UI snapshot', async () => {
    const { controller } = await setup(session());
    expect(controller.getSnapshot()).toEqual({ status: 'signedIn', user: { id: 'alice', email: 'alice@example.com' }, issue: null });
    expect(await controller.getAccessToken()).toBe('access');
  });
  it('serializes sign-in and lets Supabase own OAuth state', async () => {
    const { controller, auth, begin, response } = await setup();
    const { task } = await begin();
    expect(controller.signIn()).toBe(task);
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({ provider: 'github', options: { redirectTo: callback, skipBrowserRedirect: true } });
    response.resolve({ type: 'success', url: `${callback}?code=code` }); await task;
    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().status).toBe('signedIn');
  });
  it.each(['cancel', 'dismiss'])('handles browser %s', async (type) => {
    const { begin, response, controller, storage } = await setup();
    const { task } = await begin(); response.resolve({ type }); await task;
    expect(controller.getSnapshot()).toMatchObject({ status: 'signedOut', issue: 'cancelled' });
    expect(await storage.getItem('session-code-verifier')).toBeNull();
  });
  it('handles timeout and dismisses the browser', async () => {
    jest.useFakeTimers();
    try {
      const { begin, controller, browser } = await setup(); const { task } = await begin();
      await jest.advanceTimersByTimeAsync(ATTEMPT_TTL_MS); await task;
      expect(controller.getSnapshot().issue).toBe('timeout'); expect(browser.dismiss).toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });
  it('exchanges warm duplicate callbacks once', async () => {
    const { begin, controller, auth, response } = await setup(); const { task } = await begin();
    const exchange = controller.handleCallback(`${callback}?code=code`);
    expect(controller.handleCallback(`${callback}?code=code`)).toBe(exchange);
    await exchange; response.resolve({ type: 'success', url: `${callback}?code=code` }); await task;
    await controller.handleCallback(`${callback}?code=code`);
    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
  });
  it.each(['other://auth/callback?code=secret', 'talyn-mobile-development://auth/wrong?code=secret'])('rejects unexpected callback %s', async (url) => {
    const { begin, response, controller, auth } = await setup(); const { task } = await begin();
    response.resolve({ type: 'success', url }); await task;
    expect(controller.getSnapshot().issue).toBe('invalid'); expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });
  it.each(['expired', 'exchange failure'])('clears a failed attempt: %s', async (failure) => {
    const { begin, response, controller, auth, advance, storage } = await setup(); const { task } = await begin();
    if (failure === 'expired') advance(); else auth.exchangeCodeForSession.mockResolvedValue(result(null, new Error('secret')));
    response.resolve({ type: 'success', url: `${callback}?code=code` }); await task;
    expect(controller.getSnapshot().status).toBe('signedOut');
    expect(await storage.getItem('attempt')).toBeNull();
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('secret');
  });
  it('accepts a cold callback only for a persisted attempt and verifier', async () => {
    const { make, storage, auth } = await setup();
    await storage.setItem('attempt', JSON.stringify({ callback, startedAt: 1000, phase: 'awaiting' }));
    await storage.setItem('session-code-verifier', 'verifier');
    const restarted = make(); await restarted.restore(); await restarted.handleCallback(`${callback}?code=code`);
    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1); expect(restarted.getSnapshot().status).toBe('signedIn');
  });
  it.each(['missing verifier', 'exchanging', 'expired', 'missing attempt'])('requires a fresh sign-in after restart: %s', async (kind) => {
    const { make, storage, auth, advance } = await setup();
    if (kind !== 'missing attempt') await storage.setItem('attempt', JSON.stringify({ callback, startedAt: 1000, phase: kind === 'exchanging' ? 'exchanging' : 'awaiting' }));
    if (kind !== 'missing verifier') await storage.setItem('session-code-verifier', 'verifier');
    if (kind === 'expired') advance();
    const restarted = make(); await restarted.restore(); await restarted.handleCallback(`${callback}?code=code`);
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled(); expect(restarted.getSnapshot().issue).toBe('expired');
  });
  it('deduplicates refresh and retains the account during an auth outage', async () => {
    const { controller, auth } = await setup(session());
    const pending = deferred<ReturnType<typeof result>>(); auth.refreshSession.mockReturnValue(pending.promise);
    const first = controller.recoverSession(); expect(controller.recoverSession()).toBe(first);
    pending.resolve(result(null, { name: 'AuthRetryableFetchError', status: 503 }));
    expect(await first).toBe(false); expect(auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ status: 'signedIn', issue: 'outage' });
    expect(auth.signOut).not.toHaveBeenCalled();
    auth.refreshSession.mockResolvedValue(result(session('alice', 'fresh')));
    expect(await controller.recoverSession()).toBe(true);
  });
  it.each(['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired'])('cleans up on explicit refresh rejection: %s', async (code) => {
    const { controller, auth, boundary, values } = await setup(session());
    auth.refreshSession.mockResolvedValue(result(null, { name: 'AuthApiError', code, status: 400 }));
    expect(await controller.recoverSession()).toBe(false); await controller.signOut();
    expect(controller.getSnapshot().status).toBe('signedOut'); expect(boundary).toHaveBeenCalledWith('alice'); expect(values.size).toBe(0);
  });
  it.each([new Error('timeout'), { name: 'AuthApiError', status: 500 }, { name: 'AuthApiError', status: 401, code: 'unexpected_failure' }])('does not classify a transient error as rejection: %s', (error) => {
    expect(isRefreshRejection(error)).toBe(false);
  });
  it('invalidates a stale token lookup when the account signs out', async () => {
    const { controller, auth } = await setup(session());
    const pending = deferred<ReturnType<typeof result>>(); auth.getSession.mockReturnValue(pending.promise);
    const token = controller.getAccessToken(); const cleanup = controller.signOut();
    pending.resolve(result(session())); await cleanup;
    expect(await token).toBeNull(); expect(controller.getSnapshot().user).toBeNull();
    controller.authEvent('TOKEN_REFRESHED', session()); expect(controller.getSnapshot().user).toBeNull();
  });
  it('does not return another account token or accept its refresh', async () => {
    const { controller, auth } = await setup(session());
    auth.getSession.mockResolvedValue(result(session('bob'))); expect(await controller.getAccessToken()).toBeNull();
    auth.refreshSession.mockResolvedValue(result(session('bob'))); expect(await controller.recoverSession()).toBe(false);
    await controller.signOut(); expect(controller.getSnapshot().user).toBeNull();
  });
  it('does not restore an account from an exchange after logout', async () => {
    const { begin, controller, auth, response, values } = await setup(); const { task } = await begin();
    const pending = deferred<ReturnType<typeof result>>(); auth.exchangeCodeForSession.mockReturnValue(pending.promise);
    const exchange = controller.handleCallback(`${callback}?code=code`);
    for (let i = 0; i < 80 && !auth.exchangeCodeForSession.mock.calls.length; i++) await Promise.resolve();
    const cleanup = controller.signOut(); pending.resolve(result(session())); response.resolve({ type: 'dismiss' });
    await Promise.all([task, exchange, cleanup]);
    expect(controller.getSnapshot().status).toBe('signedOut'); expect(values.size).toBe(0);
  });
  it('cleans secure storage if the remote logout fails', async () => {
    const { controller, auth, storage, values } = await setup(session());
    await storage.setItem('session', 'secret'); auth.signOut.mockRejectedValue(new Error('offline'));
    await controller.signOut(); expect(values.size).toBe(0); expect(controller.getSnapshot().status).toBe('signedOut');
  });
});

it('does not treat a missing local session as explicit refresh rejection', async () => {
  const { controller, auth } = await setup(session());
  auth.getSession.mockResolvedValue(result());
  expect(await controller.getAccessToken()).toBeNull();
  expect(controller.getSnapshot()).toMatchObject({ status: 'locked', issue: 'storage' });
  expect(auth.signOut).not.toHaveBeenCalled();
});

it('restarts foreground refresh after a new sign-in', async () => {
  const { controller, auth, begin, response } = await setup();
  controller.setActive(true);
  expect(auth.startAutoRefresh).not.toHaveBeenCalled();
  const { task } = await begin(); response.resolve({ type: 'success', url: `${callback}?code=code` }); await task;
  expect(auth.startAutoRefresh).toHaveBeenCalledTimes(1);
});

it('retries incomplete logout cleanup without restoring the old account', async () => {
  const { controller, boundary, auth } = await setup(session());
  boundary.mockRejectedValueOnce(new Error('preference storage unavailable'));
  await controller.signOut(); expect(controller.getSnapshot().status).toBe('locked');
  await controller.restore(); expect(controller.getSnapshot().status).toBe('signedOut');
  expect(boundary).toHaveBeenLastCalledWith('alice');
  expect(auth.getSession).toHaveBeenCalledTimes(1);
});

it('ignores a rejection callback from a disposed runtime', async () => {
  const { controller, boundary } = await setup(session()); boundary.mockClear(); controller.dispose();
  await controller.signOut(); expect(boundary).not.toHaveBeenCalled();
});

it('clears pending secure data when the person cancels sign-in', async () => {
  const { controller, begin, values } = await setup(); const { task } = await begin();
  controller.cancelSignIn(); await task; await controller.signOut();
  expect(controller.getSnapshot()).toMatchObject({ status: 'signedOut', issue: 'cancelled' });
  expect(values.size).toBe(0);
});
it('waits for refresh completion before logout cleanup', async () => {
  const { controller, auth, storage, values } = await setup(session());
  const pending = deferred<ReturnType<typeof result>>();
  auth.refreshSession.mockImplementation(async () => {
    const response = await pending.promise;
    await storage.setItem('session', 'late rotated session'); return response;
  });
  const refresh = controller.recoverSession(); const cleanup = controller.signOut();
  pending.resolve(result(session('alice', 'rotated'))); await Promise.all([refresh, cleanup]);
  expect(values.size).toBe(0); expect(controller.getSnapshot().user).toBeNull();
});
it('stops a pending refresh start after suspension', async () => {
  const { controller, auth } = await setup(session());
  const pending = deferred<void>(); auth.startAutoRefresh.mockReturnValue(pending.promise);
  controller.setActive(true);
  for (let i = 0; i < 20 && !auth.startAutoRefresh.mock.calls.length; i++) await Promise.resolve();
  controller.setActive(false); pending.resolve();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(auth.startAutoRefresh).toHaveBeenCalledTimes(1);
  expect(auth.stopAutoRefresh).toHaveBeenCalled();
});

it('does not sign out from an event without auth-service rejection', async () => {
  const { controller, auth } = await setup(session()); controller.authEvent('SIGNED_OUT', null);
  expect(controller.getSnapshot().status).toBe('signedIn'); expect(auth.signOut).not.toHaveBeenCalled();
});
