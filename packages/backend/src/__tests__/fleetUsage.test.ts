import { describe, it, expect, vi } from 'vitest';
import {
  fetchClaudeUsage,
  fetchCodexUsage,
  isOverThreshold,
  parseClaudeUsage,
  parseCodexUsage,
  refreshOnce,
  usageIsStale,
  type UsageWindow,
} from '../services/selfHosted/usage.js';

const claudeBody = {
  limits: [
    { kind: 'session', group: 'session', percent: 9, resets_at: '2026-10-21T13:00:00.31+00:00', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 62, resets_at: '2026-10-25T22:00:00+00:00', scope: null },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 3,
      resets_at: '2026-10-25T22:00:00+00:00',
      scope: { model: { id: null, display_name: 'Opus' }, surface: null },
    },
  ],
  five_hour: { utilization: 9, resets_at: '2026-10-21T13:00:00+00:00' },
  extra_usage: { utilization: 80, limit_dollars: 50 },
};

const codexBody = {
  plan_type: 'prolite',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 4, limit_window_seconds: 604800, reset_after_seconds: 534326, reset_at: 1793108080 },
    secondary_window: null,
  },
  additional_rate_limits: null,
};

const w = (usedPercent: number, scopeModel?: string): UsageWindow => ({
  key: 'k',
  label: 'l',
  usedPercent,
  resetsAt: null,
  ...(scopeModel ? { scopeModel } : {}),
});

describe('parseClaudeUsage', () => {
  it('reads limits[] and labels them in plain words', () => {
    const out = parseClaudeUsage(claudeBody)!;
    expect(out.map((x) => [x.label, x.usedPercent, x.scopeModel])).toEqual([
      ['5-hour', 9, undefined],
      ['Weekly', 62, undefined],
      ['Weekly (Opus)', 3, 'Opus'],
    ]);
    expect(out[0].resetsAt).toBe('2026-10-21T13:00:00.310Z');
  });

  it('falls back to the named utilization windows and ignores credit pools', () => {
    const out = parseClaudeUsage({
      five_hour: { utilization: 20, resets_at: '2026-10-21T13:00:00+00:00' },
      seven_day: { utilization: 50 },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 70 },
      extra_usage: { utilization: 99, limit_dollars: 10 },
    })!;
    expect(out.map((x) => [x.label, x.usedPercent, x.scopeModel])).toEqual([
      ['5-hour', 20, undefined],
      ['Weekly', 50, undefined],
      ['Weekly (Sonnet)', 70, 'Sonnet'],
    ]);
  });

  it('falls back when limits[] holds nothing usable', () => {
    const out = parseClaudeUsage({ limits: [{ kind: 'x' }, 5], five_hour: { utilization: 1 } });
    expect(out).toHaveLength(1);
  });

  it.each([null, undefined, 'x', 4, [], {}, { limits: [] }, { limits: 'a' }, { five_hour: { utilization: 'high' } }])(
    'returns null for %j',
    (body) => {
      expect(parseClaudeUsage(body)).toBeNull();
    }
  );

  it('skips a limit without a numeric percent', () => {
    const out = parseClaudeUsage({ limits: [{ kind: 'session', group: 'session', percent: null }, { kind: 'weekly_all', group: 'weekly', percent: 5 }] })!;
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('Weekly');
  });
});

describe('parseCodexUsage', () => {
  it('reads the primary window', () => {
    const out = parseCodexUsage(codexBody)!;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: 'Weekly', usedPercent: 4, resetsAt: new Date(1793108080 * 1000).toISOString() });
  });

  it('reads both windows and labels a 5-hour one', () => {
    const out = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 20, limit_window_seconds: 604800 },
      },
    })!;
    expect(out.map((x) => [x.label, x.usedPercent])).toEqual([['5-hour', 10], ['Weekly', 20]]);
  });

  it('reads additional_rate_limits with the same window shape', () => {
    const out = parseCodexUsage({
      rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18000 } },
      additional_rate_limits: [
        { limit_name: 'Spark', rate_limit: { primary_window: { used_percent: 90, limit_window_seconds: 18000 } } },
      ],
    })!;
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ label: 'Spark 5-hour', usedPercent: 90 });
  });

  it('forces 100 when limit_reached is true', () => {
    const out = parseCodexUsage({
      rate_limit: { limit_reached: true, primary_window: { used_percent: 40, limit_window_seconds: 18000 } },
    })!;
    expect(out[0].usedPercent).toBe(100);
  });

  it('makes a window when limit_reached has none', () => {
    expect(parseCodexUsage({ rate_limit: { limit_reached: true } })![0].usedPercent).toBe(100);
  });

  it.each([null, 'x', [], {}, { rate_limit: null }, { rate_limit: { primary_window: null, secondary_window: null } }, { rate_limit: { primary_window: { used_percent: 'a' } } }])(
    'returns null for %j',
    (body) => {
      expect(parseCodexUsage(body)).toBeNull();
    }
  );
});

describe('isOverThreshold', () => {
  it.each([
    [[w(99)], 100, false],
    [[w(100)], 100, true],
    [[w(94)], 95, false],
    [[w(95)], 95, true],
    [[w(10), w(96)], 95, true],
    [[w(10), w(20)], 95, false],
    [[], 100, false],
  ])('%j at %i -> %s', (windows, threshold, expected) => {
    expect(isOverThreshold(windows, threshold)).toBe(expected);
  });

  it.each([
    ['claude-sonnet-5', false],
    ['claude-opus-4-8', true],
    ['CLAUDE-OPUS-4', true],
    [undefined, true],
  ])('scoped Opus window with model %s -> %s', (model, expected) => {
    expect(isOverThreshold([w(100, 'Opus')], 100, model)).toBe(expected);
  });
});

describe('usageIsStale', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  it.each([
    [null, true],
    [undefined, true],
    [{ fetchedAt: 'garbage' }, true],
    [{ fetchedAt: '2026-10-21T11:59:00Z' }, false],
    [{ fetchedAt: '2026-10-21T11:58:00Z' }, false],
    [{ fetchedAt: '2026-10-21T11:57:59Z' }, true],
  ])('%j -> %s at 2 min', (snap, expected) => {
    expect(usageIsStale(snap, 120_000, now)).toBe(expected);
  });
});

describe('refreshOnce', () => {
  it('shares one run between concurrent callers, then allows a new one', async () => {
    const fn = vi.fn(async () => {
      await Promise.resolve();
      return 7;
    });
    const [a, b] = await Promise.all([refreshOnce('acct', fn), refreshOnce('acct', fn)]);
    expect([a, b]).toEqual([7, 7]);
    expect(fn).toHaveBeenCalledTimes(1);
    await refreshOnce('acct', fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('keeps keys apart and clears after a failure', async () => {
    await expect(refreshOnce('a', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(refreshOnce('a', async () => 1)).resolves.toBe(1);
    const fn = vi.fn(async () => 1);
    await Promise.all([refreshOnce('p', fn), refreshOnce('q', fn)]);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

const respond = (status: number, body: unknown) =>
  (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('fetchClaudeUsage / fetchCodexUsage', () => {
  it('parses a 200 and sends the right headers', async () => {
    const impl = vi.fn(respond(200, claudeBody));
    const res = await fetchClaudeUsage('tok-fake', impl);
    expect(res.ok && res.windows).toHaveLength(3);
    const [url, init] = impl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok-fake', 'anthropic-beta': 'oauth-2025-04-20' });

    const cImpl = vi.fn(respond(200, codexBody));
    const c = await fetchCodexUsage('tok-fake', 'acct-1', cImpl);
    expect(c.ok).toBe(true);
    expect((cImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({
      'chatgpt-account-id': 'acct-1',
      originator: 'codex_cli_rs',
    });
  });

  it.each([
    ['claude', (i: typeof fetch) => fetchClaudeUsage('t', i)],
    ['codex', (i: typeof fetch) => fetchCodexUsage('t', 'a', i)],
  ])('%s: 401 means token expired', async (_n, run) => {
    const res = await run(respond(401, { error: { code: 'token_expired' } }));
    expect(res).toEqual({ ok: false, error: 'token_expired', tokenExpired: true });
  });

  it.each([
    ['claude', (i: typeof fetch) => fetchClaudeUsage('t', i)],
    ['codex', (i: typeof fetch) => fetchCodexUsage('t', 'a', i)],
  ])('%s: 500, bad JSON and unknown shape fail soft', async (_n, run) => {
    expect(await run(respond(500, 'boom'))).toMatchObject({ ok: false, error: expect.stringContaining('500') });
    expect(await run(respond(200, 'not json'))).toMatchObject({ ok: false });
    expect(await run(respond(200, {}))).toMatchObject({ ok: false });
  });

  it('reports a network failure without leaking the token', async () => {
    const res = await fetchClaudeUsage('secret-token', (async () => { throw new Error('secret-token boom'); }) as unknown as typeof fetch);
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain('secret-token');
  });

  it('times out after 10 seconds', async () => {
    vi.useFakeTimers();
    try {
      const hang = ((_u: string, init: RequestInit) =>
        new Promise((_r, reject) => {
          init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch;
      const p = fetchClaudeUsage('t', hang);
      await vi.advanceTimersByTimeAsync(10_001);
      const res = await p;
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining('timed out') });
    } finally {
      vi.useRealTimers();
    }
  });
});
