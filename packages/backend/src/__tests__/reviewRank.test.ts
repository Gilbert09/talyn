import { describe, expect, it } from 'vitest';
import {
  PATH_FAMILIARITY_SATURATION,
  REVIEW_RANK_DIM,
  REVIEW_RANK_FEATURES,
  REVIEW_RANK_FULL_EVENTS,
  REVIEW_RANK_MIN_EVENTS,
  REVIEW_RANK_MIN_LIFT,
  REVIEW_RANK_PRIOR,
  applyReviewRank,
  computeFeatureStats,
  effectiveReviewRankWeights,
  fitAndValidateReviewRank,
  fitReviewRank,
  groupFoldsByEvent,
  pairwiseAccuracy,
  reviewRankBlend,
  reviewRankContributions,
  reviewRankFeatures,
  standardize,
  type ReviewRankPair,
  type ReviewRankProfile,
} from '@talyn/shared';

function profile(over: Partial<ReviewRankProfile> = {}): ReviewRankProfile {
  return {
    authorAffinity: {},
    dirAffinity: {},
    repoAffinity: {},
    model: null,
    ...over,
  };
}

const idx = (f: (typeof REVIEW_RANK_FEATURES)[number]) => REVIEW_RANK_FEATURES.indexOf(f);

describe('reviewRankFeatures', () => {
  it('returns one value per declared feature, in declared order', () => {
    // The order IS the wire format — weights are stored as a bare array.
    expect(reviewRankFeatures({}, null)).toHaveLength(REVIEW_RANK_DIM);
  });

  it('is all zeroes with no profile, so a cold user is not invented for', () => {
    const f = reviewRankFeatures({ author: 'sarah', repoFullName: 'acme/widgets' }, null);
    expect(f.slice(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it('separates reviews you GAVE from reviews you GOT', () => {
    // Meta's two strongest signals, and they are genuinely different people:
    // the colleague whose PRs you always read is not necessarily the one who
    // always reads yours.
    const p = profile({ authorAffinity: { sarah: { gave: 20, got: 0 } } });
    const f = reviewRankFeatures({ author: 'sarah' }, p);
    expect(f[idx('authorAffinity')]).toBeGreaterThan(0);
    expect(f[idx('reciprocity')]).toBe(0);
  });

  it('matches an author case-insensitively', () => {
    const p = profile({ authorAffinity: { sarah: { gave: 5, got: 5 } } });
    expect(reviewRankFeatures({ author: 'SaRaH' }, p)[idx('authorAffinity')]).toBeGreaterThan(0);
  });

  it('compresses affinity with log1p, so one prolific colleague cannot dominate', () => {
    const p = profile({
      authorAffinity: { a: { gave: 1, got: 0 }, b: { gave: 200, got: 0 } },
    });
    const one = reviewRankFeatures({ author: 'a' }, p)[idx('authorAffinity')];
    const many = reviewRankFeatures({ author: 'b' }, p)[idx('authorAffinity')];
    expect(many).toBeGreaterThan(one);
    // Two hundred reviews is not two hundred times the signal of one.
    expect(many).toBeLessThan(one * 10);
  });

  it('saturates path familiarity at five prior reviews', () => {
    // Bosu et al.: prior exposure roughly doubles useful-comment density and
    // the effect plateaus. A raw count would say the 200th review of a
    // directory is forty times the expertise of the fifth.
    const at = (n: number) =>
      reviewRankFeatures({ dirs: ['src'] }, profile({ dirAffinity: { src: n } }))[
        idx('pathFamiliarity')
      ];
    expect(at(0)).toBe(0);
    expect(at(PATH_FAMILIARITY_SATURATION)).toBe(1);
    expect(at(500)).toBe(1);
    expect(at(2)).toBeLessThan(1);
  });

  it('sums familiarity across every directory the PR touches', () => {
    const p = profile({ dirAffinity: { src: 2, docs: 2 } });
    const both = reviewRankFeatures({ dirs: ['src', 'docs'] }, p)[idx('pathFamiliarity')];
    const one = reviewRankFeatures({ dirs: ['src'] }, p)[idx('pathFamiliarity')];
    expect(both).toBeGreaterThan(one);
  });

  it('marks an UNKNOWN size as unknown rather than as an empty diff', () => {
    // The trap: a raw 0 is the smallest diff the model can see, so every PR
    // whose size we never fetched would look like the quickest possible read.
    expect(Number.isFinite(reviewRankFeatures({}, null)[idx('logSize')])).toBe(false);
    expect(Number.isFinite(reviewRankFeatures({ additions: 0 }, null)[idx('logSize')])).toBe(true);
  });

  it('counts a deletions-only PR as having a known size', () => {
    expect(Number.isFinite(reviewRankFeatures({ deletions: 40 }, null)[idx('logSize')])).toBe(true);
  });
});

describe('standardize', () => {
  const stats = { mean: [1, 1, 1, 1, 1], sd: [2, 2, 2, 2, 2] };

  it('z-scores each column', () => {
    expect(standardize([3, 3, 3, 3, 3], stats)).toEqual([1, 1, 1, 1, 1]);
  });

  it('maps an unknown to the MEAN, which is zero once standardised', () => {
    // The honest stand-in for "we do not know": it contributes nothing rather
    // than pulling the score in either direction.
    expect(standardize([Number.NaN, 1, 1, 1, 1], stats)[0]).toBe(0);
  });

  it('survives a feature that never varied', () => {
    // sd = 0 would divide by zero and poison every downstream number.
    const flat = { mean: [0, 0, 0, 0, 0], sd: [0, 0, 0, 0, 0] };
    expect(standardize([5, 5, 5, 5, 5], flat).every((v) => v === 0)).toBe(true);
  });
});

describe('computeFeatureStats', () => {
  it('computes mean and sample sd per column', () => {
    const stats = computeFeatureStats([
      [1, 0, 0, 0, 0],
      [3, 0, 0, 0, 0],
    ]);
    expect(stats.mean[0]).toBe(2);
    expect(stats.sd[0]).toBeCloseTo(Math.SQRT2, 6);
  });

  it('ignores unknowns rather than treating them as zero', () => {
    const stats = computeFeatureStats([
      [10, 0, 0, 0, 0],
      [Number.NaN, 0, 0, 0, 0],
    ]);
    expect(stats.mean[0]).toBe(10);
  });

  it('returns zeroes for an empty set instead of NaN', () => {
    const stats = computeFeatureStats([]);
    expect(stats.mean.every((v) => v === 0)).toBe(true);
    expect(stats.sd.every((v) => v === 0)).toBe(true);
  });
});

describe('applyReviewRank and its contributions', () => {
  it('sums the per-feature contributions EXACTLY', () => {
    // The property the reason chip depends on: "ranked high because you review
    // Alex often (+0.8)" is only true if the parts add up to the whole.
    const f = [1, 2, 3, 4, 5];
    const w = [0.1, -0.2, 0.3, -0.4, 0.5];
    const total = applyReviewRank(f, w);
    const parts = reviewRankContributions(f, w).reduce((a, c) => a + c.value, 0);
    expect(parts).toBeCloseTo(total, 12);
  });

  it('names every feature in its contribution list', () => {
    expect(reviewRankContributions([0, 0, 0, 0, 0], [0, 0, 0, 0, 0]).map((c) => c.feature)).toEqual(
      [...REVIEW_RANK_FEATURES],
    );
  });
});

// --- fitting ---------------------------------------------------------------

/** Pairs generated from a known weight vector, so the fit has a right answer. */
function syntheticPairs(trueWeights: number[], n: number): ReviewRankPair[] {
  const pairs: ReviewRankPair[] = [];
  // Deterministic pseudo-random: the suite must not flake.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  for (let i = 0; i < n; i++) {
    const diff = trueWeights.map(() => rand() * 4);
    const score = applyReviewRank(diff, trueWeights);
    // Order each pair so the winner really is first, which is how the real
    // extractor builds them.
    pairs.push({
      diff: score >= 0 ? diff : diff.map((v) => -v),
      // Four pairs per event, matching the real shape: one review decision
      // taken against a handful of co-pending PRs.
      eventKey: `event-${Math.floor(i / 4)}`,
    });
  }
  return pairs;
}

describe('fitReviewRank', () => {
  it('recovers the DIRECTION of known weights', () => {
    const truth = [1.5, -0.8, 0.4, 0, 0];
    const w = fitReviewRank(syntheticPairs(truth, 400), 0.1);
    expect(Math.sign(w[0])).toBe(1);
    expect(Math.sign(w[1])).toBe(-1);
    expect(w[0]).toBeGreaterThan(Math.abs(w[1]));
  });

  it('keeps weights BOUNDED under L2 on separable data', () => {
    // The reason this is hand-rolled rather than `ml-logistic-regression`:
    // that package has no regularization, and on near-separable data at this
    // sample size an unregularized fit walks to infinity — at which point the
    // contribution breakdown the chip renders stops meaning anything.
    const pairs = syntheticPairs([3, 0, 0, 0, 0], 300);
    const strong = fitReviewRank(pairs, 10);
    expect(strong.every((v) => Number.isFinite(v))).toBe(true);
    expect(Math.max(...strong.map(Math.abs))).toBeLessThan(50);
  });

  it('shrinks harder as lambda rises', () => {
    const pairs = syntheticPairs([2, 1, 0, 0, 0], 300);
    const light = fitReviewRank(pairs, 0.01);
    const heavy = fitReviewRank(pairs, 10);
    expect(Math.abs(heavy[0])).toBeLessThan(Math.abs(light[0]));
  });

  it('returns zeroes rather than NaN for no data', () => {
    expect(fitReviewRank([], 1)).toEqual(new Array(REVIEW_RANK_DIM).fill(0));
  });

  it('never emits a non-finite weight', () => {
    // A NaN weight silently ranks every PR identically, which reads as the
    // sort being broken rather than the model being wrong.
    const degenerate: ReviewRankPair[] = Array.from({ length: 20 }, (_, i) => ({
      diff: [0, 0, 0, 0, 0],
      eventKey: `e${i}`,
    }));
    expect(fitReviewRank(degenerate, 1).every(Number.isFinite)).toBe(true);
  });
});

describe('groupFoldsByEvent', () => {
  it('keeps every pair from one review decision in the same fold', () => {
    // "I picked this PR over those three" is three pairs and ONE choice.
    // Splitting them trains on part of a decision and validates on the rest of
    // the same decision, so the accuracy measures memorisation.
    const pairs: ReviewRankPair[] = [
      { diff: [0, 0, 0, 0, 0], eventKey: 'e1' },
      { diff: [0, 0, 0, 0, 0], eventKey: 'e1' },
      { diff: [0, 0, 0, 0, 0], eventKey: 'e1' },
    ];
    expect(new Set(groupFoldsByEvent(pairs, 5)).size).toBe(1);
  });

  it('spreads different events across the folds', () => {
    const pairs: ReviewRankPair[] = Array.from({ length: 10 }, (_, i) => ({
      diff: [0, 0, 0, 0, 0],
      eventKey: `e${i}`,
    }));
    expect(new Set(groupFoldsByEvent(pairs, 5)).size).toBe(5);
  });

  it('is deterministic, so a retrain on unchanged data cannot flip the gate', () => {
    const pairs: ReviewRankPair[] = Array.from({ length: 20 }, (_, i) => ({
      diff: [0, 0, 0, 0, 0],
      eventKey: `e${i % 7}`,
    }));
    expect(groupFoldsByEvent(pairs, 5)).toEqual(groupFoldsByEvent(pairs, 5));
  });
});

describe('pairwiseAccuracy', () => {
  it('is 1 when every pair is ordered right, and 0 when every one is wrong', () => {
    const pairs: ReviewRankPair[] = [{ diff: [1, 0, 0, 0, 0], eventKey: 'e1' }];
    expect(pairwiseAccuracy(pairs, [1, 0, 0, 0, 0])).toBe(1);
    expect(pairwiseAccuracy(pairs, [-1, 0, 0, 0, 0])).toBe(0);
  });

  it('is 0 for no pairs rather than NaN', () => {
    expect(pairwiseAccuracy([], REVIEW_RANK_PRIOR)).toBe(0);
  });
});

describe('fitAndValidateReviewRank — the install gate', () => {
  it('REFUSES below the event floor, and says why', () => {
    // Not fitted with fewer features, not fitted with heavier regularization —
    // not fitted. A "model" trained on forty rows is worse than none, because
    // it gets reported as one.
    const result = fitAndValidateReviewRank(syntheticPairs([2, 0, 0, 0, 0], 400), 40);
    expect(result.installed).toBe(false);
    expect(result.refusedBecause).toBe('too_few_events');
    expect(result.weights).toEqual(REVIEW_RANK_PRIOR);
  });

  it('refuses a fit that does not beat the prior by the required lift', () => {
    // A model that merely ties the prior is a liability: harder to reason
    // about, changes when the data changes, buys nothing.
    const noise: ReviewRankPair[] = Array.from({ length: 200 }, (_, i) => ({
      diff: [0, 0, 0, 0, 0],
      eventKey: `e${Math.floor(i / 4)}`,
    }));
    const result = fitAndValidateReviewRank(noise, 400);
    expect(result.installed).toBe(false);
    expect(result.refusedBecause).toBe('no_lift');
  });

  it('installs a fit that clearly beats the prior', () => {
    // A viewer whose behaviour is the OPPOSITE of the shipped prior — they
    // reliably read the big PRs from people they rarely review. The prior does
    // badly here, which is exactly when a personal model earns its place.
    const truth = [-1.5, 0, 0, 0, 1.5];
    const result = fitAndValidateReviewRank(syntheticPairs(truth, 600), 400);
    expect(result.installed).toBe(true);
    expect(result.cvAccuracy).toBeGreaterThan(result.baselineAccuracy + REVIEW_RANK_MIN_LIFT);
  });

  it('records the numbers even when it refuses', () => {
    // "We looked and it was not worth it" is a fact with evidence, not an
    // absence — and it is how we find out later whether this was worth building.
    const result = fitAndValidateReviewRank(syntheticPairs([1, 0, 0, 0, 0], 20), 10);
    expect(result.baselineAccuracy).toBeGreaterThanOrEqual(0);
    expect(result).toHaveProperty('cvAccuracy');
  });
});

describe('the blend', () => {
  it('gives the fit nothing at the floor and everything at the ceiling', () => {
    expect(reviewRankBlend(REVIEW_RANK_MIN_EVENTS)).toBe(0);
    expect(reviewRankBlend(REVIEW_RANK_FULL_EVENTS)).toBe(1);
    expect(reviewRankBlend(0)).toBe(0);
    expect(reviewRankBlend(10_000)).toBe(1);
  });

  it('ramps rather than jumping', () => {
    const mid = reviewRankBlend((REVIEW_RANK_MIN_EVENTS + REVIEW_RANK_FULL_EVENTS) / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('serves the PRIOR when there is no model, or it was refused', () => {
    expect(effectiveReviewRankWeights(null)).toEqual(REVIEW_RANK_PRIOR);
    expect(
      effectiveReviewRankWeights({
        installed: false,
        nEvents: 9_000,
        weights: [9, 9, 9, 9, 9],
        featureStats: { mean: [], sd: [] },
        cvAccuracy: 0,
        baselineAccuracy: 0,
      }),
    ).toEqual(REVIEW_RANK_PRIOR);
  });

  it('hands the term to a well-fed installed model', () => {
    const w = effectiveReviewRankWeights({
      installed: true,
      nEvents: REVIEW_RANK_FULL_EVENTS,
      weights: [2, 2, 2, 2, 2],
      featureStats: { mean: [], sd: [] },
      cvAccuracy: 0.7,
      baselineAccuracy: 0.6,
    });
    expect(w).toEqual([2, 2, 2, 2, 2]);
  });

  it('is exactly the prior at the floor, so crossing it changes nothing', () => {
    const w = effectiveReviewRankWeights({
      installed: true,
      nEvents: REVIEW_RANK_MIN_EVENTS,
      weights: [2, 2, 2, 2, 2],
      featureStats: { mean: [], sd: [] },
      cvAccuracy: 0.7,
      baselineAccuracy: 0.6,
    });
    expect(w).toEqual(REVIEW_RANK_PRIOR);
  });
});

describe('the shipped prior', () => {
  it('weights author familiarity above path familiarity', () => {
    // Meta's deployed model puts familiarity with the author at 33.89% against
    // code ownership at 4.91% — roughly 7:1. Most hand-built rankers get this
    // backwards and lead on the code.
    const i = (f: (typeof REVIEW_RANK_FEATURES)[number]) => REVIEW_RANK_PRIOR[idx(f)];
    expect(i('authorAffinity')).toBeGreaterThan(i('pathFamiliarity'));
    expect(i('reciprocity')).toBeGreaterThan(i('pathFamiliarity'));
  });

  it('has one weight per feature', () => {
    expect(REVIEW_RANK_PRIOR).toHaveLength(REVIEW_RANK_DIM);
  });

  it('treats a bigger PR as slower to get to', () => {
    expect(REVIEW_RANK_PRIOR[idx('logSize')]).toBeLessThan(0);
  });
});
