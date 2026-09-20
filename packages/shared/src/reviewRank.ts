// The per-user review-ranking model: features, fit, and apply.
//
// # What is learned, and what deliberately is not
//
// Only SLOW, HISTORICALLY-OBSERVABLE properties of a PR: who wrote it, whether
// they review your work, whether you know the files, which repo, and how big
// it is. Everything about a PR's live STATE — checks, conflicts, threads,
// drafts, an agent mid-run — stays in `prPriority.ts` as deterministic rules,
// and that split is forced by the data rather than chosen for tidiness.
//
// GitHub does not retain historical PR state. For a PR reviewed six weeks ago
// we can see what it looks like NOW, and "now" for a merged PR is green,
// mergeable, approved, zero unresolved threads — by definition. Training a
// state feature on that is not merely uninformative, it is poisoned: every
// positive example would carry `greenChecks = 1` and the model would learn
// "green checks cause reviews" from an artefact of merging.
//
// # The label
//
// Pairwise, over co-pending choice sets. At each instant the viewer submitted
// a review on PR p, the choice set is every OTHER PR that was open, requested
// of them, and still unreviewed at that exact moment. One training pair per
// (p, q), feature vector x_p − x_q, label 1.
//
// Three reasons this beats the obvious alternatives:
//
//  - It optimises what the UI renders. We ship a SORT, not a cut-off, so a
//    binary "responded within N hours" label optimises a decision we never
//    make and forces an arbitrary N.
//  - It conditions away calendar noise. Review latency is dominated by
//    weekends, on-call and illness; a PR reviewed in 4h on a Tuesday and an
//    identical one reviewed in 40h over a weekend are not a 10x preference.
//    Both members of a pair were pending at the SAME instant, so that cancels.
//    (See Chen, Rigby & Nagappan, FSE 2022 — "Understanding why we cannot
//    model how long a code review will take".)
//  - It satisfies the Gmail Priority Inbox "opportunity to see" rule
//    structurally rather than by heuristic: q is a negative only because it
//    was demonstrably pending and passed over. There is no way to accidentally
//    admit a PR the viewer never saw.
//
// # Effective sample size — stated honestly
//
// 200 review events with a mean choice set of 4 yields ~800 pairs, and that is
// NOT 800 independent examples: pairs share PRs and share choice sets. The
// effective n for a parameter budget is the number of review EVENTS. The pair
// expansion buys a better-conditioned objective, not statistical power.
// Claiming otherwise would inflate Riley et al.'s budget fourfold, which is
// precisely the mistake that budget exists to prevent.

/** The five learned features, in fixed order. The order IS the wire format. */
export const REVIEW_RANK_FEATURES = [
  'authorAffinity',
  'reciprocity',
  'pathFamiliarity',
  'repoAffinity',
  'logSize',
] as const;

export type ReviewRankFeature = (typeof REVIEW_RANK_FEATURES)[number];

/** Five features + intercept = 6 parameters. Riley's budget allows 3-13 at n≈500. */
export const REVIEW_RANK_DIM = REVIEW_RANK_FEATURES.length;

/**
 * Below this many review EVENTS (not pairs) the model is not fitted at all.
 *
 * Not fitted with fewer features, not fitted with heavier regularization —
 * not fitted. A "model" trained on forty rows is worse than no model, because
 * it is reported as one.
 */
export const REVIEW_RANK_MIN_EVENTS = 150;

/** Above this, the fitted model owns the term outright. Between the two, blend. */
export const REVIEW_RANK_FULL_EVENTS = 300;

/**
 * How much held-out pairwise accuracy the fit must add over the hand-set prior
 * before it is installed.
 *
 * The gate that keeps this from being ML theatre. A model that merely ties the
 * prior is a liability: it is harder to reason about, it changes when the data
 * changes, and it buys nothing. Re-evaluated on every retrain, so one that
 * stops helping retires itself.
 */
export const REVIEW_RANK_MIN_LIFT = 0.03;

/** Per-feature mean and standard deviation, for z-scoring. */
export interface ReviewRankFeatureStats {
  mean: number[];
  sd: number[];
}

/** A fitted (or refused) model as stored and served. */
export interface ReviewRankModel {
  /** Whether this model is actually used. False = serve the prior. */
  installed: boolean;
  /** Review events the fit saw. Drives the blend, and the settings copy. */
  nEvents: number;
  /** One weight per {@link REVIEW_RANK_FEATURES}, in that order. */
  weights: number[];
  /** Held-out pairwise accuracy of the fit, and of the prior it must beat. */
  cvAccuracy: number;
  baselineAccuracy: number;
}

/**
 * The hand-set prior, used cold and blended with the fit until it has enough
 * data to stand alone.
 *
 * Weighted per Meta's deployed reviewer model, which is the best evidence
 * available on relative importance: familiarity with the author 33.89% against
 * code ownership 4.91%, roughly 7:1. So affinity and reciprocity lead, path
 * familiarity follows, and size is a tiebreak — not the other way round, which
 * is how most hand-built rankers are weighted.
 */
export const REVIEW_RANK_PRIOR: number[] = [
  1.0, // authorAffinity
  0.8, // reciprocity
  0.5, // pathFamiliarity
  0.3, // repoAffinity
  -0.3, // logSize — bigger is slower to get to
];

/**
 * Per-viewer aggregates, built from their own GitHub review history.
 *
 * Small enough to ship to the client whole (~15-20 KB), because scoring is
 * client-side: the ordering has to re-run on every keystroke in the filter box
 * and cannot be a round-trip.
 */
export interface ReviewRankProfile {
  /** Per author login: reviews the viewer GAVE them, and GOT from them. */
  authorAffinity: Record<string, { gave: number; got: number }>;
  /** Per top-level directory: how many of the viewer's past reviews touched it. */
  dirAffinity: Record<string, number>;
  /** Per `owner/repo`: share of the viewer's past reviews, 0..1. */
  repoAffinity: Record<string, number>;
  /**
   * Per-feature mean and sd, so a live PR is standardised on the same scale the
   * weights expect.
   *
   * On the PROFILE rather than inside the model, and that placement is
   * load-bearing: they describe the viewer's POPULATION of PRs, not the fit.
   * Held inside the model they would be absent whenever no model had been
   * fitted — which is exactly when the shipped prior is meant to be doing the
   * work, so the prior would silently never apply and a new user would get no
   * personalisation at all until their 150th review.
   */
  featureStats: ReviewRankFeatureStats | null;
  /** The fitted model, or a refusal carrying why. Null before any fit ran. */
  model: ReviewRankModel | null;
}

/** What the feature extractor needs to know about one PR. */
export interface ReviewRankTarget {
  author?: string;
  repoFullName?: string;
  /** Top-level directories the PR touches. */
  dirs?: string[];
  additions?: number;
  deletions?: number;
}

/**
 * Bosu et al.: prior exposure to a file roughly doubles useful-comment density,
 * and the effect SATURATES at about five prior reviews. So the feature is
 * `min(n, 5) / 5` rather than a raw count — someone who has reviewed a
 * directory two hundred times is not forty times more qualified than someone
 * who has reviewed it five times, and a raw count would say they were.
 */
export const PATH_FAMILIARITY_SATURATION = 5;

/** Extract the five features for one PR, in {@link REVIEW_RANK_FEATURES} order. */
export function reviewRankFeatures(
  pr: ReviewRankTarget,
  profile: ReviewRankProfile | null,
): number[] {
  const author = (pr.author ?? '').toLowerCase();
  const affinity = profile?.authorAffinity[author];

  // log1p throughout: the difference between never and once matters far more
  // than the difference between forty and forty-one, and a raw count lets one
  // prolific colleague dominate every other feature.
  const authorAffinity = Math.log1p(affinity?.gave ?? 0);
  const reciprocity = Math.log1p(affinity?.got ?? 0);

  let dirHits = 0;
  for (const dir of pr.dirs ?? []) {
    dirHits += profile?.dirAffinity[dir] ?? 0;
  }
  const pathFamiliarity =
    Math.min(dirHits, PATH_FAMILIARITY_SATURATION) / PATH_FAMILIARITY_SATURATION;

  const repoAffinity = profile?.repoAffinity[(pr.repoFullName ?? '').toLowerCase()] ?? 0;

  // Absent size is UNKNOWN, and the honest encoding of unknown in a z-scored
  // linear model is the mean — which after standardisation is 0. Passing a raw
  // 0 here would say "an empty diff", the smallest thing the model can see.
  const known = pr.additions !== undefined || pr.deletions !== undefined;
  const logSize = known ? Math.log1p((pr.additions ?? 0) + (pr.deletions ?? 0)) : Number.NaN;

  return [authorAffinity, reciprocity, pathFamiliarity, repoAffinity, logSize];
}

/** z-score a raw feature vector. A zero sd means the feature never varied. */
export function standardize(raw: number[], stats: ReviewRankFeatureStats): number[] {
  return raw.map((v, i) => {
    // NaN is the extractor's "unknown" marker, and the mean is its honest
    // stand-in — which is exactly 0 once standardised.
    if (!Number.isFinite(v)) return 0;
    const sd = stats.sd[i];
    if (!Number.isFinite(sd) || sd === 0) return 0;
    return (v - stats.mean[i]) / sd;
  });
}

/** Mean and sd per column. */
export function computeFeatureStats(rows: number[][]): ReviewRankFeatureStats {
  const dim = REVIEW_RANK_DIM;
  const mean = new Array(dim).fill(0);
  const sd = new Array(dim).fill(0);
  if (rows.length === 0) return { mean, sd };

  for (let j = 0; j < dim; j++) {
    let n = 0;
    let sum = 0;
    for (const r of rows) {
      if (Number.isFinite(r[j])) {
        sum += r[j];
        n++;
      }
    }
    mean[j] = n > 0 ? sum / n : 0;
    let sq = 0;
    for (const r of rows) {
      if (Number.isFinite(r[j])) sq += (r[j] - mean[j]) ** 2;
    }
    sd[j] = n > 1 ? Math.sqrt(sq / (n - 1)) : 0;
  }
  return { mean, sd };
}

/** The linear score, in standardised units. No intercept: a pairwise fit drops it. */
export function applyReviewRank(features: number[], weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < REVIEW_RANK_DIM; i++) sum += (features[i] ?? 0) * (weights[i] ?? 0);
  return sum;
}

/** Per-feature contributions, which must sum to {@link applyReviewRank}. */
export function reviewRankContributions(
  features: number[],
  weights: number[],
): Array<{ feature: ReviewRankFeature; value: number }> {
  return REVIEW_RANK_FEATURES.map((feature, i) => ({
    feature,
    value: (features[i] ?? 0) * (weights[i] ?? 0),
  }));
}

/**
 * How much the fitted model owns the learned term, 0..1.
 *
 * A ramp rather than a cliff so nothing jumps the moment a user crosses the
 * floor: at {@link REVIEW_RANK_MIN_EVENTS} the fit contributes nothing, at
 * {@link REVIEW_RANK_FULL_EVENTS} it owns the term outright.
 */
export function reviewRankBlend(nEvents: number): number {
  const span = REVIEW_RANK_FULL_EVENTS - REVIEW_RANK_MIN_EVENTS;
  return Math.max(0, Math.min(1, (nEvents - REVIEW_RANK_MIN_EVENTS) / span));
}

/** The weights actually used: prior, fit, or a blend of the two. */
export function effectiveReviewRankWeights(model: ReviewRankModel | null): number[] {
  if (!model?.installed) return REVIEW_RANK_PRIOR;
  const a = reviewRankBlend(model.nEvents);
  return REVIEW_RANK_PRIOR.map((prior, i) => (1 - a) * prior + a * (model.weights[i] ?? 0));
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

/** One training pair: the winner's features minus the loser's. */
export interface ReviewRankPair {
  /** x_winner − x_loser, already standardised. */
  diff: number[];
  /**
   * The review EVENT this pair came from — the instant the viewer picked one
   * PR out of everything pending. Every pair from one event shares it.
   *
   * This is the CV grouping key, and the choice is the same argument that
   * makes effective n the event count rather than the pair count: the pairs
   * from one event are one decision seen from several angles, not several
   * decisions. Splitting them across folds would train on part of a choice and
   * validate on the rest of the same choice, and the accuracy would be
   * measuring memorisation.
   */
  eventKey: string;
}

const MAX_NEWTON_ITERATIONS = 25;
const CONVERGENCE_EPSILON = 1e-7;

/**
 * L2-regularized pairwise logistic regression (Bradley-Terry), by Newton/IRLS.
 *
 * Hand-rolled, and deliberately. `ml-logistic-regression` is unmaintained since
 * 2020 and — decisively — has NO regularization: on low-n, near-separable data
 * an unregularized fit diverges, the weights run to ±∞, and the per-feature
 * contributions the reason chip depends on stop meaning anything. That is this
 * dataset's exact failure mode rather than a hypothetical. `ml-matrix` would
 * also be a new runtime dependency in a package whose only one today is croner,
 * to invert a 5x5.
 *
 * Every label is 1 by construction (the pair is ordered winner-first), so the
 * likelihood is ∏ σ(wᵀd) and the Newton step is the standard IRLS one with
 * p = σ(wᵀd), W = p(1−p).
 */
export function fitReviewRank(pairs: ReviewRankPair[], lambda: number): number[] {
  const dim = REVIEW_RANK_DIM;
  const w = new Array(dim).fill(0);
  if (pairs.length === 0) return w;

  for (let iter = 0; iter < MAX_NEWTON_ITERATIONS; iter++) {
    // Gradient of the penalised negative log-likelihood, and its Hessian.
    const grad = new Array(dim).fill(0);
    const hess: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));

    for (const pair of pairs) {
      const z = applyReviewRank(pair.diff, w);
      const p = 1 / (1 + Math.exp(-z));
      const residual = 1 - p; // label is always 1
      const weight = p * (1 - p);
      for (let i = 0; i < dim; i++) {
        grad[i] += residual * pair.diff[i];
        for (let j = 0; j < dim; j++) {
          hess[i][j] += weight * pair.diff[i] * pair.diff[j];
        }
      }
    }

    // The L2 penalty. Without it the fit walks to infinity on separable data,
    // which near-certainly happens at this sample size.
    for (let i = 0; i < dim; i++) {
      grad[i] -= lambda * w[i];
      hess[i][i] += lambda;
    }

    const step = solveSymmetric(hess, grad);
    if (!step) return w; // singular — keep what we have rather than emit NaNs

    let delta = 0;
    for (let i = 0; i < dim; i++) {
      w[i] += step[i];
      delta += Math.abs(step[i]);
    }
    if (delta < CONVERGENCE_EPSILON) break;
  }
  return w;
}

/** Gaussian elimination with partial pivoting. Null when the matrix is singular. */
function solveSymmetric(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];

    for (let r = col + 1; r < n; r++) {
      const factor = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= factor * m[col][c];
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = m[i][n];
    for (let j = i + 1; j < n; j++) sum -= m[i][j] * x[j];
    x[i] = sum / m[i][i];
  }
  return x.every((v) => Number.isFinite(v)) ? x : null;
}

/** Fraction of pairs the weights order correctly. Chance is 0.5. */
export function pairwiseAccuracy(pairs: ReviewRankPair[], weights: number[]): number {
  if (pairs.length === 0) return 0;
  let right = 0;
  for (const pair of pairs) {
    if (applyReviewRank(pair.diff, weights) > 0) right++;
  }
  return right / pairs.length;
}

/**
 * Assign each pair to one of `k` folds, grouped by review EVENT.
 *
 * Grouped, not shuffled, and that is the whole point. The pairs from one event
 * are one decision seen from several angles — "I picked this PR over those
 * four" is four pairs and one choice. Splitting them across folds trains on
 * part of a choice and validates on the rest of the same choice, so the
 * reported accuracy measures memorisation rather than generalisation.
 *
 * Deterministic (round-robin over first appearance) rather than random: the
 * same history must produce the same fit, or a retrain that changed nothing
 * would report a different accuracy and could flip the install gate.
 */
export function groupFoldsByEvent(pairs: ReviewRankPair[], k: number): number[] {
  const foldOfEvent = new Map<string, number>();
  let next = 0;
  return pairs.map((pair) => {
    let fold = foldOfEvent.get(pair.eventKey);
    if (fold === undefined) {
      fold = next % k;
      next++;
      foldOfEvent.set(pair.eventKey, fold);
    }
    return fold;
  });
}

/** The regularization strengths tried. Coarse on purpose — five features. */
export const REVIEW_RANK_LAMBDAS = [0.01, 0.1, 1, 10];

export interface ReviewRankFitResult {
  weights: number[];
  lambda: number;
  cvAccuracy: number;
  baselineAccuracy: number;
  installed: boolean;
  /** Why it was refused, when it was. Recorded so a refusal is diagnosable. */
  refusedBecause?: 'too_few_events' | 'no_lift';
}

/**
 * Fit, cross-validate, and decide whether the result is worth installing.
 *
 * Returns a REFUSAL rather than throwing when the data cannot support a model:
 * the caller stores it either way, so "we looked and it was not worth it" is a
 * recorded fact with its numbers attached rather than an absence.
 */
export function fitAndValidateReviewRank(
  pairs: ReviewRankPair[],
  nEvents: number,
  k = 5,
): ReviewRankFitResult {
  const baseWeights = REVIEW_RANK_PRIOR;

  if (nEvents < REVIEW_RANK_MIN_EVENTS) {
    return {
      weights: baseWeights,
      lambda: 0,
      cvAccuracy: 0,
      baselineAccuracy: pairwiseAccuracy(pairs, baseWeights),
      installed: false,
      refusedBecause: 'too_few_events',
    };
  }

  const folds = groupFoldsByEvent(pairs, k);
  let best: { lambda: number; accuracy: number } | null = null;

  for (const lambda of REVIEW_RANK_LAMBDAS) {
    let correct = 0;
    let total = 0;
    for (let fold = 0; fold < k; fold++) {
      const train = pairs.filter((_, i) => folds[i] !== fold);
      const validate = pairs.filter((_, i) => folds[i] === fold);
      if (train.length === 0 || validate.length === 0) continue;
      const w = fitReviewRank(train, lambda);
      correct += pairwiseAccuracy(validate, w) * validate.length;
      total += validate.length;
    }
    const accuracy = total > 0 ? correct / total : 0;
    if (!best || accuracy > best.accuracy) best = { lambda, accuracy };
  }

  const baselineAccuracy = pairwiseAccuracy(pairs, baseWeights);
  const cvAccuracy = best?.accuracy ?? 0;
  const lambda = best?.lambda ?? REVIEW_RANK_LAMBDAS[0];
  const weights = fitReviewRank(pairs, lambda);

  if (cvAccuracy < baselineAccuracy + REVIEW_RANK_MIN_LIFT) {
    return {
      weights: baseWeights,
      lambda,
      cvAccuracy,
      baselineAccuracy,
      installed: false,
      refusedBecause: 'no_lift',
    };
  }

  return { weights, lambda, cvAccuracy, baselineAccuracy, installed: true };
}
