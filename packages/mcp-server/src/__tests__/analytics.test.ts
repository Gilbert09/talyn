import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted so the vi.mock factory (which is itself hoisted above imports) can
// reference them.
const { ctorMock, captureMock, shutdownMock } = vi.hoisted(() => ({
  ctorMock: vi.fn(),
  captureMock: vi.fn(),
  shutdownMock: vi.fn(),
}));

vi.mock('posthog-node', () => ({
  PostHog: class {
    constructor(...args: unknown[]) {
      ctorMock(...args);
    }
    capture(...args: unknown[]) {
      return captureMock(...args);
    }
    shutdown(...args: unknown[]) {
      return shutdownMock(...args);
    }
  },
}));

import { captureToolCall, shutdownAnalytics, _resetAnalytics } from '../analytics.js';

const ENV_KEYS = [
  'TALYN_POSTHOG_KEY',
  'POSTHOG_API_KEY',
  'TALYN_POSTHOG_HOST',
  'POSTHOG_HOST',
  'TALYN_WORKSPACE_ID',
  'TALYN_TASK_ID',
] as const;

describe('mcp analytics', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    ctorMock.mockClear();
    captureMock.mockReset();
    shutdownMock.mockReset();
    shutdownMock.mockResolvedValue(undefined);
    _resetAnalytics();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetAnalytics();
  });

  it('is a no-op when no PostHog key is configured', () => {
    captureToolCall({ tool: 'talyn_create_task', ok: true, durationMs: 5 });
    expect(ctorMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('captures an mcp_tool_called event with metadata-only properties', () => {
    process.env.TALYN_POSTHOG_KEY = 'phc_test';
    process.env.TALYN_WORKSPACE_ID = 'ws1';
    process.env.TALYN_TASK_ID = 'task9';

    captureToolCall({ tool: 'talyn_list_tasks', ok: true, durationMs: 12 });

    expect(ctorMock).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({ host: 'https://us.i.posthog.com' }),
    );
    expect(captureMock).toHaveBeenCalledTimes(1);
    const arg = captureMock.mock.calls[0][0] as {
      distinctId: string;
      event: string;
      properties: Record<string, unknown>;
    };
    expect(arg.event).toBe('mcp_tool_called');
    expect(arg.distinctId).toBe('task9'); // task identifies the actor
    expect(arg.properties).toMatchObject({
      tool: 'talyn_list_tasks',
      ok: true,
      duration_ms: 12,
      workspace_id: 'ws1',
      task_id: 'task9',
      mcp_server: 'talyn',
    });
    // Metadata only — no arguments/prompts/bodies ever leave the process.
    expect(JSON.stringify(arg)).not.toMatch(/prompt|arguments/);
  });

  it('falls back to the workspace id, then anonymous, for the distinct id', () => {
    process.env.TALYN_POSTHOG_KEY = 'phc';
    process.env.TALYN_WORKSPACE_ID = 'wsX';
    captureToolCall({ tool: 't', ok: true, durationMs: 1 });
    expect((captureMock.mock.calls[0][0] as { distinctId: string }).distinctId).toBe('wsX');

    _resetAnalytics();
    captureMock.mockClear();
    delete process.env.TALYN_WORKSPACE_ID;
    captureToolCall({ tool: 't', ok: true, durationMs: 1 });
    expect((captureMock.mock.calls[0][0] as { distinctId: string }).distinctId).toBe('mcp-anonymous');
  });

  it('records + truncates the error on a failed call', () => {
    process.env.TALYN_POSTHOG_KEY = 'phc';
    const long = 'x'.repeat(500);
    captureToolCall({ tool: 't', ok: false, durationMs: 3, error: long });
    const props = (captureMock.mock.calls[0][0] as { properties: { ok: boolean; error: string } })
      .properties;
    expect(props.ok).toBe(false);
    expect(props.error).toHaveLength(200);
  });

  it('honours POSTHOG_API_KEY + a custom host as fallbacks', () => {
    process.env.POSTHOG_API_KEY = 'phc_fallback';
    process.env.TALYN_POSTHOG_HOST = 'https://eu.i.posthog.com';
    captureToolCall({ tool: 't', ok: true, durationMs: 1 });
    expect(ctorMock).toHaveBeenCalledWith(
      'phc_fallback',
      expect.objectContaining({ host: 'https://eu.i.posthog.com' }),
    );
  });

  it('builds the client at most once across calls', () => {
    process.env.TALYN_POSTHOG_KEY = 'phc';
    captureToolCall({ tool: 'a', ok: true, durationMs: 1 });
    captureToolCall({ tool: 'b', ok: true, durationMs: 1 });
    expect(ctorMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledTimes(2);
  });

  it('never throws even if the underlying capture throws', () => {
    process.env.TALYN_POSTHOG_KEY = 'phc';
    captureMock.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => captureToolCall({ tool: 't', ok: true, durationMs: 1 })).not.toThrow();
  });

  it('flushes and closes the client on shutdown', async () => {
    process.env.TALYN_POSTHOG_KEY = 'phc';
    captureToolCall({ tool: 't', ok: true, durationMs: 1 }); // builds the client
    await shutdownAnalytics();
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('shutdown is a no-op when analytics was never configured', async () => {
    await expect(shutdownAnalytics()).resolves.toBeUndefined();
    expect(shutdownMock).not.toHaveBeenCalled();
  });
});
