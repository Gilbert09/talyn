import { isRefreshRejection } from './controller';

export function createAuthFetch(fetcher: typeof fetch, rejected: () => void): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    let fail!: (error: Error) => void;
    const interrupted = new Promise<never>((_, reject) => { fail = reject; });
    const abort = () => {
      controller.abort();
      fail(new Error('Authentication request could not finish.'));
    };
    init?.signal?.addEventListener('abort', abort, { once: true });
    if (init?.signal?.aborted) abort();
    const timer = setTimeout(abort, 15_000);
    try {
      const request = async () => {
        const response = await fetcher(input, { ...init, signal: controller.signal });
        // Keep the deadline active while the auth response body downloads.
        const body = await response.text();
        if (controller.signal.aborted) throw new Error('Authentication request could not finish.');
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname.endsWith('/auth/v1/token') && url.searchParams.get('grant_type') === 'refresh_token' && !response.ok) {
          let error: { code?: string; error_code?: string } = {};
          try { error = JSON.parse(body) ?? {}; } catch { /* Treat unknown service failures as transient. */ }
          if (isRefreshRejection({ name: 'AuthApiError', code: error.code ?? error.error_code, status: response.status })) {
            // Leave the Supabase lock before account cleanup starts.
            queueMicrotask(rejected);
          } else {
            return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
          }
        }
        return new Response(response.status === 204 ? null : body, {
          status: response.status, statusText: response.statusText, headers: response.headers,
        });
      };
      return await Promise.race([request(), interrupted]);
    } finally {
      clearTimeout(timer);
      init?.signal?.removeEventListener('abort', abort);
    }
  };
}
