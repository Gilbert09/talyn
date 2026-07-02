import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithTimeout } from '../services/httpTimeout.js';
import { raceWithIdleTimeout, IDLE_TIMED_OUT } from '../services/posthogCode/streamer.js';

/**
 * Outbound-timeout hardening for the cloud-provider clients. Same contract as
 * github.ts's fetchWithTimeout (see githubFetchTimeout.test.ts): the timer
 * bounds the WHOLE request — headers AND body.
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
  vi.useRealTimers();
});

describe('httpTimeout.fetchWithTimeout', () => {
  it('returns status, headers and the fully-read body text', async () => {
    stubFetch(async () =>
      new Response(JSON.stringify({ id: 'run-1' }), {
        status: 200,
        headers: { 'x-request-id': 'abc123' },
      })
    );
    const res = await fetchWithTimeout('https://api.example.com/test', {}, { timeoutMs: 1_000 });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('abc123');
    expect(JSON.parse(res.bodyText)).toEqual({ id: 'run-1' });
  });

  it('times out when the headers never arrive, with the caller label', async () => {
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('This operation was aborted', 'AbortError'))
          );
        })
    );
    await expect(
      fetchWithTimeout('https://api.example.com/slow', {}, { timeoutMs: 50, label: 'PostHog Code' })
    ).rejects.toThrow(/PostHog Code request timed out after 50ms/);
  });

  it('times out when the body stalls after the headers arrive', async () => {
    stubFetch(async (_url, init) => new Response(hangingBody(init?.signal), { status: 200 }));
    await expect(
      fetchWithTimeout('https://api.example.com/slow-body', {}, { timeoutMs: 50 })
    ).rejects.toThrow(/timed out after 50ms/);
  });

  it('propagates non-timeout network errors verbatim', async () => {
    stubFetch(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(
      fetchWithTimeout('https://api.example.com/reset', {}, { timeoutMs: 1_000 })
    ).rejects.toThrow('ECONNRESET');
  });
});

describe('raceWithIdleTimeout (SSE idle detection)', () => {
  it('resolves with the promise value when it settles before the deadline', async () => {
    vi.useFakeTimers();
    const p = raceWithIdleTimeout(Promise.resolve('data'), 120_000);
    await expect(p).resolves.toBe('data');
  });

  it('resolves with IDLE_TIMED_OUT when the promise never settles', async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => undefined);
    const p = raceWithIdleTimeout(never, 120_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(p).resolves.toBe(IDLE_TIMED_OUT);
  });

  it('does not fire the sentinel when the promise wins the race', async () => {
    vi.useFakeTimers();
    let resolveRead: (v: string) => void = () => undefined;
    const read = new Promise<string>((r) => {
      resolveRead = r;
    });
    const p = raceWithIdleTimeout(read, 120_000);
    await vi.advanceTimersByTimeAsync(119_999);
    resolveRead('late-but-in-time');
    await expect(p).resolves.toBe('late-but-in-time');
  });

  it('propagates rejections from the raced promise', async () => {
    vi.useFakeTimers();
    const p = raceWithIdleTimeout(Promise.reject(new Error('read failed')), 120_000);
    await expect(p).rejects.toThrow('read failed');
  });
});
