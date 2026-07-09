import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostHogCodeClient, PostHogCodeApiError } from '../services/posthogCode/client.js';

/**
 * Non-2xx responses throw a typed PostHogCodeApiError carrying the status and
 * (for a 429) the parsed Retry-After, so the cloud poller can back a workspace
 * off without string-matching. The message format is unchanged.
 */
function stubStatus(status: number, headers: Record<string, string> = {}, body = '{}') {
  const stub = vi.fn(async () => new Response(body, { status, headers }));
  vi.stubGlobal('fetch', stub);
  return stub;
}

describe('PostHogCodeClient error typing', () => {
  afterEach(() => vi.unstubAllGlobals());
  const client = () => new PostHogCodeClient('key', 'proj', 'https://us.posthog.com');

  it('throws PostHogCodeApiError with the status and a preserved message', async () => {
    stubStatus(404, {}, 'not found');
    await expect(client().getTask('t1')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof PostHogCodeApiError &&
        e.status === 404 &&
        e.retryAfterMs === null &&
        /failed \(404\)/.test(e.message),
    );
  });

  it('parses a delta-seconds Retry-After on a 429', async () => {
    stubStatus(429, { 'retry-after': '30' }, '{"type":"throttled_error"}');
    await expect(client().getTask('t1')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof PostHogCodeApiError && e.status === 429 && e.retryAfterMs === 30_000,
    );
  });

  it('leaves retryAfterMs null on a 429 without the header', async () => {
    stubStatus(429, {}, '{"type":"throttled_error"}');
    await expect(client().getTask('t1')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof PostHogCodeApiError && e.status === 429 && e.retryAfterMs === null,
    );
  });

  it('does not attach a Retry-After for non-429 statuses', async () => {
    stubStatus(500, { 'retry-after': '30' });
    await expect(client().getTask('t1')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof PostHogCodeApiError && e.status === 500 && e.retryAfterMs === null,
    );
  });
});
