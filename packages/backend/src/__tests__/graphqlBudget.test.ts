import { describe, it, expect, beforeEach } from 'vitest';
import { graphqlBudget } from '../services/graphqlBudget.js';

// A fixed "now" so resetAt math is deterministic without fake timers.
const NOW = Date.parse('2026-06-29T12:00:00.000Z');
const inMin = (m: number) => new Date(NOW + m * 60_000).toISOString();

const obs = (over: Partial<{ limit: number; remaining: number; resetAt: string; cost: number }> = {}) => ({
  limit: 5000,
  remaining: 4000,
  resetAt: inMin(30),
  cost: 12,
  ...over,
});

beforeEach(() => graphqlBudget._reset());

describe('graphqlBudget.record + snapshot', () => {
  it('exposes a recorded account in the snapshot', () => {
    graphqlBudget.record('inst:1', obs(), NOW);
    const snap = graphqlBudget.snapshot(NOW);
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      accountKey: 'inst:1',
      limit: 5000,
      remaining: 4000,
      lastCost: 12,
      deferring: false,
    });
    expect(snap[0].observedAt).toBeTruthy();
  });

  it('overwrites the previous reading for the same account', () => {
    graphqlBudget.record('inst:1', obs({ remaining: 4000 }), NOW);
    graphqlBudget.record('inst:1', obs({ remaining: 100 }), NOW);
    const snap = graphqlBudget.snapshot(NOW);
    expect(snap).toHaveLength(1);
    expect(snap[0].remaining).toBe(100);
  });

  it('keeps separate accounts apart and sorts lowest-budget first', () => {
    graphqlBudget.record('inst:1', obs({ remaining: 4000 }), NOW);
    graphqlBudget.record('login:b', obs({ remaining: 200 }), NOW);
    const snap = graphqlBudget.snapshot(NOW);
    expect(snap.map((s) => s.accountKey)).toEqual(['login:b', 'inst:1']);
  });

  it.each([
    ['NaN limit', { limit: Number.NaN }],
    ['zero limit', { limit: 0 }],
    ['negative limit', { limit: -1 }],
  ])('ignores a garbage reading (%s)', (_label, over) => {
    graphqlBudget.record('inst:1', obs(over), NOW);
    expect(graphqlBudget.snapshot(NOW)).toHaveLength(0);
  });

  it('drops a reading once it ages past the staleness window', () => {
    graphqlBudget.record('inst:1', obs(), NOW);
    // Still fresh just under 90 min.
    expect(graphqlBudget.snapshot(NOW + 89 * 60_000)).toHaveLength(1);
    // Past it → aged out.
    expect(graphqlBudget.snapshot(NOW + 91 * 60_000)).toHaveLength(0);
  });

  it('reports the bucket as refilled to limit once the window has reset', () => {
    graphqlBudget.record('inst:1', obs({ remaining: 50, resetAt: inMin(10) }), NOW);
    // Before reset: still showing the low remaining.
    expect(graphqlBudget.snapshot(NOW)[0].remaining).toBe(50);
    // After reset (and within staleness): optimistically full again.
    const after = graphqlBudget.snapshot(NOW + 11 * 60_000)[0];
    expect(after.remaining).toBe(5000);
    expect(after.deferring).toBe(false);
  });
});

describe('graphqlBudget.shouldDefer', () => {
  it('does not defer an unknown account (never block on no data)', () => {
    expect(graphqlBudget.shouldDefer('unknown', NOW)).toBe(false);
  });

  it.each([
    ['above reserve', 600, false],
    ['at reserve', 500, false],
    ['below reserve', 499, true],
    ['nearly empty', 1, true],
  ])('reserve gate %s → %s', (_label, remaining, expected) => {
    graphqlBudget.record('inst:1', obs({ remaining }), NOW);
    expect(graphqlBudget.shouldDefer('inst:1', NOW)).toBe(expected);
  });

  it('stops deferring once the window has reset, even on a low last reading', () => {
    graphqlBudget.record('inst:1', obs({ remaining: 10, resetAt: inMin(5) }), NOW);
    expect(graphqlBudget.shouldDefer('inst:1', NOW)).toBe(true);
    expect(graphqlBudget.shouldDefer('inst:1', NOW + 6 * 60_000)).toBe(false);
  });

  it('reflects the deferring state in the snapshot card', () => {
    graphqlBudget.record('inst:1', obs({ remaining: 100 }), NOW);
    expect(graphqlBudget.snapshot(NOW)[0].deferring).toBe(true);
  });
});
