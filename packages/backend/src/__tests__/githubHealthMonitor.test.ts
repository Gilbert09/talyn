import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { GithubHealth, WSEvent } from '@talyn/shared';
import { debugBus } from '../services/debugBus.js';
import {
  GITHUB_STATUS_STALE_MS,
  GITHUB_STATUS_SUMMARY_URL,
  GithubTrafficTracker,
} from '../services/githubHealth.js';
import {
  GITHUB_STATUS_POLL_INTERVAL_MS,
  GITHUB_STATUS_TIMEOUT_MS,
  GithubHealthMonitor,
  githubStatusPollEnabled,
} from '../services/githubHealthMonitor.js';

const T0 = Date.parse('2026-10-07T03:00:00.000Z');

type Answer = { status: number; ok: boolean; bodyText: string };

function page(
  overrides: { indicator?: string; statuses?: Record<string, string>; incidents?: string[] } = {},
): Answer {
  const names = ['API Requests', 'Webhooks', 'Pull Requests', 'Git Operations', 'Actions', 'Copilot'];
  return {
    status: 200,
    ok: true,
    bodyText: JSON.stringify({
      status: { indicator: overrides.indicator ?? 'none' },
      components: names.map((name) => ({ name, status: overrides.statuses?.[name] ?? 'operational' })),
      incidents: (overrides.incidents ?? []).map((name) => ({
        name,
        status: 'investigating',
        impact: 'major',
        shortlink: 'https://stspg.io/x',
        started_at: '2026-10-07T02:50:00.000Z',
      })),
    }),
  };
}

const OUTAGE = page({
  indicator: 'critical',
  statuses: { 'API Requests': 'major_outage' },
  incidents: ['API is down'],
});

function setup(first: Answer | Error = page()) {
  let now = T0;
  let answer: Answer | Error = first;
  const sent: WSEvent<GithubHealth>[] = [];
  const tracker = new GithubTrafficTracker();
  const fetchStatusPage = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const monitor = new GithubHealthMonitor({
    tracker,
    broadcast: (event) => sent.push(event),
    fetchStatusPage,
    now: () => now,
  });
  return {
    monitor,
    tracker,
    sent,
    fetchStatusPage,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    answerWith: (next: Answer | Error) => {
      answer = next;
    },
    fail: (api: 'rest' | 'graphql', n: number) => {
      for (let i = 0; i < n; i += 1) tracker.record(api, 'server_failure', now);
    },
    succeed: (api: 'rest' | 'graphql', n: number) => {
      for (let i = 0; i < n; i += 1) tracker.record(api, 'ok', now);
    },
  };
}

const healthEvents = () =>
  debugBus.getEvents({ service: 'github' }).filter((e) => e.action === 'health:changed');

beforeEach(() => {
  debugBus._reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  debugBus.setGithubHealthSource(null);
  debugBus._reset();
});

describe('GithubHealthMonitor: status page', () => {
  it('reads a healthy page as operational', async () => {
    const s = setup();
    await s.monitor.tick();
    const health = s.monitor.refresh();
    expect(health.state).toBe('operational');
    expect(health.statusPage?.state).toBe('operational');
    expect(health.statusPage?.fetchedAt).toBe(new Date(T0).toISOString());
  });

  it('reads an outage on API Requests as down, from the status page', async () => {
    const s = setup(OUTAGE);
    await s.monitor.tick();
    const health = s.monitor.refresh();
    expect(health).toMatchObject({ state: 'down', source: 'status_page' });
    expect(health.statusPage?.incidents.map((i) => i.name)).toEqual(['API is down']);
  });

  it('records each read on the debug bus as github_status, with no query string', async () => {
    const s = setup();
    await s.monitor.tick();
    const http = debugBus.getEvents({ category: 'http', service: 'github_status' });
    expect(http).toHaveLength(1);
    expect(http[0].ok).toBe(true);
    expect(http[0].summary).toContain(`GET ${GITHUB_STATUS_SUMMARY_URL} → 200`);
  });

  it.each([
    ['HTTP 500', { status: 500, ok: false, bodyText: 'oops' } as Answer, /answered 500/],
    ['HTTP 503 with a JSON body', { status: 503, ok: false, bodyText: '{}' } as Answer, /answered 503/],
    ['a body that is not JSON', { status: 200, ok: true, bodyText: '<html>' } as Answer, /not JSON/],
    ['JSON that is not the summary', { status: 200, ok: true, bodyText: '{"a":1}' } as Answer, /not a summary/],
    ['an empty body', { status: 200, ok: true, bodyText: '' } as Answer, /not JSON/],
    ['a timeout', new Error('GitHub status page request timed out after 10000ms'), /timed out/],
    ['a network error', new Error('fetch failed'), /fetch failed/],
  ])('a failed read (%s) says nothing about GitHub', async (_name, answer, message) => {
    const s = setup(answer);
    await expect(s.monitor.pollStatusPage()).rejects.toThrow(message);
    const health = s.monitor.refresh();
    expect(health.state).toBe('unknown');
    expect(health.statusPage).toBeNull();
    const http = debugBus.getEvents({ category: 'http', service: 'github_status' });
    expect(http).toHaveLength(1);
    expect(http[0].ok).toBe(false);
    expect(String(http[0].meta?.error)).toMatch(message);
  });

  it('a failed read keeps the last good answer, then lets it go stale', async () => {
    const s = setup(OUTAGE);
    await s.monitor.tick();
    s.answerWith(new Error('fetch failed'));
    s.advance(GITHUB_STATUS_POLL_INTERVAL_MS);
    await s.monitor.tick();
    expect(s.monitor.refresh()).toMatchObject({ state: 'down', source: 'status_page' });

    s.advance(GITHUB_STATUS_STALE_MS);
    await s.monitor.tick();
    const stale = s.monitor.refresh();
    expect(stale.state).toBe('unknown');
    expect(stale.statusPage?.state).toBe('unknown');
    // The age is still reported, from the last GOOD read.
    expect(stale.statusPage?.fetchedAt).toBe(new Date(T0).toISOString());
  });

  it('a failed tick is reported on the poller card and does not throw', async () => {
    debugBus.registerPoller('github_status', GITHUB_STATUS_POLL_INTERVAL_MS, 'x');
    const s = setup(new Error('fetch failed'));
    await expect(s.monitor.tick()).resolves.toBeUndefined();
    const card = debugBus.snapshot().pollers.find((p) => p.name === 'github_status');
    expect(card).toMatchObject({ tickCount: 1, lastOk: false });
    expect(card?.lastError).toContain('fetch failed');
  });

  it('a good tick is reported on the poller card', async () => {
    debugBus.registerPoller('github_status', GITHUB_STATUS_POLL_INTERVAL_MS, 'x');
    const s = setup();
    await s.monitor.tick();
    const card = debugBus.snapshot().pollers.find((p) => p.name === 'github_status');
    expect(card).toMatchObject({ tickCount: 1, lastOk: true, lastError: null });
  });
});

describe('GithubHealthMonitor: broadcast', () => {
  it('says nothing while nothing is known', () => {
    const s = setup();
    s.monitor.refresh();
    s.monitor.refresh();
    expect(s.sent).toEqual([]);
    expect(healthEvents()).toEqual([]);
  });

  it('broadcasts github:health once per state change, with the whole payload', async () => {
    const s = setup();
    await s.monitor.tick();
    expect(s.sent.map((e) => [e.type, e.payload.state])).toEqual([['github:health', 'operational']]);
    expect(s.sent[0].timestamp).toBe(s.sent[0].payload.updatedAt);

    // Identical ticks: no further event.
    for (let i = 0; i < 3; i += 1) {
      s.advance(GITHUB_STATUS_POLL_INTERVAL_MS);
      await s.monitor.tick();
    }
    expect(s.sent).toHaveLength(1);

    s.answerWith(OUTAGE);
    s.advance(GITHUB_STATUS_POLL_INTERVAL_MS);
    await s.monitor.tick();
    expect(s.sent.map((e) => e.payload.state)).toEqual(['operational', 'down']);
    expect(s.sent[1].payload.since).toBe(new Date(s.now()).toISOString());

    s.advance(GITHUB_STATUS_POLL_INTERVAL_MS);
    await s.monitor.tick();
    expect(s.sent).toHaveLength(2);
  });

  it('broadcasts when the set of incidents changes and the state does not', async () => {
    const s = setup(page({ statuses: { Actions: 'partial_outage' }, incidents: ['A'] }));
    await s.monitor.tick();
    const since = s.sent[0].payload.since;
    s.answerWith(page({ statuses: { Actions: 'partial_outage' }, incidents: ['A', 'B'] }));
    s.advance(GITHUB_STATUS_POLL_INTERVAL_MS);
    await s.monitor.tick();
    expect(s.sent.map((e) => e.payload.state)).toEqual(['degraded', 'degraded']);
    expect(s.sent[1].payload.statusPage?.incidents.map((i) => i.name)).toEqual(['A', 'B']);
    // Same state, so the incident did not start again.
    expect(s.sent[1].payload.since).toBe(since);
    // One state change, so one debug event.
    expect(healthEvents()).toHaveLength(1);
  });

  it('broadcasts an unrelated incident arriving, with the state still operational', async () => {
    const s = setup();
    await s.monitor.tick();
    s.answerWith(page({ indicator: 'minor', statuses: { Copilot: 'major_outage' }, incidents: ['Copilot'] }));
    s.advance(GITHUB_STATUS_POLL_INTERVAL_MS);
    await s.monitor.tick();
    expect(s.sent.map((e) => e.payload.state)).toEqual(['operational', 'operational']);
  });

  it('does not broadcast on traffic that leaves the state as it was', async () => {
    const s = setup();
    await s.monitor.tick();
    s.succeed('rest', 50);
    s.fail('rest', 3);
    s.monitor.refresh();
    expect(s.sent).toHaveLength(1);
  });

  it('records health:changed with the old and the new state', async () => {
    const s = setup();
    await s.monitor.tick();
    s.fail('rest', 10);
    s.monitor.refresh();
    const events = healthEvents();
    expect(events.map((e) => [e.meta?.from, e.meta?.to, e.ok])).toEqual([
      ['unknown', 'operational', true],
      ['operational', 'down', false],
    ]);
    expect(events[1].summary).toBe('GitHub health operational → down (traffic)');
    expect(events[1].meta?.source).toBe('traffic');
  });

  it('a broadcast that throws does not break the caller', () => {
    const tracker = new GithubTrafficTracker();
    const monitor = new GithubHealthMonitor({
      tracker,
      broadcast: () => {
        throw new Error('socket gone');
      },
      now: () => T0,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 10; i += 1) tracker.record('rest', 'server_failure', T0);
    expect(monitor.refresh().state).toBe('down');
  });
});

describe('GithubHealthMonitor: traffic', () => {
  it('our own traffic is enough for down while the status page says all is well', async () => {
    const s = setup();
    await s.monitor.tick();
    s.fail('graphql', 10);
    const health = s.monitor.refresh();
    expect(health).toMatchObject({ state: 'down', source: 'traffic' });
    expect(health.statusPage?.state).toBe('operational');
    expect(s.monitor.isDown()).toBe(true);
  });

  it('both signals together read as both', async () => {
    const s = setup(OUTAGE);
    await s.monitor.tick();
    s.fail('rest', 10);
    expect(s.monitor.refresh()).toMatchObject({ state: 'down', source: 'both' });
  });

  it.each([
    ['nothing known', 0, 0, false],
    ['healthy traffic', 20, 0, false],
    ['degraded traffic', 14, 6, false],
    ['failing traffic', 2, 18, true],
  ] as const)('isDown with %s', (_name, ok, failed, down) => {
    const s = setup();
    s.succeed('rest', ok);
    s.fail('rest', failed);
    expect(s.monitor.isDown()).toBe(down);
  });
});

describe('GithubHealthMonitor: start and stop', () => {
  it('does not start under NODE_ENV=test', () => {
    expect(process.env.NODE_ENV).toBe('test');
    const s = setup();
    vi.useFakeTimers();
    s.monitor.init();
    vi.advanceTimersByTime(10 * GITHUB_STATUS_POLL_INTERVAL_MS);
    expect(s.fetchStatusPage).not.toHaveBeenCalled();
    expect(debugBus.snapshot().pollers.find((p) => p.name === 'github_status')).toBeUndefined();
    expect(debugBus.snapshot().githubHealth).toBeUndefined();
    s.monitor.shutdown();
  });

  it('started on purpose: registers the poller, reads at once and then every interval', async () => {
    const s = setup();
    vi.useFakeTimers();
    s.monitor.init({ force: true });
    const card = debugBus.snapshot().pollers.find((p) => p.name === 'github_status');
    expect(card?.intervalMs).toBe(GITHUB_STATUS_POLL_INTERVAL_MS);
    expect(card?.description).toMatch(/status page/);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.fetchStatusPage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(GITHUB_STATUS_POLL_INTERVAL_MS);
    expect(s.fetchStatusPage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(GITHUB_STATUS_POLL_INTERVAL_MS);
    expect(s.fetchStatusPage).toHaveBeenCalledTimes(3);

    s.monitor.shutdown();
    await vi.advanceTimersByTimeAsync(5 * GITHUB_STATUS_POLL_INTERVAL_MS);
    expect(s.fetchStatusPage).toHaveBeenCalledTimes(3);
  });

  it('started: a response that changes the traffic state is broadcast at once', async () => {
    const s = setup();
    vi.useFakeTimers();
    s.monitor.init({ force: true });
    await vi.advanceTimersByTimeAsync(0);
    s.fail('rest', 10);
    expect(s.sent.map((e) => e.payload.state)).toEqual(['operational', 'down']);
    s.monitor.shutdown();
  });

  it('started: the debug snapshot carries the health, and stops on shutdown', async () => {
    const s = setup();
    vi.useFakeTimers();
    s.monitor.init({ force: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(debugBus.snapshot().githubHealth?.state).toBe('operational');
    s.monitor.shutdown();
    expect(debugBus.snapshot().githubHealth).toBeUndefined();
  });

  it('GITHUB_STATUS_POLL_ENABLED=false keeps the loop and stops the reads', async () => {
    const original = process.env.GITHUB_STATUS_POLL_ENABLED;
    process.env.GITHUB_STATUS_POLL_ENABLED = 'false';
    try {
      const s = setup();
      vi.useFakeTimers();
      s.monitor.init({ force: true });
      await vi.advanceTimersByTimeAsync(3 * GITHUB_STATUS_POLL_INTERVAL_MS);
      expect(s.fetchStatusPage).not.toHaveBeenCalled();
      const card = debugBus.snapshot().pollers.find((p) => p.name === 'github_status');
      expect(card?.tickCount).toBeGreaterThanOrEqual(3);
      expect(card?.description).toMatch(/GITHUB_STATUS_POLL_ENABLED/);
      // The traffic signal still works.
      s.fail('rest', 10);
      expect(s.monitor.isDown()).toBe(true);
      s.monitor.shutdown();
    } finally {
      if (original === undefined) delete process.env.GITHUB_STATUS_POLL_ENABLED;
      else process.env.GITHUB_STATUS_POLL_ENABLED = original;
    }
  });

  it.each([
    [undefined, true],
    ['', true],
    ['true', true],
    ['1', true],
    ['yes', true],
    ['flase', true],
    ['false', false],
    ['FALSE', false],
    [' false ', false],
    ['0', false],
    ['off', false],
    ['no', false],
  ])('GITHUB_STATUS_POLL_ENABLED=%j reads as %s', (value, enabled) => {
    expect(githubStatusPollEnabled({ GITHUB_STATUS_POLL_ENABLED: value } as NodeJS.ProcessEnv)).toBe(enabled);
  });

  it('one read ends before the next one starts', () => {
    expect(GITHUB_STATUS_TIMEOUT_MS).toBeLessThan(GITHUB_STATUS_POLL_INTERVAL_MS);
  });
});
