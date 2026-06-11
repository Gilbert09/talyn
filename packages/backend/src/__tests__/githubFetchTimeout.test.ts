import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithTimeout } from '../services/github.js';

/**
 * fetchWithTimeout must bound the WHOLE request — headers AND body. The prod
 * incident it guards against: GitHub accepted a merge, the response headers
 * arrived, the body stalled, and the old implementation (which disarmed the
 * abort timer once headers were in) hung the merge-queue tick for 5+ minutes.
 *
 * The stubs wire the fetch `signal` into the synthetic response the way real
 * undici does: aborting mid-body-read rejects the read.
 */

type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function stubFetch(impl: FetchStub): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

/** A body stream that never produces data; errors when the signal aborts. */
function hangingBody(signal: AbortSignal | null | undefined): ReadableStream {
  return new ReadableStream({
    start(controller) {
      signal?.addEventListener('abort', () =>
        controller.error(new DOMException('This operation was aborted', 'AbortError'))
      );
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchWithTimeout', () => {
  it('returns status, headers and the fully-read body text', async () => {
    stubFetch(async () =>
      new Response(JSON.stringify({ merged: true }), {
        status: 200,
        headers: { 'x-github-request-id': 'abc123' },
      })
    );
    const res = await fetchWithTimeout('https://api.github.com/test', {}, 1_000);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-github-request-id')).toBe('abc123');
    expect(JSON.parse(res.bodyText)).toEqual({ merged: true });
  });

  it('times out when the headers never arrive', async () => {
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('This operation was aborted', 'AbortError'))
          );
        })
    );
    await expect(fetchWithTimeout('https://api.github.com/slow-headers', {}, 50)).rejects.toThrow(
      /timed out after 50ms/
    );
  });

  it('times out when the body stalls after the headers arrive (the prod wedge)', async () => {
    stubFetch(async (_url, init) => new Response(hangingBody(init?.signal), { status: 200 }));
    await expect(fetchWithTimeout('https://api.github.com/slow-body', {}, 50)).rejects.toThrow(
      /timed out after 50ms/
    );
  });

  it('propagates non-timeout network errors verbatim', async () => {
    stubFetch(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(fetchWithTimeout('https://api.github.com/reset', {}, 1_000)).rejects.toThrow(
      'ECONNRESET'
    );
  });
});
