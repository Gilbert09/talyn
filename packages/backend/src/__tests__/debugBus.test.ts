import { describe, it, expect, beforeEach, vi } from 'vitest';
import { debugBus, redactUrl } from '../services/debugBus.js';
import type { DebugCategory } from '@fastowl/shared';

/**
 * Unit tests for the in-process debug bus that powers the developer Debug
 * panel: ring-buffer eviction, counters, poller-state tracking, the live
 * sink, filtering, and (critically) redaction — captured HTTP must never
 * carry query strings, headers, or bodies.
 */

beforeEach(() => {
  debugBus._reset();
  debugBus.setEnabled(true);
  debugBus.setLiveSink(null);
  debugBus.setClientCounter(null);
});

describe('redactUrl', () => {
  it.each([
    ['https://api.github.com/repos/x/y?access_token=secret', 'https://api.github.com/repos/x/y'],
    ['https://us.posthog.com/api/projects/2/tasks/?limit=1', 'https://us.posthog.com/api/projects/2/tasks/'],
    ['https://github.com/login/oauth/access_token', 'https://github.com/login/oauth/access_token'],
    ['/relative/path?token=abc', '/relative/path'],
  ])('strips the query string: %s', (input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });
});

describe('ring buffer', () => {
  it('keeps insertion order and assigns monotonic ids', () => {
    debugBus.recordEvent({ service: 'a', action: 'x', summary: 'first' });
    debugBus.recordEvent({ service: 'b', action: 'y', summary: 'second' });
    const events = debugBus.getEvents();
    expect(events.map((e) => e.summary)).toEqual(['first', 'second']);
    expect(events[1].id).toBe(events[0].id + 1);
    expect(events[0].timestamp).toBeTruthy();
  });

  it('evicts the oldest beyond the 1000-event cap', () => {
    for (let i = 0; i < 1050; i++) {
      debugBus.recordEvent({ service: 's', action: 'tick', summary: `e${i}` });
    }
    const events = debugBus.getEvents();
    expect(events).toHaveLength(1000);
    // The first 50 were evicted; the oldest retained is e50.
    expect(events[0].summary).toBe('e50');
    expect(events[events.length - 1].summary).toBe('e1049');
  });

  it('clear() empties the buffer and counters', () => {
    debugBus.recordEvent({ service: 's', action: 'x', summary: 'one' });
    debugBus.clear();
    expect(debugBus.getEvents()).toHaveLength(0);
    expect(debugBus.snapshot().counters).toEqual({});
  });
});

describe('counters', () => {
  it('counts per category', () => {
    debugBus.recordHttp({ service: 'github', method: 'GET', url: 'https://x/y', status: 200, durationMs: 10, ok: true });
    debugBus.recordHttp({ service: 'github', method: 'GET', url: 'https://x/z', status: 500, durationMs: 12, ok: false });
    debugBus.recordWs({ action: 'connect', summary: 'c' });
    const { counters } = debugBus.snapshot();
    expect(counters.http).toBe(2);
    expect(counters.websocket).toBe(1);
  });
});

describe('recordHttp', () => {
  it('captures metadata only — no headers or bodies, url redacted', () => {
    debugBus.recordHttp({
      service: 'github',
      method: 'GET',
      url: 'https://api.github.com/user?access_token=topsecret',
      status: 200,
      durationMs: 42,
      ok: true,
      bytes: 128,
    });
    const [e] = debugBus.getEvents();
    expect(e.category).toBe('http');
    expect(e.summary).toContain('https://api.github.com/user');
    expect(e.summary).not.toContain('topsecret');
    expect(JSON.stringify(e)).not.toContain('topsecret');
    expect(e.meta).toEqual({ status: 200, bytes: 128 });
    expect(e.ok).toBe(true);
  });

  it('records failures with a truncated error and ok=false', () => {
    debugBus.recordHttp({
      service: 'posthog_code',
      method: 'POST',
      url: 'https://us.posthog.com/api/projects/2/tasks/',
      status: 500,
      durationMs: 5,
      ok: false,
      error: 'x'.repeat(2000),
    });
    const [e] = debugBus.getEvents();
    expect(e.ok).toBe(false);
    expect((e.meta?.error as string).length).toBeLessThanOrEqual(501);
  });
});

describe('poller registry', () => {
  it('registers and updates tick state', () => {
    debugBus.registerPoller('pr_monitor', 30_000, 'baseline PR poll');
    debugBus.pollerTick('pr_monitor', { durationMs: 12, ok: true, summary: 'tick' });
    debugBus.pollerTick('pr_monitor', { durationMs: 8, ok: true });
    const poller = debugBus.snapshot().pollers.find((p) => p.name === 'pr_monitor');
    expect(poller).toBeDefined();
    expect(poller!.description).toBe('baseline PR poll');
    expect(poller!.intervalMs).toBe(30_000);
    expect(poller!.tickCount).toBe(2);
    expect(poller!.lastDurationMs).toBe(8);
    expect(poller!.lastOk).toBe(true);
    expect(poller!.lastTickAt).toBeTruthy();
  });

  it('records a failed tick under the error category with the error message', () => {
    debugBus.registerPoller('merge_queue', 60_000, 'serialized merge queue');
    debugBus.pollerTick('merge_queue', { durationMs: 3, ok: false, error: 'boom' });
    const poller = debugBus.snapshot().pollers.find((p) => p.name === 'merge_queue');
    expect(poller!.lastOk).toBe(false);
    expect(poller!.lastError).toBe('boom');
    const tickEvent = debugBus.getEvents({ category: 'error' });
    expect(tickEvent).toHaveLength(1);
    expect(tickEvent[0].meta?.error).toBe('boom');
  });
});

describe('rate-limit registry', () => {
  const sample = {
    name: 'github',
    description: 'GitHub REST API',
    limit: 5000,
    remaining: 4990,
    used: 10,
    resetAt: '2026-06-04T12:00:00.000Z',
    resource: 'core',
  };

  it('records and exposes a bucket via the snapshot', () => {
    debugBus.recordRateLimit(sample);
    const rls = debugBus.snapshot().rateLimits;
    expect(rls).toHaveLength(1);
    expect(rls[0]).toMatchObject({ name: 'github', limit: 5000, remaining: 4990, used: 10, resource: 'core' });
    expect(rls[0].observedAt).toBeTruthy();
  });

  it('overwrites the previous snapshot for the same bucket', () => {
    debugBus.recordRateLimit(sample);
    debugBus.recordRateLimit({ ...sample, remaining: 4000, used: 1000 });
    const rls = debugBus.snapshot().rateLimits;
    expect(rls).toHaveLength(1);
    expect(rls[0].remaining).toBe(4000);
    expect(rls[0].used).toBe(1000);
  });

  it('keeps REST and GraphQL as separate buckets', () => {
    debugBus.recordRateLimit(sample);
    debugBus.recordRateLimit({ ...sample, name: 'github_graphql', resource: 'graphql' });
    expect(debugBus.snapshot().rateLimits).toHaveLength(2);
  });

  it('ignores a garbage/absent limit', () => {
    debugBus.recordRateLimit({ ...sample, limit: Number.NaN });
    debugBus.recordRateLimit({ ...sample, name: 'zero', limit: 0 });
    expect(debugBus.snapshot().rateLimits).toHaveLength(0);
  });

  it('is a no-op while disabled', () => {
    debugBus.setEnabled(false);
    debugBus.recordRateLimit(sample);
    expect(debugBus.snapshot().rateLimits).toHaveLength(0);
  });

  it('_reset() drops recorded buckets', () => {
    debugBus.recordRateLimit(sample);
    debugBus._reset();
    expect(debugBus.snapshot().rateLimits).toHaveLength(0);
  });

  it('prunes a bucket not re-observed within the staleness window', () => {
    vi.useFakeTimers();
    try {
      debugBus.recordRateLimit(sample);
      // Still inside the 3-minute window.
      vi.advanceTimersByTime(2 * 60_000);
      expect(debugBus.snapshot().rateLimits).toHaveLength(1);
      // Past it with no fresh observation → aged out.
      vi.advanceTimersByTime(2 * 60_000);
      expect(debugBus.snapshot().rateLimits).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fresh observation resets the staleness clock', () => {
    vi.useFakeTimers();
    try {
      debugBus.recordRateLimit(sample);
      vi.advanceTimersByTime(2 * 60_000);
      debugBus.recordRateLimit(sample); // re-observed
      vi.advanceTimersByTime(2 * 60_000); // only 2 min since the last observation
      expect(debugBus.snapshot().rateLimits).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getEvents filtering', () => {
  beforeEach(() => {
    debugBus.recordHttp({ service: 'github', method: 'GET', url: 'https://x', status: 200, durationMs: 1, ok: true });
    debugBus.recordHttp({ service: 'posthog_code', method: 'GET', url: 'https://y', status: 200, durationMs: 1, ok: true });
    debugBus.recordWs({ action: 'connect', summary: 'c' });
  });

  it('filters by category', () => {
    const http = debugBus.getEvents({ category: 'http' });
    expect(http).toHaveLength(2);
    expect(http.every((e) => e.category === 'http')).toBe(true);
  });

  it('filters by service', () => {
    const gh = debugBus.getEvents({ service: 'github' });
    expect(gh).toHaveLength(1);
    expect(gh[0].service).toBe('github');
  });

  it('applies a limit to the most recent events', () => {
    const limited = debugBus.getEvents({ limit: 1 });
    expect(limited).toHaveLength(1);
    // Limit returns the tail (most recent) — the WS connect was last.
    expect(limited[0].category).toBe('websocket');
  });
});

describe('live sink', () => {
  it('invokes the sink for each recorded event', () => {
    const seen: DebugCategory[] = [];
    debugBus.setLiveSink((e) => seen.push(e.category));
    debugBus.recordEvent({ service: 's', action: 'x', summary: 'one' });
    debugBus.recordWs({ action: 'connect', summary: 'c' });
    expect(seen).toEqual(['event', 'websocket']);
  });

  it('a throwing sink never breaks recording', () => {
    debugBus.setLiveSink(() => {
      throw new Error('sink blew up');
    });
    expect(() => debugBus.recordEvent({ service: 's', action: 'x', summary: 'one' })).not.toThrow();
    expect(debugBus.getEvents()).toHaveLength(1);
  });
});

describe('enabled flag', () => {
  it('is a no-op while disabled', () => {
    debugBus.setEnabled(false);
    debugBus.recordEvent({ service: 's', action: 'x', summary: 'one' });
    expect(debugBus.getEvents()).toHaveLength(0);
  });
});

describe('snapshot client count', () => {
  it('reports the injected WS client counter', () => {
    debugBus.setClientCounter(() => 3);
    expect(debugBus.snapshot().wsClients).toBe(3);
  });
});
