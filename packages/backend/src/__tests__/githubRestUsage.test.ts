import { describe, it, expect } from 'vitest';
import {
  endpointShape,
  RestUsageCounter,
  REST_USAGE_WINDOW_MS,
  REST_USAGE_REPORT_PER_HOUR,
} from '../services/githubRestUsage.js';

describe('endpointShape', () => {
  it.each([
    ['GET', '/repos/PostHog/posthog', 'GET /repos/:owner/:repo'],
    ['get', '/repos/PostHog/posthog/pulls/121865', 'GET /repos/:owner/:repo/pulls/:n'],
    [
      'GET',
      '/repos/PostHog/posthog/commits/0123456789abcdef0123456789abcdef01234567/check-runs?per_page=100&page=2',
      'GET /repos/:owner/:repo/commits/:sha/check-runs',
    ],
    ['POST', '/repos/a/b/check-runs/42/rerequest', 'POST /repos/:owner/:repo/check-runs/:n/rerequest'],
    ['GET', '/user/teams?per_page=100', 'GET /user/teams'],
    ['GET', '/user', 'GET /user'],
    ['GET', '/repos/a/b/branches/master/rules', 'GET /repos/:owner/:repo/branches/master/rules'],
  ])('%s %s → %s', (method, endpoint, expected) => {
    expect(endpointShape(method, endpoint)).toBe(expected);
  });
});

describe('RestUsageCounter', () => {
  const T0 = 1_700_000_000_000;
  // Calls in one window that put an account exactly on the reporting pace.
  const atPace = Math.ceil((REST_USAGE_REPORT_PER_HOUR * REST_USAGE_WINDOW_MS) / 3_600_000);

  it('reports nothing until a window has run its length', () => {
    const c = new RestUsageCounter(T0);
    for (let i = 0; i < atPace * 2; i++) {
      expect(c.record('acct', 'GET /user', T0 + i)).toEqual([]);
    }
  });

  it.each([
    ['an account at the reporting pace is reported', atPace, 1],
    ['an account below it is not', atPace - 1, 0],
  ])('%s', (_label, calls, lines) => {
    const c = new RestUsageCounter(T0);
    for (let i = 0; i < calls; i++) c.record('acct', 'GET /user', T0 + 1);
    expect(c.record('acct', 'GET /user', T0 + REST_USAGE_WINDOW_MS)).toHaveLength(lines);
  });

  it('names the busiest shapes first and sums the rest', () => {
    const c = new RestUsageCounter(T0, 60_000, 1);
    for (let i = 0; i < 12; i++) {
      for (let n = 0; n <= i; n++) c.record('Gilbert09', `GET /shape-${i}`, T0 + 1);
    }
    const [line] = c.record('Gilbert09', 'GET /next', T0 + 60_000);
    expect(line).toMatch(/^\[github-rest\] Gilbert09: ~4680\/h \(78 calls in 1\.0 min\): GET \/shape-11 12, GET \/shape-10 11,/);
    // Ten named, then the two quietest summed.
    expect(line).toMatch(/GET \/shape-2 3, 2 other shapes 3$/);
  });

  it('starts a new window with the call that closed the old one', () => {
    const c = new RestUsageCounter(T0, 60_000, 1);
    c.record('acct', 'GET /a', T0);
    c.record('acct', 'GET /b', T0 + 60_000); // closes window 1, counts in window 2
    const [line] = c.record('acct', 'GET /c', T0 + 120_000);
    expect(line).toContain('(1 calls in 1.0 min): GET /b 1');
  });

  it('reports each account on its own line and skips quiet ones', () => {
    const c = new RestUsageCounter(T0, 60_000, 100);
    for (let i = 0; i < 5; i++) c.record('busy', 'GET /a', T0 + 1);
    c.record('quiet', 'GET /a', T0 + 1);
    const lines = c.record('busy', 'GET /a', T0 + 60_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[github-rest] busy:');
  });
});
