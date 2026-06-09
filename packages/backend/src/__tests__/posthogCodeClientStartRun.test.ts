import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostHogCodeClient } from '../services/posthogCode/client.js';

/**
 * `startRun` must omit `model` from the run request when none is given, so
 * PostHog Code selects its own default — selecting "Auto" in the desktop UI
 * resolves to an undefined model that should never reach the wire as a key.
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

describe('PostHogCodeClient.startRun — model is optional', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('omits `model` entirely when not provided', async () => {
    const stub = stubFetchOk();
    const client = new PostHogCodeClient('key', 'proj', 'https://us.posthog.com');

    await client.startRun('task-1', { runtimeAdapter: 'claude' });

    const body = lastBody(stub);
    expect(body).not.toHaveProperty('model');
    expect(body).toMatchObject({ mode: 'background', runtime_adapter: 'claude' });
  });

  it.each([undefined, ''])('omits `model` for falsy value %p', async (model) => {
    const stub = stubFetchOk();
    const client = new PostHogCodeClient('key', 'proj', 'https://us.posthog.com');

    await client.startRun('task-1', { runtimeAdapter: 'claude', model });

    expect(lastBody(stub)).not.toHaveProperty('model');
  });

  it('includes `model` when an explicit value is given', async () => {
    const stub = stubFetchOk();
    const client = new PostHogCodeClient('key', 'proj', 'https://us.posthog.com');

    await client.startRun('task-1', { runtimeAdapter: 'claude', model: 'claude-opus-4-8' });

    expect(lastBody(stub)).toMatchObject({ model: 'claude-opus-4-8' });
  });
});
