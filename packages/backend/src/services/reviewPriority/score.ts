// Score the Reviews list SERVER-SIDE, so the ranking can change without a release.
//
// # Why this moved
//
// The ordering started as a pure function the client ran over rows it already
// held, and that was right for everything except the one thing that turned out
// to matter most: iteration speed. `packages/shared` is bundled into the
// desktop app, so every change to the ranking — not just a weight, but any
// LOGIC — needed a release and an update before anybody could see it.
//
// The first day of real use produced four fixes: bot detection that read
// GitHub's `__typename` instead of guessing from the login, a chip that could
// actually name the model, team affinity, and recency weighting. Every one was
// logic rather than configuration, so shipping weights from the server would
// not have helped with any of them. Computing the whole verdict here would have
// made all four live in minutes.
//
// # What this does NOT change
//
// The scoring function itself. `scorePRForReview` still lives in
// `packages/shared` and is still the single definition — it is simply called
// here rather than in the renderer. Two copies of a ranker is the failure the
// shared package exists to prevent, and moving where it runs must not become
// moving what it is.
//
// # Staleness, which is a feature here
//
// The client refetches the list on mount and on Refresh; WebSocket updates
// patch rows in place without re-sorting. So a verdict computed here holds
// until the next list fetch — and that is the behaviour the design already
// wanted. Re-ranking a triage queue under somebody's cursor is the hazard
// `buildPRPriorityMap`'s pinned `now` exists to avoid.

import { and, eq, inArray } from 'drizzle-orm';
import {
  TASK_STATUS_TERMINAL,
  scorePRForReview,
  type PRPriorityTarget,
  type PRPriorityVerdict,
  type ReviewRankProfile,
  type TaskStatus,
} from '@talyn/shared';
import type { Database } from '../../db/client.js';
import { tasks as tasksTable, reviewRankModels } from '../../db/schema.js';

/**
 * How long a viewer's profile is held in memory.
 *
 * The trainer rewrites it at most hourly and usually far less often, so a read
 * per list request would be a query to learn nothing. Five minutes keeps a
 * fresh fit visible quickly without making the hot path pay for it.
 */
const PROFILE_TTL_MS = 5 * 60_000;

const profileCache = new Map<string, { profile: ReviewRankProfile | null; expiresAt: number }>();

/** Drop a cached profile — called when the trainer writes a new one. */
export function invalidateReviewRankProfile(workspaceId: string, viewerLogin: string): void {
  profileCache.delete(`${workspaceId}:${viewerLogin.toLowerCase()}`);
}

/** Exposed for tests, which must not inherit another case's cache. */
export function _resetReviewPriorityCache(): void {
  profileCache.clear();
}

async function readProfile(
  db: Database,
  workspaceId: string,
  viewerLogin: string,
): Promise<ReviewRankProfile | null> {
  const key = `${workspaceId}:${viewerLogin.toLowerCase()}`;
  const hit = profileCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.profile;

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

  const stored = (row?.profile ?? {}) as Partial<ReviewRankProfile>;
  // A row with no aggregates is not a profile. Returning an empty one would
  // make every affinity feature a confident zero rather than an absent signal.
  const profile: ReviewRankProfile | null = row
    ? {
        authorAffinity: stored.authorAffinity ?? {},
        teamAffinity: stored.teamAffinity ?? {},
        dirAffinity: stored.dirAffinity ?? {},
        repoAffinity: stored.repoAffinity ?? {},
        featureStats:
          (row.featureStats as ReviewRankProfile['featureStats']) ??
          stored.featureStats ??
          null,
        model: {
          installed: row.installed === true,
          nEvents: row.nEvents ?? 0,
          weights: (row.weights ?? []) as number[],
          cvAccuracy: row.cvAccuracy ?? 0,
          baselineAccuracy: row.baselineAccuracy ?? 0,
        },
      }
    : null;

  profileCache.set(key, { profile, expiresAt: Date.now() + PROFILE_TTL_MS });
  return profile;
}

/**
 * The DATABASE row shape, not the scorer's.
 *
 * The translation between them lives here rather than at the call site on
 * purpose: the column is `last_summary` and carries `Date`s, while the shared
 * scorer speaks `summary` and ISO strings because it was written for the wire.
 * Casting one to the other at the route would compile and then silently feed
 * the age term a `Date` it reads as NaN.
 */
export interface ScorableRow {
  id: string;
  owner: string;
  repo: string;
  taskId: string | null;
  mergeQueued?: boolean;
  reviewRequested?: boolean;
  reviewRequestedFirstSeenAt?: Date | null;
  createdAt?: Date;
  lastSummary?: unknown;
}

function toTarget(row: ScorableRow): PRPriorityTarget {
  return {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    taskId: row.taskId,
    mergeQueued: row.mergeQueued,
    createdAt: row.createdAt?.toISOString(),
    reviewRequestedFirstSeenAt: row.reviewRequestedFirstSeenAt?.toISOString() ?? null,
    summary: (row.lastSummary ?? {}) as PRPriorityTarget['summary'],
  };
}

/**
 * Score every review-requested row, keyed by row id.
 *
 * Returns an empty map rather than throwing on any failure. This runs while
 * serving the list that paints the Reviews page: a ranking that cannot be
 * computed should cost the ordering, never the page. The client falls back to
 * its own copy of the same function when a verdict is missing.
 */
export async function scoreReviewRows(
  db: Database,
  workspaceId: string,
  viewerLogin: string | null,
  rows: ScorableRow[],
): Promise<Map<string, PRPriorityVerdict>> {
  const out = new Map<string, PRPriorityVerdict>();
  const cohort = rows.filter((r) => r.reviewRequested);
  if (cohort.length === 0) return out;

  try {
    const profile = viewerLogin ? await readProfile(db, workspaceId, viewerLogin) : null;

    // One query for the linked tasks, not one per row. Only the ids actually
    // present — a workspace with hundreds of finished tasks must not pay for
    // them to answer a question about the handful that are linked.
    const taskIds = [...new Set(cohort.map((r) => r.taskId).filter((id): id is string => !!id))];
    const statusById = new Map<string, TaskStatus>();
    if (taskIds.length > 0) {
      const taskRows = await db
        .select({ id: tasksTable.id, status: tasksTable.status })
        .from(tasksTable)
        .where(inArray(tasksTable.id, taskIds));
      for (const t of taskRows) statusById.set(t.id, t.status as TaskStatus);
    }

    // Pinned once for the whole pass, exactly as the client did. A clock that
    // advances mid-sort makes a comparator non-transitive.
    const now = Date.now();
    for (const row of cohort) {
      out.set(
        row.id,
        scorePRForReview(toTarget(row), {
          now,
          profile,
          isTaskActive: (taskId) => {
            const status = statusById.get(taskId);
            return status ? TASK_STATUS_TERMINAL[status] === false : false;
          },
        }),
      );
    }
  } catch (err) {
    console.warn(
      `[review-priority] could not score ${workspaceId.slice(0, 8)}:`,
      err instanceof Error ? err.message : err,
    );
    return new Map();
  }

  return out;
}
