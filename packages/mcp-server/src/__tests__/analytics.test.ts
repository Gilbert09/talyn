import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted so the vi.mock factory (which is itself hoisted above imports) can
// reference it.
const { ctorMock } = vi.hoisted(() => ({ ctorMock: vi.fn() }));

vi.mock('posthog-node', () => ({
  PostHog: class {
    constructor(...args: unknown[]) {
      ctorMock(...args);
    }
  },
}));

import { createAnalyticsClient, analyticsIdentity } from '../analytics.js';

const ENV_KEYS = [
  'TALYN_POSTHOG_KEY',
  'POSTHOG_API_KEY',
  'TALYN_POSTHOG_HOST',
  'POSTHOG_HOST',
  'TALYN_ANALYTICS_DISABLED',
  'TALYN_WORKSPACE_ID',
  'TALYN_TASK_ID',
];

describe('mcp-server analytics', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    ctorMock.mockReset();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('createAnalyticsClient', () => {
    it('defaults to the Talyn project key + US host with no env set', () => {
      const client = createAnalyticsClient();
      expect(client).not.toBeNull();
      expect(ctorMock).toHaveBeenCalledTimes(1);
      const [key, opts] = ctorMock.mock.calls[0] as [string, { host: string }];
      expect(key).toMatch(/^phc_/);
      expect(opts.host).toBe('https://us.i.posthog.com');
    });

    it('prefers TALYN_POSTHOG_KEY, then POSTHOG_API_KEY, over the default', () => {
      process.env.POSTHOG_API_KEY = 'phc_fallback';
      process.env.TALYN_POSTHOG_KEY = 'phc_primary';
      createAnalyticsClient();
      expect(ctorMock.mock.calls[0][0]).toBe('phc_primary');

      ctorMock.mockReset();
      delete process.env.TALYN_POSTHOG_KEY;
      createAnalyticsClient();
      expect(ctorMock.mock.calls[0][0]).toBe('phc_fallback');
    });

    it('honours the host overrides', () => {
      process.env.TALYN_POSTHOG_HOST = 'https://eu.i.posthog.com';
      createAnalyticsClient();
      expect((ctorMock.mock.calls[0][1] as { host: string }).host).toBe(
        'https://eu.i.posthog.com'
      );
    });

    it.each(['1', 'true', 'TRUE'])('is a no-op when TALYN_ANALYTICS_DISABLED=%s', (v) => {
      process.env.TALYN_ANALYTICS_DISABLED = v;
      expect(createAnalyticsClient()).toBeNull();
      expect(ctorMock).not.toHaveBeenCalled();
    });

    it('sends events promptly (flushAt 1) for the short-lived stdio process', () => {
      createAnalyticsClient();
      const opts = ctorMock.mock.calls[0][1] as { flushAt: number; flushInterval: number };
      expect(opts.flushAt).toBe(1);
      expect(opts.flushInterval).toBe(0);
    });
  });

  describe('analyticsIdentity', () => {
    it('attributes to the task id first', () => {
      process.env.TALYN_WORKSPACE_ID = 'ws-1';
      process.env.TALYN_TASK_ID = 'task-1';
      const identity = analyticsIdentity();
      expect(identity.distinctId).toBe('task-1');
      expect(identity.properties).toEqual({ workspace_id: 'ws-1', task_id: 'task-1' });
    });

    it('falls back to the workspace id, then anonymous', () => {
      process.env.TALYN_WORKSPACE_ID = 'ws-1';
      expect(analyticsIdentity().distinctId).toBe('ws-1');
      delete process.env.TALYN_WORKSPACE_ID;
      expect(analyticsIdentity().distinctId).toBe('mcp-anonymous');
      expect(analyticsIdentity().properties).toEqual({});
    });
  });
});
