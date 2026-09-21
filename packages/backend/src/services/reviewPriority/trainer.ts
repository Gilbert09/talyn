// Turn a viewer's review history into the profile and model the client ranks with.
//
// Three steps, each independently testable:
//
//   1. aggregate  — per-author, per-directory and per-repo counts
//   2. pair       — the co-pending choice sets that become training pairs
//   3. fit        — L2 pairwise logistic, cross-validated, gated on lift
//
// The pairing step is the one with a real idea in it. See `reviewRank.ts` for
// why the label is pairwise; this file is where "every OTHER PR that was open,
// requested of them, and still unreviewed at that exact moment" becomes code.

import { and, eq } from 'drizzle-orm';
import {
  REVIEW_RANK_MIN_EVENTS,
  computeFeatureStats,
  recencyWeight,
  fitAndValidateReviewRank,
  reviewRankFeatures,
  standardize,
  type ReviewRankPair,
  type ReviewRankProfile,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { reviewHistory, reviewRankModels } from '../../db/schema.js';
import { invalidateReviewRankProfile } from './score.js';

/**
 * The counting half of a profile — everything except the feature scales and the
 * fitted model, both of which are derived from it.
 */
export type ReviewRankAggregates = Pick<
  ReviewRankProfile,
  'authorAffinity' | 'teamAffinity' | 'dirAffinity' | 'repoAffinity'
>;

/** One history row, as the trainer reads it. */
export interface TrainingRow {
  repoFullName: string;
  prNumber: number;
  authorLogin: string;
  requestedAt: Date | null;
  reviewedAt: Date | null;
  closedAt: Date | null;
  additions: number | null;
  deletions: number | null;
  dirs: string[];
  /** Team slugs whose request put this PR in front of the viewer. */
  teams: string[];
}

/**
 * Build the per-viewer aggregates the features are computed from.
 *
 * `gave` counts reviews the viewer performed; `got` counts PRs by that author
 * which the viewer was asked to look at but did not — which is a decent proxy
 * for "this person routes work at me" and is the only reciprocity signal
 * available without reading the viewer's OWN PRs (a second, separate history).
 *
 * Deliberately built from EVERY row, positive and negative. An affinity map
 * built only from reviews performed says "you review the people you review",
 * which is true and useless: the denominator is what makes it a rate.
 */
export function buildProfile(rows: TrainingRow[], now = Date.now()): ReviewRankAggregates {
  const authorAffinity: Record<string, { gave: number; got: number }> = {};
  const teamAffinity: Record<string, { gave: number; got: number }> = {};
  const dirAffinity: Record<string, number> = {};
  const repoCounts: Record<string, number> = {};
  let reviewed = 0;

  for (const row of rows) {
    // Every contribution is RECENCY-WEIGHTED. Without this the profile is a
    // lifetime total and can only say who the viewer has ever worked with,
    // never who they work with now — so somebody who reviewed a team heavily
    // last year and none since still reads as their closest reviewer.
    const at = row.reviewedAt ?? row.requestedAt ?? row.closedAt;
    const ageDays = at ? (now - at.getTime()) / 86_400_000 : 0;
    const w = recencyWeight(ageDays);

    const author = row.authorLogin.toLowerCase();
    const entry = (authorAffinity[author] ??= { gave: 0, got: 0 });
    entry.got += w;

    // A PR can be requested by more than one team, and each of them asked.
    for (const team of row.teams) {
      const slug = team.toLowerCase();
      const t = (teamAffinity[slug] ??= { gave: 0, got: 0 });
      t.got += w;
    }

    if (row.reviewedAt) {
      entry.gave += w;
      for (const team of row.teams) {
        teamAffinity[team.toLowerCase()].gave += w;
      }
      reviewed += w;
      // Directory and repo familiarity come from reviews ACTUALLY PERFORMED.
      // A PR you were asked about and ignored taught you nothing about its
      // files, so counting it would make "familiar" mean "adjacent to".
      for (const dir of row.dirs) dirAffinity[dir] = (dirAffinity[dir] ?? 0) + w;
      const repo = row.repoFullName.toLowerCase();
      repoCounts[repo] = (repoCounts[repo] ?? 0) + w;
    }
  }

  const repoAffinity: Record<string, number> = {};
  for (const [repo, count] of Object.entries(repoCounts)) {
    repoAffinity[repo] = reviewed > 0 ? count / reviewed : 0;
  }

  return { authorAffinity, teamAffinity, dirAffinity, repoAffinity };
}

/** A row with the timestamps the pairing step requires. */
interface PendingRow extends TrainingRow {
  requestedAt: Date;
}

/**
 * Was this PR pending for the viewer at instant `t`?
 *
 * Pending means: requested before `t`, and not yet answered or gone at `t`.
 * This predicate IS the Gmail "opportunity to see" rule — a PR only becomes a
 * negative example because it was demonstrably in front of the viewer and
 * passed over, so there is no way to accidentally penalise something they never
 * saw.
 */
function pendingAt(row: PendingRow, t: number): boolean {
  if (row.requestedAt.getTime() > t) return false;
  if (row.reviewedAt && row.reviewedAt.getTime() <= t) return false;
  if (row.closedAt && row.closedAt.getTime() <= t) return false;
  return true;
}

/**
 * The most other-PRs one review decision may contribute.
 *
 * A reviewer with sixty standing requests who reviews one produces fifty-nine
 * pairs from a single decision, which would let their busiest week outvote
 * every other week combined. Capped at the ten most-recently-requested, which
 * is both a bound and the better sample: a request from three months ago that
 * is still open was not a live alternative to anything.
 */
export const MAX_CHOICE_SET = 10;

/**
 * Build the training pairs: for each review the viewer performed, one pair
 * against each PR that was pending at that same instant.
 */
export function buildPairs(
  rows: TrainingRow[],
  profile: ReviewRankAggregates,
): { pairs: ReviewRankPair[]; nEvents: number } {
  const full: ReviewRankProfile = { ...profile, featureStats: null, model: null };
  const withRequest = rows.filter((r): r is PendingRow => !!r.requestedAt);

  // Raw feature vectors first, so the standardisation is computed over the same
  // population the fit sees rather than per-pair.
  const rawByKey = new Map<string, number[]>();
  const keyOf = (r: TrainingRow) => `${r.repoFullName}#${r.prNumber}`;
  for (const row of withRequest) {
    rawByKey.set(
      keyOf(row),
      reviewRankFeatures(
        {
          author: row.authorLogin,
          repoFullName: row.repoFullName,
          dirs: row.dirs,
          teams: row.teams,
          additions: row.additions ?? undefined,
          deletions: row.deletions ?? undefined,
        },
        full,
      ),
    );
  }
  const stats = computeFeatureStats([...rawByKey.values()]);
  const stdByKey = new Map<string, number[]>();
  for (const [key, raw] of rawByKey) stdByKey.set(key, standardize(raw, stats));

  const events = withRequest
    .filter((r) => r.reviewedAt)
    .sort((a, b) => a.reviewedAt!.getTime() - b.reviewedAt!.getTime());

  const pairs: ReviewRankPair[] = [];
  for (const winner of events) {
    const t = winner.reviewedAt!.getTime();
    const winnerKey = keyOf(winner);
    const alternatives = withRequest
      .filter((r) => keyOf(r) !== winnerKey && pendingAt(r, t))
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())
      .slice(0, MAX_CHOICE_SET);

    const wf = stdByKey.get(winnerKey);
    if (!wf) continue;
    for (const loser of alternatives) {
      const lf = stdByKey.get(keyOf(loser));
      if (!lf) continue;
      pairs.push({
        diff: wf.map((v, i) => v - lf[i]),
        // Every pair from one decision shares a key, which is what keeps them
        // in one CV fold — see groupFoldsByEvent.
        eventKey: `${winnerKey}@${t}`,
      });
    }
  }

  // Events, not pairs. The pairs from one decision are one choice seen from
  // several angles, so counting them would inflate the parameter budget
  // fourfold — the exact mistake that budget exists to prevent.
  return { pairs, nEvents: events.length };
}

export interface TrainResult {
  nEvents: number;
  pairs: number;
  installed: boolean;
  cvAccuracy: number;
  baselineAccuracy: number;
  refusedBecause?: string;
}

/**
 * Aggregate, pair, fit and store — the whole pipeline for one viewer.
 *
 * Stores a REFUSAL as readily as a model. "We looked and it was not worth it",
 * with its numbers attached, is the only way to find out later whether this
 * limb earned its place; an absent row would be indistinguishable from a
 * trainer that never ran.
 */
export async function trainReviewRank(
  workspaceId: string,
  viewerLogin: string,
): Promise<TrainResult> {
  const db = getPoolDbClient();
  const rows = (await db
    .select({
      repoFullName: reviewHistory.repoFullName,
      prNumber: reviewHistory.prNumber,
      authorLogin: reviewHistory.authorLogin,
      requestedAt: reviewHistory.requestedAt,
      reviewedAt: reviewHistory.reviewedAt,
      closedAt: reviewHistory.closedAt,
      additions: reviewHistory.additions,
      deletions: reviewHistory.deletions,
      dirs: reviewHistory.dirs,
      teams: reviewHistory.teams,
    })
    .from(reviewHistory)
    .where(
      and(eq(reviewHistory.workspaceId, workspaceId), eq(reviewHistory.viewerLogin, viewerLogin)),
    )) as TrainingRow[];

  const profile = buildProfile(rows);
  const { pairs, nEvents } = buildPairs(rows, profile);

  // Feature stats are recomputed here on the same population the pairs came
  // from, because the CLIENT needs them: it standardises a live PR with these
  // numbers, and using anything else would score it on a different scale from
  // the one the weights were fitted on.
  const raw = rows
    .filter((r) => r.requestedAt)
    .map((r) =>
      reviewRankFeatures(
        {
          author: r.authorLogin,
          repoFullName: r.repoFullName,
          dirs: r.dirs,
          teams: r.teams,
          additions: r.additions ?? undefined,
          deletions: r.deletions ?? undefined,
        },
        { ...profile, featureStats: null, model: null },
      ),
    );
  const featureStats = computeFeatureStats(raw);

  const fit = fitAndValidateReviewRank(pairs, nEvents);

  await db
    .insert(reviewRankModels)
    .values({
      workspaceId,
      viewerLogin,
      weights: fit.weights,
      featureStats,
      // Stats ride on the profile blob too, because the CLIENT reads them from
      // there — they describe the viewer's population of PRs, not the fit, and
      // the shipped prior needs them on a viewer who has no model yet.
      profile: { ...profile, featureStats },
      nEvents,
      cvAccuracy: fit.cvAccuracy,
      baselineAccuracy: fit.baselineAccuracy,
      installed: fit.installed,
      refusedBecause: fit.refusedBecause ?? null,
      trainedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [reviewRankModels.workspaceId, reviewRankModels.viewerLogin],
      set: {
        weights: fit.weights,
        featureStats,
        profile: { ...profile, featureStats },
        nEvents,
        cvAccuracy: fit.cvAccuracy,
        baselineAccuracy: fit.baselineAccuracy,
        installed: fit.installed,
        refusedBecause: fit.refusedBecause ?? null,
        trainedAt: new Date(),
      },
    });

  // The list route caches the profile for five minutes, so a fresh fit would
  // otherwise sit invisible for that long. Dropped here rather than on a TTL
  // guess: the trainer is the only thing that writes it.
  invalidateReviewRankProfile(workspaceId, viewerLogin);

  return {
    nEvents,
    pairs: pairs.length,
    installed: fit.installed,
    cvAccuracy: fit.cvAccuracy,
    baselineAccuracy: fit.baselineAccuracy,
    refusedBecause: fit.refusedBecause,
  };
}

/** What `GET /workspaces/:id/review-rank-model` answers. */
export interface ReviewRankPayload extends ReviewRankProfile {
  /** Review events behind the model. Drives the blend AND the settings copy. */
  nEvents: number;
  /** How many more events until a personal model is even attempted. */
  eventsUntilPersonalized: number;
}

/**
 * Read the stored profile + model for a viewer.
 *
 * Returns a serving-the-prior answer rather than null when there is nothing
 * stored, so the client has one shape to handle. The ordering works fine
 * without a model — that is the point of the prior — so "no model yet" is a
 * normal state and not an error.
 */
export async function readReviewRankPayload(
  workspaceId: string,
  viewerLogin: string,
): Promise<ReviewRankPayload> {
  const db = getPoolDbClient();
  const [row] = await db
    .select({
      weights: reviewRankModels.weights,
      featureStats: reviewRankModels.featureStats,
      profile: reviewRankModels.profile,
      nEvents: reviewRankModels.nEvents,
      cvAccuracy: reviewRankModels.cvAccuracy,
      baselineAccuracy: reviewRankModels.baselineAccuracy,
      installed: reviewRankModels.installed,
    })
    .from(reviewRankModels)
    .where(
      and(
        eq(reviewRankModels.workspaceId, workspaceId),
        eq(reviewRankModels.viewerLogin, viewerLogin),
      ),
    )
    .limit(1);

  const empty: ReviewRankPayload = {
    authorAffinity: {},
    teamAffinity: {},
    dirAffinity: {},
    repoAffinity: {},
    featureStats: null,
    model: null,
    nEvents: 0,
    eventsUntilPersonalized: REVIEW_RANK_MIN_EVENTS,
  };
  if (!row) return empty;

  const profile = (row.profile ?? {}) as Partial<ReviewRankProfile>;
  const nEvents = row.nEvents ?? 0;
  return {
    authorAffinity: profile.authorAffinity ?? {},
    teamAffinity: profile.teamAffinity ?? {},
    dirAffinity: profile.dirAffinity ?? {},
    repoAffinity: profile.repoAffinity ?? {},
    featureStats: (row.featureStats ?? profile.featureStats ?? null) as
      | { mean: number[]; sd: number[] }
      | null,
    model: {
      installed: row.installed === true,
      nEvents,
      weights: (row.weights ?? []) as number[],
      cvAccuracy: row.cvAccuracy ?? 0,
      baselineAccuracy: row.baselineAccuracy ?? 0,
    },
    nEvents,
    eventsUntilPersonalized: Math.max(0, REVIEW_RANK_MIN_EVENTS - nEvents),
  };
}
