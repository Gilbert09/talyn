import { describe, expect, it } from 'vitest';
import {
  buildPRPriorityMap, comparePRByPriority, loadReviewSortMode, predictSharedRanking,
  replayPRPriorityTrace, scorePRForReview, sharedRankingFeatures, validateSharedRankingModel,
  PR_PRIORITY_WEIGHTS, type PRPriorityTarget,
} from '@talyn/shared';
import model from '../services/reviewPriority/sharedCandidate.json';
import parity from './fixtures/reviewRankingModelParity.json';

const now = Date.parse('2026-09-22T12:00:00Z');
const row = (id: string, hours: number, draft = false): PRPriorityTarget => ({
  id, createdAt: new Date(now - 48 * 3_600_000).toISOString(),
  reviewRequestedFirstSeenAt: new Date(now - hours * 3_600_000).toISOString(),
  summary: { draft, author: 'human' },
});

describe('frozen shared ranking candidate', () => {
  it('matches the Python network on complete queues', () => {
    for (const test of parity) {
      const actual = predictSharedRanking(model, test.features);
      actual.forEach((value, i) => expect(value).toBeCloseTo(test.predictions[i], 11));
    }
  });

  it('constructs request recency without breaking timestamp ties', () => {
    const result = sharedRankingFeatures([row('a', 1), row('b', 1), row('c', 2)], now);
    expect(result[0]).toEqual([Math.log1p(1), 0, 1, 1, Math.log1p(48), 0, Math.log1p(3), 0]);
    expect(result[1]).toEqual(result[0]);
    expect(result[2][1]).toBe(1);
  });

  it.each([null, 'invalid', '2026-09-23T00:00:00Z'])('refuses an unavailable request time: %s', (time) => {
    expect(() => sharedRankingFeatures([{ ...row('a', 1), reviewRequestedFirstSeenAt: time }], now)).toThrow();
  });

  it.each([0, -1, Infinity, NaN])('refuses an invalid scale: %s', (scale) => {
    expect(() => validateSharedRankingModel({ ...model, scale: [scale, ...model.scale.slice(1)] })).toThrow();
  });

  it('keeps gates, score limits, deterministic ties, and trace replay', () => {
    const rows = [row('a', 1), row('b', 1, true), row('c', 1)];
    const verdicts = buildPRPriorityMap(rows, { now, pooledScore: 1e6, captureTrace: { source: 'server' } });
    const sorted = [...rows].sort((a, b) => comparePRByPriority(a, b, verdicts));
    expect(sorted.map((r) => r.id)).toEqual(['a', 'c', 'b']);
    for (const r of rows) {
      const v = verdicts.get(r.id)!;
      const rule = scorePRForReview(r, { now });
      expect(v.score - rule.score).toBe(PR_PRIORITY_WEIGHTS.learnedCap);
      expect(replayPRPriorityTrace(v.trace!)).toMatchObject({ gate: v.gate, score: v.score });
    }
  });

  it.each([null, 'garbage', 'newest', 'oldest', 'priority'])('starts in Priority unless the new preference is explicit: %s', (value) => {
    expect(loadReviewSortMode({ getItem: () => value })).toBe(value === 'newest' || value === 'oldest' ? value : 'priority');
  });

  it('uses Priority when storage is unavailable', () => {
    expect(loadReviewSortMode({ getItem: () => { throw new Error(); } })).toBe('priority');
  });
});
