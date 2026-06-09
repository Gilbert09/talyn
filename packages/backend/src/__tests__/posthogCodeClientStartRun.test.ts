import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PostHogCodeClient,
  DEFAULT_POSTHOG_CODE_MODEL,
} from '../services/posthogCode/client.js';

/**
 * The PostHog Code API requires a `model` on every cloud run (it 400s with
 * "model is required when selecting a cloud runtime" otherwise), so `startRun`
 * must always send the one it's given.
 */
function stubFetchOk() {
  const stub = vi.fn(async () => new Response(JSON.stringify({ id: 'task-1' }), { status: 200 }));
  vi.stubGlobal('fetch', stub);
  return stub;
}

function lastBody(stub: ReturnType<typeof stubFetchOk>): Record<string, unknown> {
  const init = stub.mock.calls.at(-1)?.[1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe('PostHogCodeClient.startRun — model is always sent', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('includes the given model alongside the run params', async () => {
    const stub = stubFetchOk();
    const client = new PostHogCodeClient('key', 'proj', 'https://us.posthog.com');

    await client.startRun('task-1', { runtimeAdapter: 'claude', model: 'claude-opus-4-8' });

    expect(lastBody(stub)).toMatchObject({
      mode: 'background',
      runtime_adapter: 'claude',
      model: 'claude-opus-4-8',
    });
  });

  it('exposes a concrete default model (the API rejects an absent one)', () => {
    expect(typeof DEFAULT_POSTHOG_CODE_MODEL).toBe('string');
    expect(DEFAULT_POSTHOG_CODE_MODEL.length).toBeGreaterThan(0);
  });
});
