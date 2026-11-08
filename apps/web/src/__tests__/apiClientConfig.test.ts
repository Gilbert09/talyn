import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../lib/env', () => ({
  API_URL: 'https://configured.test/',
  CLIENT_VERSION: 'web/config-test',
}));
vi.mock('../lib/apiErrorAnalytics', () => ({ reportApiError: vi.fn() }));
vi.mock('../lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: () => ({ auth }),
}));

const { auth, session } = vi.hoisted(() => {
  const state = { token: 'old-token' };
  return {
    session: state,
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: state.token } } })),
      refreshSession: vi.fn(async () => {
        state.token = 'new-token';
        return { data: { session: { access_token: state.token } }, error: null };
      }),
      signOut: vi.fn(),
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('uses the web host URL, version, and token recovery with the shared client', async () => {
  session.token = 'old-token';
  await import('../lib/apiClient');
  const { api, getApiBaseUrl } = await import('../lib/api');
  const response = (status: number) => ({
    status,
    ok: status === 200,
    text: async () =>
      JSON.stringify(
        status === 200 ? { success: true, data: [] } : { success: false, error: 'Unauthorized' }
      ),
  });
  const fetchMock = vi.fn().mockResolvedValueOnce(response(401)).mockResolvedValue(response(200));
  vi.stubGlobal('fetch', fetchMock);
  expect(getApiBaseUrl()).toBe('https://configured.test');
  await expect(api.workspaces.list()).resolves.toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(auth.refreshSession).toHaveBeenCalledOnce();
  expect(auth.signOut).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls[0]).toEqual([
    'https://configured.test/api/v1/workspaces',
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer old-token',
        'X-Talyn-Client-Version': 'web/config-test',
      }),
    }),
  ]);
  expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer new-token');
});
