import { describe, it, expect, beforeEach } from 'vitest';
import {
  bucketFactor,
  rateBudgetGovernor,
  MAX_FACTOR,
} from '../services/rateBudgetGovernor.js';
import { githubRateGate } from '../services/githubRateGate.js';
import type { GitHubRateLimitResource } from '../services/github.js';

/**
 * The adaptive-cadence governor's pace model: compare fraction-of-budget-used
 * against fraction-of-window-elapsed and stretch poll cadence when we're ahead
 * of pace, so usage glides under the per-account limit instead of slamming it.
 */

const NOW = 1_700_000_000_000; // fixed epoch (ms)
const nowSecs = Math.floor(NOW / 1000);

/** A resource bucket whose reset is `secondsOut` seconds from NOW. */
function bucket(
  over: Partial<GitHubRateLimitResource> & { secondsOut: number },
): GitHubRateLimitResource {
  const limit = over.limit ?? 30;
  return {
    limit,
    remaining: over.remaining ?? limit - (over.used ?? 0),
    used: over.used ?? 0,
    reset: nowSecs + over.secondsOut,
  };
}

beforeEach(() => {
  rateBudgetGovernor._reset();
  githubRateGate._reset();
});

describe('bucketFactor', () => {
  it('returns 1 for a bucket we do not model', () => {
    expect(bucketFactor('audit_log', bucket({ secondsOut: 30, used: 1000 }), NOW)).toBe(1);
  });

  it('returns 1 when plenty of budget remains', () => {
    // search: 60s window, 30s left; 20/30 left → above the safe line.
    expect(bucketFactor('search', bucket({ secondsOut: 30, used: 10 }), NOW)).toBe(1);
  });

  it('returns 1 when behind only because the window is nearly over (on pace)', () => {
    // 10% time left, 10/30 budget left → still above the safe line for this point.
    const f = bucketFactor('search', bucket({ limit: 30, used: 20, secondsOut: 6 }), NOW);
    expect(f).toBe(1);
  });

  it('stretches proportionally when ahead of pace', () => {
    // 50% time left, 10/30 (0.333) budget left vs a safe line at 0.575 → behind.
    const f = bucketFactor('search', bucket({ limit: 30, used: 20, secondsOut: 30 }), NOW);
    expect(f).toBeGreaterThan(1);
    expect(f).toBeCloseTo(0.5 / (10 / 30 - 0.15), 5);
  });

  it('PAUSES (MAX) a fully-exhausted bucket even late in the window', () => {
    // The reported case: graphql at 0/5000 with ~3m left of a 60m window. The old
    // used-vs-elapsed model said ~1.2×; remaining-vs-time correctly pins to MAX.
    const f = bucketFactor(
      'graphql',
      { limit: 5000, remaining: 0, used: 5000, reset: nowSecs + 180 },
      NOW,
    );
    expect(f).toBe(MAX_FACTOR);
  });

  it('pauses (MAX) as a bucket dips to/under the reserve, with time still left', () => {
    // 5% budget left, 50% of the window remaining → would run dry → stop.
    const f = bucketFactor('graphql', bucket({ limit: 5000, used: 4750, secondsOut: 1800 }), NOW);
    expect(f).toBe(MAX_FACTOR);
  });

  it('reconciles a stale-high remaining via the conservative used reading', () => {
    // used reported 0 but remaining says 18/30 spent → treat 12 as the budget left.
    // 30% time left, 0.4 budget left vs a 0.405 safe line → just behind (≈1.2×).
    // Without reconciling, 0 used → full budget → factor 1, so this proves it.
    const f = bucketFactor('search', { limit: 30, remaining: 12, used: 0, reset: nowSecs + 18 }, NOW);
    expect(f).toBeGreaterThan(1);
    expect(f).toBeCloseTo(0.3 / (12 / 30 - 0.15), 5);
  });

  it('returns 1 once the window has reset (reset in the past)', () => {
    expect(bucketFactor('search', bucket({ used: 30, secondsOut: -5 }), NOW)).toBe(1);
  });

  it('uses the hourly window for graphql/core', () => {
    // 3600s window, 1800s left → 50% time left; 1600/5000 (0.32) budget left.
    const f = bucketFactor(
      'graphql',
      bucket({ limit: 5000, used: 3400, secondsOut: 1800 }),
      NOW,
    );
    expect(f).toBeGreaterThan(1);
    expect(f).toBeCloseTo(0.5 / (1600 / 5000 - 0.15), 5);
  });
});

describe('delayFactor', () => {
  it('returns 1 for an account with no snapshot', () => {
    expect(rateBudgetGovernor.delayFactor('unknown', NOW)).toBe(1);
  });

  it('takes the max factor across an account’s buckets', () => {
    rateBudgetGovernor.update('acct', {
      core: bucket({ limit: 5000, used: 10, secondsOut: 1800 }), // factor 1
      search: bucket({ limit: 30, used: 20, secondsOut: 30 }), // factor > 1
    });
    const f = rateBudgetGovernor.delayFactor('acct', NOW);
    expect(f).toBeGreaterThan(1);
    expect(f).toBe(bucketFactor('search', bucket({ limit: 30, used: 20, secondsOut: 30 }), NOW));
  });

  it('returns MAX_FACTOR while the account is hard-blocked by the gate', () => {
    rateBudgetGovernor.update('acct', { search: bucket({ used: 0, secondsOut: 30 }) });
    githubRateGate.block('acct', Date.now() + 60_000, 'secondary limit');
    expect(rateBudgetGovernor.delayFactor('acct')).toBe(MAX_FACTOR);
  });
});

describe('maxDelayFactor', () => {
  it('returns the most-constrained account across the set', () => {
    rateBudgetGovernor.update('calm', { search: bucket({ used: 0, secondsOut: 30 }) });
    rateBudgetGovernor.update('busy', { search: bucket({ limit: 30, used: 20, secondsOut: 30 }) });
    const f = rateBudgetGovernor.maxDelayFactor(['calm', 'busy'], NOW);
    expect(f).toBe(rateBudgetGovernor.delayFactor('busy', NOW));
    expect(f).toBeGreaterThan(1);
  });

  it('returns 1 for an empty set', () => {
    expect(rateBudgetGovernor.maxDelayFactor([], NOW)).toBe(1);
  });
});
