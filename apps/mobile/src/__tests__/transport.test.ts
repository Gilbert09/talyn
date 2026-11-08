import { createAuthFetch } from '../auth/transport';

const url = 'https://supabase.test/auth/v1/token?grant_type=refresh_token';
describe('auth service failure handling', () => {
  it.each([
    [400, 'refresh_token_not_found', true], [401, 'session_expired', true],
    [400, 'refresh_token_already_used', true], [403, 'session_not_found', true],
    [503, 'unexpected_failure', false], [401, 'unexpected_failure', false], [429, 'over_request_rate_limit', false],
  ])('handles status %s and code %s', async (status, code, explicit) => {
    const rejected = jest.fn();
    const fetcher = jest.fn(async () => new Response(JSON.stringify({ code }), { status }));
    const response = await createAuthFetch(fetcher, rejected)(url);
    await Promise.resolve();
    expect(response.status).toBe(explicit ? status : 503); expect(rejected).toHaveBeenCalledTimes(explicit ? 1 : 0);
  });
  it('does not change exchange or logout responses', async () => {
    const rejected = jest.fn(); const fetcher = jest.fn(async () => new Response('{}', { status: 400 }));
    const response = await createAuthFetch(fetcher, rejected)('https://supabase.test/auth/v1/token?grant_type=pkce');
    expect(response.status).toBe(400); expect(rejected).not.toHaveBeenCalled();
  });
  it('aborts a stalled request and releases the timer', async () => {
    jest.useFakeTimers();
    try {
      let signal: AbortSignal | null | undefined;
      const fetcher = jest.fn(async (_input, init) => { signal = init?.signal; return new Response('{}'); }) as jest.MockedFunction<typeof fetch>;
      await createAuthFetch(fetcher, jest.fn())(url);
      expect(jest.getTimerCount()).toBe(0); expect(signal?.aborted).toBe(false);
      const pending = new Promise<Response>((resolve) => {
        fetcher.mockImplementationOnce(async (_input, init) => {
          signal = init?.signal;
          signal?.addEventListener('abort', () => resolve(new Response('{}', { status: 503 })));
          return pending;
        });
      });
      const request = createAuthFetch(fetcher, jest.fn())(url);
      const failure = expect(request).rejects.toThrow('Authentication request could not finish.');
      await jest.advanceTimersByTimeAsync(15_000); await failure;
      expect(signal?.aborted).toBe(true); expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });
});

it('times out when response headers arrive but the body stalls', async () => {
  jest.useFakeTimers();
  try {
    const response = new Response('{}');
    response.text = () => new Promise<string>(() => {});
    const request = createAuthFetch(jest.fn(async () => response), jest.fn())(url);
    const failure = expect(request).rejects.toThrow('Authentication request could not finish.');
    await jest.advanceTimersByTimeAsync(15_000); await failure;
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
it('does not use a rejection response that arrives after timeout', async () => {
  jest.useFakeTimers();
  try {
    let resolve!: (response: Response) => void;
    const rejected = jest.fn();
    const fetcher = jest.fn(() => new Promise<Response>((done) => { resolve = done; }));
    const request = createAuthFetch(fetcher, rejected)(url);
    const failure = expect(request).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(15_000); await failure;
    resolve(new Response(JSON.stringify({ code: 'refresh_token_not_found' }), { status: 400 }));
    await Promise.resolve(); await Promise.resolve();
    expect(rejected).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});
