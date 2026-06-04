import { describe, it, expect } from 'vitest';
import { bucketsFor } from '../services/rateLimitPoller.js';
import type { GitHubRateLimit } from '../services/github.js';

/**
 * Unit tests for the rate-limit poller's pure `/rate_limit` → card mapping.
 * The poll loop itself (workspace iteration, login dedupe) is thin glue over
 * githubService; the interesting logic — which buckets surface, how they're
 * keyed and dated — lives here.
 */

const RESET = 1_900_000_000; // fixed epoch (seconds) — avoids Date.now() in tests

function payload(resources: GitHubRateLimit['resources']): GitHubRateLimit {
  return { resources };
}

describe('bucketsFor', () => {
  it('keys each bucket by "<login> · <resource>" and carries the numbers', () => {
    const out = bucketsFor(
      'octocat',
      payload({ core: { limit: 5000, remaining: 4990, used: 10, reset: RESET } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: 'octocat · core',
      resource: 'core',
      limit: 5000,
      remaining: 4990,
      used: 10,
    });
    expect(out[0].resetAt).toBe(new Date(RESET * 1000).toISOString());
    expect(out[0].description).toContain('REST');
  });

  it('separates accounts so independent budgets never collapse', () => {
    const a = bucketsFor('alice', payload({ core: { limit: 5000, remaining: 100, used: 4900, reset: RESET } }));
    const b = bucketsFor('bob', payload({ core: { limit: 5000, remaining: 4999, used: 1, reset: RESET } }));
    expect(a[0].name).toBe('alice · core');
    expect(b[0].name).toBe('bob · core');
    expect(a[0].remaining).toBe(100);
    expect(b[0].remaining).toBe(4999);
  });

  it('always surfaces the primary buckets even when idle (used = 0)', () => {
    const out = bucketsFor(
      'octocat',
      payload({
        core: { limit: 5000, remaining: 5000, used: 0, reset: RESET },
        graphql: { limit: 5000, remaining: 5000, used: 0, reset: RESET },
        search: { limit: 30, remaining: 30, used: 0, reset: RESET },
      }),
    );
    expect(out.map((b) => b.resource).sort()).toEqual(['core', 'graphql', 'search']);
  });

  it('hides idle non-primary buckets but shows them once used', () => {
    const idle = bucketsFor(
      'octocat',
      payload({ code_search: { limit: 10, remaining: 10, used: 0, reset: RESET } }),
    );
    expect(idle).toHaveLength(0);

    const used = bucketsFor(
      'octocat',
      payload({ code_search: { limit: 10, remaining: 7, used: 3, reset: RESET } }),
    );
    expect(used).toHaveLength(1);
    expect(used[0].name).toBe('octocat · code_search');
  });

  it('reconciles an inconsistent snapshot (remaining stale-high after a window reset)', () => {
    // GitHub returned remaining=limit yet used>0 — the graphql post-reset
    // quirk. The card must not show a 100% bar next to "2,249 used".
    const [b] = bucketsFor(
      'octocat',
      payload({ graphql: { limit: 5000, remaining: 5000, used: 2249, reset: RESET } }),
    );
    expect(b.used).toBe(2249);
    expect(b.remaining).toBe(2751); // limit - used
    expect(b.used + b.remaining).toBe(b.limit); // always internally consistent
  });

  it('reconciles the opposite skew (used stale-low) from the remaining signal', () => {
    const [b] = bucketsFor(
      'octocat',
      payload({ graphql: { limit: 5000, remaining: 2751, used: 0, reset: RESET } }),
    );
    expect(b.remaining).toBe(2751);
    expect(b.used).toBe(2249); // derived from limit - remaining
    expect(b.used + b.remaining).toBe(b.limit);
  });

  it('clamps a used value that exceeds the limit', () => {
    const [b] = bucketsFor(
      'octocat',
      payload({ search: { limit: 30, remaining: 0, used: 45, reset: RESET } }),
    );
    expect(b.used).toBe(30);
    expect(b.remaining).toBe(0);
  });

  it('skips zero/garbage-limit buckets', () => {
    const out = bucketsFor(
      'octocat',
      payload({
        core: { limit: 0, remaining: 0, used: 0, reset: RESET },
        search: { limit: Number.NaN, remaining: 0, used: 5, reset: RESET },
      }),
    );
    expect(out).toHaveLength(0);
  });

  it('tolerates a missing resources map', () => {
    expect(bucketsFor('octocat', { resources: undefined as never })).toEqual([]);
  });
});
