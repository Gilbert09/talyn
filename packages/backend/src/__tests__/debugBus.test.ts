import { describe, it, expect, beforeEach } from 'vitest';
import { debugBus, redactUrl, matchesOwnerFilter } from '../services/debugBus.js';
import type { DebugCategory } from '@talyn/shared';

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

describe('recordDbQuery', () => {
  it('records a db event with operation, table, rows, and byte meta', () => {
    debugBus.recordDbQuery({
      operation: 'SELECT',
      table: 'tasks',
      durationMs: 7,
      ok: true,
      bytes: 4096,
      rows: 3,
    });
    const [e] = debugBus.getEvents();
    expect(e.category).toBe('db');
    expect(e.service).toBe('postgres');
    expect(e.action).toBe('select');
    expect(e.summary).toContain('SELECT tasks');
    expect(e.summary).toContain('3 rows');
    expect(e.meta).toMatchObject({ bytes: 4096, rows: 3, table: 'tasks' });
  });

  it('accumulates request count and egress bytes into dbStats', () => {
    debugBus.recordDbQuery({ operation: 'SELECT', table: 'tasks', durationMs: 1, ok: true, bytes: 1000 });
    debugBus.recordDbQuery({ operation: 'UPDATE', table: 'tasks', durationMs: 1, ok: true, bytes: 500 });
    const { dbStats, counters } = debugBus.snapshot();
    expect(dbStats).toEqual({ requests: 2, egressBytes: 1500 });
    expect(counters.db).toBe(2);
  });

  it('counts a failed query but adds no egress, with ok=false', () => {
    debugBus.recordDbQuery({
      operation: 'SELECT',
      table: 'pull_requests',
      durationMs: 2,
      ok: false,
      bytes: 0,
      error: 'connection reset',
    });
    const [e] = debugBus.getEvents();
    expect(e.ok).toBe(false);
    expect(e.summary).toContain('failed');
    expect(e.meta?.error).toBe('connection reset');
    expect(debugBus.snapshot().dbStats).toEqual({ requests: 1, egressBytes: 0 });
  });

  it('clamps non-finite / negative byte counts to zero', () => {
    debugBus.recordDbQuery({ operation: 'SELECT', durationMs: 1, ok: true, bytes: Number.NaN });
    debugBus.recordDbQuery({ operation: 'SELECT', durationMs: 1, ok: true, bytes: -50 });
    expect(debugBus.snapshot().dbStats.egressBytes).toBe(0);
  });

  it('clear() resets dbStats alongside the buffer and counters', () => {
    debugBus.recordDbQuery({ operation: 'SELECT', table: 'tasks', durationMs: 1, ok: true, bytes: 2048 });
    debugBus.clear();
    expect(debugBus.snapshot().dbStats).toEqual({ requests: 0, egressBytes: 0 });
  });

  it('is a no-op while recording is disabled', () => {
    debugBus.setEnabled(false);
    debugBus.recordDbQuery({ operation: 'SELECT', table: 'tasks', durationMs: 1, ok: true, bytes: 9000 });
    debugBus.setEnabled(true);
    expect(debugBus.getEvents()).toHaveLength(0);
    expect(debugBus.snapshot().dbStats).toEqual({ requests: 0, egressBytes: 0 });
  });

  describe('webhookLag gauge', () => {
    const proc = (latencyMs: number) =>
      debugBus.recordWebhook({ action: 'processed', eventType: 'pull_request', ok: true, fanout: 1, latencyMs });

    it('reports zeros with no processed deliveries yet', () => {
      expect(debugBus.snapshot().webhookLag).toEqual({
        lastMs: 0,
        medianMs: 0,
        maxMs: 0,
        samples: 0,
        observedAt: null,
      });
    });

    it('tracks last / median / max enqueue→pickup lag across processed deliveries', () => {
      proc(100);
      proc(900);
      proc(500);
      const lag = debugBus.snapshot().webhookLag;
      expect(lag.lastMs).toBe(500);
      expect(lag.medianMs).toBe(500); // sorted [100,500,900] → middle
      expect(lag.maxMs).toBe(900);
      expect(lag.samples).toBe(3);
      expect(lag.observedAt).not.toBeNull();
    });

    it('only counts processed deliveries that carry a latency (not received)', () => {
      debugBus.recordWebhook({ action: 'received', eventType: 'pull_request', ok: true, queued: true });
      proc(7_000);
      const lag = debugBus.snapshot().webhookLag;
      expect(lag.samples).toBe(1);
      expect(lag.maxMs).toBe(7_000);
    });

    it('clear() resets the lag window', () => {
      proc(1_234);
      debugBus.clear();
      expect(debugBus.snapshot().webhookLag.samples).toBe(0);
      expect(debugBus.snapshot().webhookLag.observedAt).toBeNull();
    });

    it('splits the slow (pull_request) lane into its own gauge, also feeding overall', () => {
      const procLane = (latencyMs: number, lane: 'fast' | 'slow') =>
        debugBus.recordWebhook({ action: 'processed', eventType: 'pull_request', ok: true, fanout: 1, latencyMs, lane });
      procLane(50, 'fast'); // firehose only
      procLane(4_000, 'slow'); // refreshPr lane
      procLane(6_000, 'slow');
      const snap = debugBus.snapshot();
      // Overall counts every processed delivery (both lanes).
      expect(snap.webhookLag.samples).toBe(3);
      expect(snap.webhookLag.maxMs).toBe(6_000);
      // Slow lane tracks only the refresh deliveries.
      expect(snap.webhookLagSlow.samples).toBe(2);
      expect(snap.webhookLagSlow.lastMs).toBe(6_000);
      expect(snap.webhookLagSlow.maxMs).toBe(6_000);
      expect(snap.webhookLagSlow.observedAt).not.toBeNull();
    });

    it('leaves the slow-lane gauge empty when only the fast lane runs', () => {
      debugBus.recordWebhook({ action: 'processed', eventType: 'check_run', ok: true, fanout: 0, latencyMs: 20, lane: 'fast' });
      const snap = debugBus.snapshot();
      expect(snap.webhookLag.samples).toBe(1);
      expect(snap.webhookLagSlow.samples).toBe(0);
      expect(snap.webhookLagSlow.observedAt).toBeNull();
    });
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

  it('defaults baseIntervalMs to the interval for a fixed-cadence loop', () => {
    debugBus.registerPoller('rate_limit', 30_000, 'free /rate_limit poll');
    const poller = debugBus.snapshot().pollers.find((p) => p.name === 'rate_limit');
    expect(poller!.baseIntervalMs).toBe(30_000);
  });

  it('keeps the base while an adaptive loop re-registers a stretched interval', () => {
    debugBus.registerPoller('pr_monitor', 30_000, 'baseline', 30_000);
    // Governor stretches the live cadence; base must stay put so the panel can
    // tell it's been throttled.
    debugBus.registerPoller('pr_monitor', 90_000, 'baseline', 30_000);
    const poller = debugBus.snapshot().pollers.find((p) => p.name === 'pr_monitor');
    expect(poller!.intervalMs).toBe(90_000);
    expect(poller!.baseIntervalMs).toBe(30_000);
  });

  it('leaves the stored base untouched when a re-register omits it', () => {
    debugBus.registerPoller('pr_monitor', 30_000, 'baseline', 30_000);
    debugBus.registerPoller('pr_monitor', 60_000, 'baseline'); // no base passed
    const poller = debugBus.snapshot().pollers.find((p) => p.name === 'pr_monitor');
    expect(poller!.baseIntervalMs).toBe(30_000);
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

describe('matchesOwnerFilter', () => {
  it('treats undefined / "all" as match-everything', () => {
    expect(matchesOwnerFilter('o1', undefined)).toBe(true);
    expect(matchesOwnerFilter(null, 'all')).toBe(true);
  });
  it('matches a specific owner id', () => {
    expect(matchesOwnerFilter('o1', 'o1')).toBe(true);
    expect(matchesOwnerFilter('o1', 'o2')).toBe(false);
  });
  it('"system" matches only unattributed activity', () => {
    expect(matchesOwnerFilter(null, 'system')).toBe(true);
    expect(matchesOwnerFilter(undefined, 'system')).toBe(true);
    expect(matchesOwnerFilter('o1', 'system')).toBe(false);
  });
});

describe('owner attribution + filtering', () => {
  it('stamps ownerId/label on an event for a registered workspace', () => {
    debugBus.registerOwner('ws1', 'owner-1', '@tom');
    debugBus.recordHttp({
      service: 'github', method: 'GET', url: 'https://api.github.com/repos/a/b',
      durationMs: 5, ok: true, workspaceId: 'ws1',
    });
    const [e] = debugBus.getEvents({ category: 'http' });
    expect(e.ownerId).toBe('owner-1');
    expect(e.ownerLabel).toBe('@tom');
  });

  it('leaves an event unattributed when the workspace is unknown', () => {
    debugBus.recordHttp({
      service: 'github', method: 'GET', url: 'https://api.github.com/x',
      durationMs: 5, ok: true, workspaceId: 'nope',
    });
    const [e] = debugBus.getEvents({ category: 'http' });
    expect(e.ownerId ?? null).toBeNull();
  });

  it('filters getEvents by owner / system / all', () => {
    debugBus.registerOwner('ws1', 'owner-1', '@a');
    debugBus.registerOwner('ws2', 'owner-2', '@b');
    debugBus.recordHttp({ service: 'github', method: 'GET', url: 'u1', durationMs: 1, ok: true, workspaceId: 'ws1' });
    debugBus.recordHttp({ service: 'github', method: 'GET', url: 'u2', durationMs: 1, ok: true, workspaceId: 'ws2' });
    debugBus.recordEvent({ service: 'sys', action: 'x', summary: 'untagged' });

    expect(debugBus.getEvents({ owner: 'owner-1' })).toHaveLength(1);
    expect(debugBus.getEvents({ owner: 'owner-1' })[0].ownerId).toBe('owner-1');
    expect(debugBus.getEvents({ owner: 'system' }).every((e) => !e.ownerId)).toBe(true);
    expect(debugBus.getEvents({ owner: 'system' })).toHaveLength(1);
    expect(debugBus.getEvents({ owner: 'all' })).toHaveLength(3);
    expect(debugBus.getEvents()).toHaveLength(3);
  });

  it('lists registered owners in the snapshot', () => {
    debugBus.registerOwner('ws1', 'owner-1', '@a');
    debugBus.registerOwner('ws2', 'owner-2', '@b');
    expect(debugBus.snapshot().owners).toEqual(
      expect.arrayContaining([
        { ownerId: 'owner-1', label: '@a' },
        { ownerId: 'owner-2', label: '@b' },
      ]),
    );
  });

  it('_reset() drops the owner directory', () => {
    debugBus.registerOwner('ws1', 'owner-1', '@a');
    debugBus._reset();
    expect(debugBus.snapshot().owners).toHaveLength(0);
  });
});

describe('recordWebhook', () => {
  it('records a queued delivery under the webhook category with its subject', () => {
    debugBus.recordWebhook({
      action: 'received',
      eventType: 'pull_request',
      ghAction: 'opened',
      repo: 'acme/widgets',
      delivery: 'abc',
      signature: 'valid',
      ok: true,
      queued: true,
    });
    const events = debugBus.getEvents({ category: 'webhook' });
    expect(events).toHaveLength(1);
    expect(events[0].service).toBe('github_webhooks');
    expect(events[0].summary).toContain('recv pull_request.opened acme/widgets');
    expect(events[0].summary).toContain('queued');
    expect(events[0].meta?.repo).toBe('acme/widgets');
    expect(debugBus.snapshot().counters.webhook).toBe(1);
  });

  it('records a drop with its reason and stays in the webhook category', () => {
    debugBus.recordWebhook({
      action: 'received',
      eventType: 'check_run',
      signature: 'valid',
      ok: true,
      dropReason: 'untracked_repo',
    });
    const [e] = debugBus.getEvents({ category: 'webhook' });
    expect(e.summary).toContain('dropped (untracked_repo)');
    expect(e.meta?.dropReason).toBe('untracked_repo');
  });

  it('routes a bad-signature delivery to the error category', () => {
    debugBus.recordWebhook({
      action: 'received',
      eventType: 'pull_request',
      signature: 'invalid',
      ok: false,
      dropReason: 'bad_signature',
    });
    expect(debugBus.getEvents({ category: 'webhook' })).toHaveLength(0);
    expect(debugBus.getEvents({ category: 'error' })).toHaveLength(1);
  });

  it('records fan-out + enqueue→process latency on a processed delivery', () => {
    debugBus.recordWebhook({
      action: 'processed',
      eventType: 'pull_request',
      ghAction: 'synchronize',
      repo: 'acme/widgets',
      prNumbers: [7],
      ok: true,
      fanout: 3,
      latencyMs: 42,
    });
    const [e] = debugBus.getEvents({ category: 'webhook' });
    // The summary says what the webhook was FOR + the result.
    expect(e.summary).toContain('proc pull_request.synchronize acme/widgets #7');
    expect(e.summary).toContain('3 refreshes');
    expect(e.summary).toContain('42ms lag');
    expect(e.meta?.fanout).toBe(3);
    expect(e.meta?.latencyMs).toBe(42);
    expect(e.meta?.repo).toBe('acme/widgets');
    expect(e.meta?.prNumbers).toEqual([7]);
  });
});
