import { describe, it, expect } from 'vitest';
import type { GithubHealthState, GithubTrafficHealth } from '@talyn/shared';
import {
  GITHUB_HEALTH_BUCKET_MS,
  GITHUB_HEALTH_DEGRADED_SHARE,
  GITHUB_HEALTH_DOWN_SHARE,
  GITHUB_HEALTH_MIN_SAMPLE,
  GITHUB_HEALTH_RECOVERY_MS,
  GITHUB_HEALTH_WINDOW_MS,
  GITHUB_STATUS_STALE_MS,
  GithubApiWindow,
  GithubTrafficTracker,
  classifyGithubResponse,
  combineGithubHealth,
  githubApiForUrl,
  githubHealthChangeKey,
  githubStatusPageState,
  parseGithubStatusPage,
  worseGithubState,
  type GithubStatusReading,
} from '../services/githubHealth.js';

const T0 = Date.parse('2026-10-07T03:00:00.000Z');

function response(status: number, headers: Record<string, string> = {}, bodyText = '') {
  return { status, headers: new Headers(headers), bodyText };
}

describe('classifyGithubResponse', () => {
  it.each([500, 502, 503, 504])('counts HTTP %i as a server failure', (status) => {
    expect(classifyGithubResponse(response(status))).toBe('server_failure');
  });

  it('counts a transport failure (no response) as a server failure', () => {
    expect(classifyGithubResponse(null)).toBe('server_failure');
  });

  it.each([200, 201, 204, 301, 302, 304])('counts HTTP %i as ok', (status) => {
    expect(classifyGithubResponse(response(status))).toBe('ok');
  });

  // GitHub was up and answered. None of these is an outage.
  it.each([400, 401, 403, 404, 405, 409, 410, 422, 451])('counts HTTP %i as ok', (status) => {
    expect(classifyGithubResponse(response(status))).toBe('ok');
  });

  it.each([
    ['429', response(429)],
    ['429 with retry-after', response(429, { 'retry-after': '60' })],
    ['403 with retry-after', response(403, { 'retry-after': '30' })],
    ['403 with the budget at zero', response(403, { 'x-ratelimit-remaining': '0' })],
    ['403 secondary limit body', response(403, {}, 'You have exceeded a secondary rate limit.')],
  ])('never counts a rate limit as a server failure: %s', (_name, r) => {
    expect(classifyGithubResponse(r)).toBe('ok');
  });

  // Statuses that are 5xx but not on the outage list stay out of the count.
  it.each([501, 505])('does not count HTTP %i', (status) => {
    expect(classifyGithubResponse(response(status))).toBe('ok');
  });
});

describe('githubApiForUrl', () => {
  it.each([
    ['https://api.github.com/graphql', 'graphql'],
    ['https://api.github.com/graphql?x=1', 'graphql'],
    ['https://api.github.com/repos/a/b/pulls/1/merge', 'rest'],
    ['https://api.github.com/app/installations/1/access_tokens', 'rest'],
    ['https://github.com/login/oauth/access_token', 'rest'],
    ['https://api.github.com/repos/a/graphql/pulls', 'rest'],
  ] as const)('%s is %s', (url, api) => {
    expect(githubApiForUrl(url)).toBe(api);
  });
});

describe('worseGithubState', () => {
  it.each([
    ['unknown', 'unknown', 'unknown'],
    ['unknown', 'operational', 'operational'],
    ['operational', 'unknown', 'operational'],
    ['operational', 'degraded', 'degraded'],
    ['degraded', 'down', 'down'],
    ['down', 'unknown', 'down'],
    ['down', 'operational', 'down'],
  ] as const)('%s and %s is %s', (a, b, expected) => {
    expect(worseGithubState(a, b)).toBe(expected);
  });
});

/** Record `ok` good calls and `failed` server failures at one instant. */
function feed(w: GithubApiWindow, now: number, ok: number, failed: number): void {
  for (let i = 0; i < failed; i += 1) w.record('server_failure', now);
  for (let i = 0; i < ok; i += 1) w.record('ok', now);
}

describe('GithubApiWindow', () => {
  it('starts unknown', () => {
    expect(new GithubApiWindow().read(T0)).toEqual({ requests: 0, serverFailures: 0, state: 'unknown' });
  });

  it('the constants divide into a whole number of buckets', () => {
    expect(GITHUB_HEALTH_WINDOW_MS % GITHUB_HEALTH_BUCKET_MS).toBe(0);
    expect(new GithubApiWindow().bucketCount()).toBe(GITHUB_HEALTH_WINDOW_MS / GITHUB_HEALTH_BUCKET_MS);
  });

  describe('minimum sample', () => {
    it.each([1, 2, GITHUB_HEALTH_MIN_SAMPLE - 1])(
      'stays unknown on %i calls, even when all of them failed',
      (n) => {
        const w = new GithubApiWindow();
        feed(w, T0, 0, n);
        expect(w.read(T0)).toEqual({ requests: n, serverFailures: n, state: 'unknown' });
      },
    );

    it('reads operational once enough good calls are in', () => {
      const w = new GithubApiWindow();
      feed(w, T0, GITHUB_HEALTH_MIN_SAMPLE, 0);
      expect(w.read(T0).state).toBe('operational');
    });

    // One GraphQL query tries three times. Three failures must not raise
    // anything, whatever share of the traffic they are.
    it.each([1, 2, GITHUB_HEALTH_MIN_SAMPLE - 1])(
      'stays operational on %i failures among a few calls',
      (failed) => {
        const w = new GithubApiWindow();
        feed(w, T0, 2, failed);
        if (2 + failed >= GITHUB_HEALTH_MIN_SAMPLE) expect(w.read(T0).state).toBe('operational');
        else expect(w.read(T0).state).toBe('unknown');
      },
    );

    it('reads down when the minimum number of calls all failed', () => {
      const w = new GithubApiWindow();
      feed(w, T0, 0, GITHUB_HEALTH_MIN_SAMPLE);
      expect(w.read(T0).state).toBe('down');
    });
  });

  describe('thresholds', () => {
    it.each([
      // [ok, failed, state]
      [96, 4, 'operational'],
      [80, 20, 'operational'],
      [76, 24, 'operational'],
      [75, 25, 'degraded'],
      [60, 40, 'degraded'],
      [51, 49, 'degraded'],
      [50, 50, 'down'],
      [10, 90, 'down'],
      [0, 100, 'down'],
    ] as const)('%i ok and %i failed reads %s', (ok, failed, state) => {
      const w = new GithubApiWindow();
      // Good calls first, so the state is reached once and never has to recover.
      for (let i = 0; i < ok; i += 1) w.record('ok', T0);
      for (let i = 0; i < failed; i += 1) w.record('server_failure', T0);
      expect(w.read(T0)).toEqual({ requests: ok + failed, serverFailures: failed, state });
    });

    it('the two shares are ordered', () => {
      expect(GITHUB_HEALTH_DEGRADED_SHARE).toBeLessThan(GITHUB_HEALTH_DOWN_SHARE);
    });
  });

  describe('bucket expiry', () => {
    it('keeps a call for the whole window and drops it after', () => {
      const w = new GithubApiWindow();
      feed(w, T0, GITHUB_HEALTH_MIN_SAMPLE, 0);
      expect(w.read(T0 + GITHUB_HEALTH_WINDOW_MS - GITHUB_HEALTH_BUCKET_MS).requests).toBe(
        GITHUB_HEALTH_MIN_SAMPLE,
      );
      expect(w.read(T0 + GITHUB_HEALTH_WINDOW_MS).requests).toBe(0);
      expect(w.read(T0 + GITHUB_HEALTH_WINDOW_MS).state).toBe('unknown');
    });

    it('reuses a bucket slot without keeping its old counts', () => {
      const w = new GithubApiWindow();
      feed(w, T0, 10, 0);
      // Exactly one window later the same slot index comes round again.
      w.record('ok', T0 + GITHUB_HEALTH_WINDOW_MS);
      expect(w.read(T0 + GITHUB_HEALTH_WINDOW_MS).requests).toBe(1);
    });

    it('never grows: a day of traffic leaves the bucket count as it was', () => {
      const w = new GithubApiWindow();
      const before = w.bucketCount();
      for (let t = 0; t < 24 * 60 * 60_000; t += 7_000) w.record(t % 3 ? 'ok' : 'server_failure', T0 + t);
      expect(w.bucketCount()).toBe(before);
      expect(w.read(T0 + 24 * 60 * 60_000).requests).toBeLessThanOrEqual(
        Math.ceil(GITHUB_HEALTH_WINDOW_MS / 7_000) + 1,
      );
    });
  });

  describe('hysteresis', () => {
    it('gets worse at once', () => {
      const w = new GithubApiWindow();
      feed(w, T0, 20, 0);
      expect(w.read(T0).state).toBe('operational');
      feed(w, T0 + 1_000, 0, 10);
      expect(w.read(T0 + 1_000).state).toBe('degraded');
      feed(w, T0 + 2_000, 0, 20);
      expect(w.read(T0 + 2_000).state).toBe('down');
    });

    it('does not recover on the first good calls', () => {
      const w = new GithubApiWindow();
      feed(w, T0, 0, 10);
      feed(w, T0 + 10_000, 50, 0);
      // The share is now far below both thresholds, and it is still down.
      expect(w.read(T0 + 10_000)).toMatchObject({ requests: 60, serverFailures: 10, state: 'down' });
      expect(w.read(T0 + GITHUB_HEALTH_RECOVERY_MS - 1).state).toBe('down');
    });

    it('recovers once the better reading has lasted the recovery time', () => {
      const w = new GithubApiWindow();
      feed(w, T0, 0, 10);
      feed(w, T0 + 10_000, 50, 0);
      expect(w.read(T0 + 10_000 + GITHUB_HEALTH_RECOVERY_MS).state).toBe('operational');
    });

    it('recovers on a clean run even while old failures fill the window', () => {
      const w = new GithubApiWindow();
      feed(w, T0, 0, 100);
      const later = T0 + GITHUB_HEALTH_RECOVERY_MS;
      for (let i = 0; i < GITHUB_HEALTH_MIN_SAMPLE; i += 1) w.record('ok', later - 1_000);
      // 100 failures and 4 good calls: by share alone this is an outage.
      expect(w.read(later - 1_000).state).toBe('down');
      expect(w.read(later).state).toBe('operational');
      // The emptied buckets cannot raise it again on the next call.
      w.record('ok', later + 1_000);
      expect(w.read(later + 1_000).state).not.toBe('down');
      expect(w.read(later + 1_000).serverFailures).toBe(0);
    });

    it('a clean run needs enough good calls, not only time', () => {
      const w = new GithubApiWindow();
      feed(w, T0, 0, 100);
      w.record('ok', T0 + 1_000);
      expect(w.read(T0 + GITHUB_HEALTH_RECOVERY_MS + 1_000).state).toBe('down');
    });

    it('a new failure restarts the wait', () => {
      const w = new GithubApiWindow();
      feed(w, T0, 0, 100);
      feed(w, T0 + 60_000, 10, 0);
      w.record('server_failure', T0 + 90_000);
      feed(w, T0 + 100_000, 10, 0);
      // Two minutes after the first failures, but only 30 s after the last one.
      expect(w.read(T0 + GITHUB_HEALTH_RECOVERY_MS).state).toBe('down');
      expect(w.read(T0 + 90_000 + GITHUB_HEALTH_RECOVERY_MS).state).toBe('operational');
    });

    it('steps from down to degraded only after the recovery time', () => {
      const w = new GithubApiWindow();
      feed(w, T0, 0, 10);
      // One failure in seven keeps arriving, so there is never a clean run.
      // The share drops under one half at the third step (13 of 31).
      const states: string[] = [];
      for (let step = 1; step <= 9; step += 1) {
        feed(w, T0 + step * 20_000, 6, 1);
        states.push(w.read(T0 + step * 20_000).state);
      }
      // Better from step 3 (60 s), believed at step 9 (180 s): 19 of 73, 26%.
      expect(states).toEqual([
        'down', 'down', 'down', 'down', 'down', 'down', 'down', 'down', 'degraded',
      ]);
    });

    it('goes quiet, then unknown, when traffic stops during an outage', () => {
      const w = new GithubApiWindow();
      feed(w, T0, 0, 10);
      const emptied = T0 + GITHUB_HEALTH_WINDOW_MS;
      // The window is empty. That is better than `down` only in the sense that
      // nothing is known, and it too must last before it is believed.
      expect(w.read(emptied).state).toBe('down');
      expect(w.read(emptied + GITHUB_HEALTH_RECOVERY_MS).state).toBe('unknown');
    });

    it('moves between unknown and operational with no wait', () => {
      const w = new GithubApiWindow();
      feed(w, T0, GITHUB_HEALTH_MIN_SAMPLE, 0);
      expect(w.read(T0).state).toBe('operational');
      expect(w.read(T0 + GITHUB_HEALTH_WINDOW_MS).state).toBe('unknown');
    });
  });
});

describe('GithubTrafficTracker', () => {
  it('keeps the two APIs apart', () => {
    const t = new GithubTrafficTracker();
    for (let i = 0; i < 10; i += 1) t.record('graphql', 'server_failure', T0);
    for (let i = 0; i < 10; i += 1) t.record('rest', 'ok', T0);
    const read = t.read(T0);
    expect(read.graphql).toEqual({ requests: 10, serverFailures: 10, state: 'down' });
    expect(read.rest).toEqual({ requests: 10, serverFailures: 0, state: 'operational' });
    expect(read.state).toBe('down');
    expect(read.windowMs).toBe(GITHUB_HEALTH_WINDOW_MS);
  });

  it.each([
    ['rest', 'graphql'],
    ['graphql', 'rest'],
  ] as const)('an outage of %s alone does not need any %s traffic', (bad, other) => {
    const t = new GithubTrafficTracker();
    for (let i = 0; i < 4; i += 1) t.record(bad, 'server_failure', T0);
    expect(t.read(T0)[bad].state).toBe('down');
    expect(t.read(T0)[other].state).toBe('unknown');
    expect(t.read(T0).state).toBe('down');
  });

  it('calls the listener only when the overall state changes', () => {
    const t = new GithubTrafficTracker();
    const states: GithubHealthState[] = [];
    t.setListener(() => states.push(t.read(T0).state));
    for (let i = 0; i < 10; i += 1) t.record('rest', 'ok', T0);
    for (let i = 0; i < 10; i += 1) t.record('rest', 'server_failure', T0);
    expect(states).toEqual(['operational', 'degraded', 'down']);
  });

  it('a throwing listener does not break the caller', () => {
    const t = new GithubTrafficTracker();
    t.setListener(() => {
      throw new Error('boom');
    });
    expect(() => {
      for (let i = 0; i < 4; i += 1) t.record('rest', 'ok', T0);
    }).not.toThrow();
  });

  it('_reset drops the counts', () => {
    const t = new GithubTrafficTracker();
    for (let i = 0; i < 10; i += 1) t.record('rest', 'server_failure', T0);
    t._reset();
    expect(t.read(T0).state).toBe('unknown');
    expect(t.read(T0).rest.requests).toBe(0);
  });
});

// ---- Status page -------------------------------------------------------------

const ALL_COMPONENTS = [
  'Git Operations',
  'Webhooks',
  'API Requests',
  'Issues',
  'Pull Requests',
  'Actions',
  'Packages',
  'Pages',
  'Codespaces',
  'Copilot',
];

function summary(
  overrides: {
    indicator?: string;
    statuses?: Record<string, string>;
    incidents?: unknown[];
  } = {},
): unknown {
  return {
    page: { id: 'kctbh9vrtdwd', name: 'GitHub', url: 'https://www.githubstatus.com' },
    status: { indicator: overrides.indicator ?? 'none', description: 'All Systems Operational' },
    components: ALL_COMPONENTS.map((name) => ({
      id: name,
      name,
      status: overrides.statuses?.[name] ?? 'operational',
    })),
    incidents: overrides.incidents ?? [],
    scheduled_maintenances: [],
  };
}

function incident(name: string, components?: string[], extra: Record<string, unknown> = {}) {
  return {
    name,
    status: 'investigating',
    impact: 'major',
    shortlink: 'https://stspg.io/abc123',
    started_at: '2026-10-07T02:50:00.000Z',
    ...(components ? { components: components.map((n) => ({ name: n })) } : {}),
    ...extra,
  };
}

const read = (body: unknown): GithubStatusReading => {
  const reading = parseGithubStatusPage(body, T0);
  if (!reading) throw new Error('expected a reading');
  return reading;
};

describe('parseGithubStatusPage', () => {
  it('reads an all-operational page', () => {
    const reading = read(summary());
    expect(reading.indicator).toBe('none');
    expect(reading.incidents).toEqual([]);
    expect(reading.fetchedAtMs).toBe(T0);
    expect(githubStatusPageState(reading, T0)).toBe('operational');
  });

  it('keeps only the components Talyn depends on', () => {
    expect(read(summary()).components.map((c) => c.name).sort()).toEqual([
      'API Requests',
      'Actions',
      'Git Operations',
      'Pull Requests',
      'Webhooks',
    ]);
  });

  it('reads an incident with its link, impact and start', () => {
    const reading = read(
      summary({
        indicator: 'major',
        statuses: { 'Pull Requests': 'partial_outage' },
        incidents: [incident('Disruption with Pull Requests', ['Pull Requests'])],
      }),
    );
    expect(reading.incidents).toEqual([
      {
        name: 'Disruption with Pull Requests',
        url: 'https://stspg.io/abc123',
        impact: 'major',
        startedAt: '2026-10-07T02:50:00.000Z',
        relevant: true,
      },
    ]);
  });

  it('marks an incident on an unrelated component as not relevant, and keeps it', () => {
    const reading = read(
      summary({
        indicator: 'minor',
        statuses: { Copilot: 'degraded_performance' },
        incidents: [incident('Copilot is slow', ['Copilot'])],
      }),
    );
    expect(reading.incidents).toHaveLength(1);
    expect(reading.incidents[0].relevant).toBe(false);
    expect(githubStatusPageState(reading, T0)).toBe('operational');
  });

  it.each([
    [{ Actions: 'degraded_performance' }, true],
    [{ Codespaces: 'major_outage' }, false],
    [{}, false],
  ] as const)(
    'judges an incident that names no component by the components: %j',
    (statuses, relevant) => {
      const reading = read(summary({ statuses, incidents: [incident('Something')] }));
      expect(reading.incidents[0].relevant).toBe(relevant);
    },
  );

  it.each(['resolved', 'postmortem'])('skips a %s incident', (status) => {
    expect(read(summary({ incidents: [incident('Old', undefined, { status })] })).incidents).toEqual([]);
  });

  it('matches component names in any case', () => {
    const reading = read({
      status: { indicator: 'major' },
      components: [{ name: 'api requests', status: 'major_outage' }],
    });
    expect(githubStatusPageState(reading, T0)).toBe('down');
  });

  it.each([
    ['null', null],
    ['a string', 'Service Unavailable'],
    ['a number', 503],
    ['an array', []],
    ['an empty object', {}],
    ['an object that is not the summary', { message: 'Not Found' }],
  ])('answers null for %s', (_name, body) => {
    expect(parseGithubStatusPage(body, T0)).toBeNull();
  });

  it.each([
    ['no components', { status: { indicator: 'none' } }],
    ['no status', { components: [] }],
    ['components that is not an array', { status: { indicator: 'none' }, components: 'x' }],
    ['incidents that is not an array', { status: {}, components: [], incidents: { a: 1 } }],
    [
      'entries of the wrong type',
      {
        status: { indicator: 7 },
        components: [null, 3, 'x', { name: 5 }, { name: 'Webhooks' }, { status: 'operational' }],
        incidents: [null, 'x', { name: 9 }, {}],
      },
    ],
  ])('does not throw on %s', (_name, body) => {
    const reading = parseGithubStatusPage(body, T0);
    expect(reading).not.toBeNull();
    expect(reading!.components).toEqual([]);
    expect(reading!.incidents).toEqual([]);
    expect(githubStatusPageState(reading, T0)).toBe('operational');
  });

  it('reads an incident with missing fields as nulls', () => {
    const reading = read({ status: {}, components: [], incidents: [{ name: 'Bare' }] });
    expect(reading.indicator).toBeNull();
    expect(reading.incidents).toEqual([
      { name: 'Bare', url: null, impact: null, startedAt: null, relevant: false },
    ]);
  });

  it('falls back to created_at for the start', () => {
    const reading = read({
      status: {},
      components: [],
      incidents: [{ name: 'X', created_at: '2026-10-07T01:00:00.000Z' }],
    });
    expect(reading.incidents[0].startedAt).toBe('2026-10-07T01:00:00.000Z');
  });
});

describe('githubStatusPageState', () => {
  it('is unknown with no reading', () => {
    expect(githubStatusPageState(null, T0)).toBe('unknown');
  });

  const RELIED = ['API Requests', 'Webhooks', 'Pull Requests', 'Git Operations', 'Actions'];

  it.each(RELIED.flatMap((name) => ['degraded_performance', 'partial_outage'].map((s) => [name, s])))(
    '%s at %s is degraded',
    (name, status) => {
      expect(githubStatusPageState(read(summary({ statuses: { [name]: status } })), T0)).toBe('degraded');
    },
  );

  it.each(RELIED.filter((n) => n !== 'API Requests'))('%s at major_outage is degraded', (name) => {
    expect(
      githubStatusPageState(read(summary({ indicator: 'major', statuses: { [name]: 'major_outage' } })), T0),
    ).toBe('degraded');
  });

  it('API Requests at major_outage is down', () => {
    expect(
      githubStatusPageState(read(summary({ statuses: { 'API Requests': 'major_outage' } })), T0),
    ).toBe('down');
  });

  it('a critical indicator with one of our components unwell is down', () => {
    expect(
      githubStatusPageState(
        read(summary({ indicator: 'critical', statuses: { Webhooks: 'partial_outage' } })),
        T0,
      ),
    ).toBe('down');
  });

  it.each(['minor', 'major', 'critical'])(
    'a %s indicator that touches none of our components is operational',
    (indicator) => {
      expect(
        githubStatusPageState(
          read(summary({ indicator, statuses: { Codespaces: 'major_outage', Copilot: 'major_outage' } })),
          T0,
        ),
      ).toBe('operational');
    },
  );

  it.each(['operational', 'under_maintenance', 'something_new'])(
    'a component status of %s raises nothing',
    (status) => {
      expect(
        githubStatusPageState(read(summary({ statuses: { 'API Requests': status } })), T0),
      ).toBe('operational');
    },
  );

  it.each([
    [0, 'degraded'],
    [GITHUB_STATUS_STALE_MS, 'degraded'],
    [GITHUB_STATUS_STALE_MS + 1, 'unknown'],
    [60 * 60_000, 'unknown'],
  ] as const)('a reading %i ms old is %s', (age, state) => {
    const reading = read(summary({ statuses: { Actions: 'partial_outage' } }));
    expect(githubStatusPageState(reading, T0 + age)).toBe(state);
  });

  it('a stale healthy reading is unknown too, not healthy', () => {
    expect(githubStatusPageState(read(summary()), T0 + GITHUB_STATUS_STALE_MS + 1)).toBe('unknown');
  });
});

// ---- Combination -------------------------------------------------------------

function traffic(state: GithubHealthState): GithubTrafficHealth {
  const api = { requests: 10, serverFailures: state === 'down' ? 10 : state === 'degraded' ? 3 : 0, state };
  return { rest: api, graphql: { requests: 0, serverFailures: 0, state: 'unknown' }, state, windowMs: 1 };
}

function page(state: GithubHealthState): GithubStatusReading | null {
  if (state === 'unknown') return null;
  if (state === 'operational') return read(summary());
  if (state === 'degraded') {
    return read(
      summary({
        indicator: 'minor',
        statuses: { Actions: 'degraded_performance' },
        incidents: [incident('Actions is slow', ['Actions'])],
      }),
    );
  }
  return read(
    summary({
      indicator: 'critical',
      statuses: { 'API Requests': 'major_outage' },
      incidents: [incident('API is down', ['API Requests'])],
    }),
  );
}

describe('combineGithubHealth', () => {
  it.each([
    // [traffic, status page, state, source]
    ['unknown', 'unknown', 'unknown', null],
    ['unknown', 'operational', 'operational', null],
    ['unknown', 'degraded', 'degraded', 'status_page'],
    ['unknown', 'down', 'down', 'status_page'],
    ['operational', 'unknown', 'operational', null],
    ['operational', 'operational', 'operational', null],
    ['operational', 'degraded', 'degraded', 'status_page'],
    ['operational', 'down', 'down', 'status_page'],
    ['degraded', 'unknown', 'degraded', 'traffic'],
    ['degraded', 'operational', 'degraded', 'traffic'],
    ['degraded', 'degraded', 'degraded', 'both'],
    ['degraded', 'down', 'down', 'both'],
    ['down', 'unknown', 'down', 'traffic'],
    ['down', 'operational', 'down', 'traffic'],
    ['down', 'degraded', 'down', 'both'],
    ['down', 'down', 'down', 'both'],
  ] as const)('traffic %s + status page %s → %s from %s', (t, p, state, source) => {
    const health = combineGithubHealth(traffic(t), page(p), T0);
    expect(health.state).toBe(state);
    expect(health.source).toBe(source);
    expect(health.updatedAt).toBe(new Date(T0).toISOString());
    expect(health.traffic.state).toBe(t);
    if (p === 'unknown') expect(health.statusPage).toBeNull();
    else expect(health.statusPage?.state).toBe(p);
  });

  it('a stale status page counts as unknown and stays in the payload with its age', () => {
    const health = combineGithubHealth(traffic('operational'), page('down'), T0 + GITHUB_STATUS_STALE_MS + 1);
    expect(health.state).toBe('operational');
    expect(health.source).toBeNull();
    expect(health.statusPage?.state).toBe('unknown');
    expect(health.statusPage?.fetchedAt).toBe(new Date(T0).toISOString());
  });

  it('keeps an unrelated incident in the payload while the state stays operational', () => {
    const reading = read(
      summary({
        indicator: 'major',
        statuses: { Codespaces: 'major_outage' },
        incidents: [incident('Codespaces is down', ['Codespaces'])],
      }),
    );
    const health = combineGithubHealth(traffic('operational'), reading, T0);
    expect(health.state).toBe('operational');
    expect(health.source).toBeNull();
    expect(health.statusPage?.incidents.map((i) => i.name)).toEqual(['Codespaces is down']);
  });

  describe('since', () => {
    it.each(['operational', 'unknown'] as const)('is null while %s', (state) => {
      expect(combineGithubHealth(traffic(state), null, T0).since).toBeNull();
    });

    it.each(['degraded', 'down'] as const)('starts when %s begins', (state) => {
      expect(combineGithubHealth(traffic(state), null, T0).since).toBe(new Date(T0).toISOString());
    });

    it('is kept across ticks of the same state', () => {
      const first = combineGithubHealth(traffic('down'), null, T0);
      const second = combineGithubHealth(traffic('down'), null, T0 + 60_000, first);
      const third = combineGithubHealth(traffic('down'), null, T0 + 120_000, second);
      expect(third.since).toBe(first.since);
      expect(third.updatedAt).toBe(new Date(T0 + 120_000).toISOString());
    });

    it.each([
      ['degraded', 'down'],
      ['down', 'degraded'],
    ] as const)('starts again when %s becomes %s', (from, to) => {
      const first = combineGithubHealth(traffic(from), null, T0);
      const second = combineGithubHealth(traffic(to), null, T0 + 60_000, first);
      expect(second.since).toBe(new Date(T0 + 60_000).toISOString());
    });

    it('is cleared on recovery and starts fresh on the next incident', () => {
      const first = combineGithubHealth(traffic('down'), null, T0);
      const second = combineGithubHealth(traffic('operational'), null, T0 + 60_000, first);
      expect(second.since).toBeNull();
      const third = combineGithubHealth(traffic('down'), null, T0 + 120_000, second);
      expect(third.since).toBe(new Date(T0 + 120_000).toISOString());
    });
  });
});

describe('githubHealthChangeKey', () => {
  const key = (t: GithubHealthState, reading: GithubStatusReading | null, now = T0) =>
    githubHealthChangeKey(combineGithubHealth(traffic(t), reading, now));

  it('is the same for the same state and incidents, whatever the counts and time', () => {
    expect(key('down', page('down'))).toBe(key('down', page('down'), T0 + 30_000));
  });

  it('changes with the state', () => {
    expect(key('down', null)).not.toBe(key('degraded', null));
  });

  it('changes with the set of incidents, not with their order', () => {
    const one = read(summary({ incidents: [incident('A'), incident('B')] }));
    const reordered = read(summary({ incidents: [incident('B'), incident('A')] }));
    const more = read(summary({ incidents: [incident('A'), incident('B'), incident('C')] }));
    expect(key('operational', one)).toBe(key('operational', reordered));
    expect(key('operational', one)).not.toBe(key('operational', more));
  });

  it('a stale page lists no incidents', () => {
    const stale = T0 + GITHUB_STATUS_STALE_MS + 1;
    expect(key('operational', page('degraded'), stale)).toBe(key('operational', null, stale));
  });
});
