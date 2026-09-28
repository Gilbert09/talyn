import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  CODE_REVIEW_ACTIVE_PHASES,
  type CodeReviewPhase,
  type CodeReviewPreset,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';

// Named the way mergeQueue/store.ts names it, so the two engines read alike.
type Db = ReturnType<typeof getDbClient>;
import {
  prCodeReviewEvents,
  prCodeReviewRuns,
  prCodeReviews,
  pullRequests as pullRequestsTable,
} from '../../db/schema.js';

/**
 * Reads and writes for the code-review engine.
 *
 * Two things here carry the whole design's weight and neither is obvious from
 * the call sites:
 *
 * 1. **`casTransition`** — every phase write is conditional on the review's
 *    `version`, and appends its audit row IN THE SAME TRANSACTION. A losing
 *    evaluation simply stops. There is no advisory lock anywhere in this service,
 *    deliberately: the merge queue removed its own because it pinned a pool
 *    connection across GitHub calls and starved the pooler, and CAS gives the
 *    same guarantee for none of that cost.
 *
 * 2. **`claimRun`** — the insert IS the claim. A unique violation on
 *    `(review, cycle, kind, lens, chunk)` means somebody else owns that unit, and
 *    the loser re-reads their row and finishes it rather than booting a second
 *    microVM. The same trick `loops/runs.ts` uses, and stronger: a cycle number
 *    is derived from the review's own row rather than received from outside.
 */

// ---------- Projections ----------
//
// The `Pick` on each row type is the regression guard: tsc fails if a consumer
// later reads a column the projection drops, so a projection can never silently
// re-bloat.

/** Everything the engine decides from. Small — no big text columns exist here. */
export const REVIEW_COLUMNS = {
  id: prCodeReviews.id,
  workspaceId: prCodeReviews.workspaceId,
  repositoryId: prCodeReviews.repositoryId,
  pullRequestId: prCodeReviews.pullRequestId,
  cycle: prCodeReviews.cycle,
  preset: prCodeReviews.preset,
  lensKeys: prCodeReviews.lensKeys,
  sweep: prCodeReviews.sweep,
  validate: prCodeReviews.validate,
  chunkTotal: prCodeReviews.chunkTotal,
  runsTotal: prCodeReviews.runsTotal,
  phase: prCodeReviews.phase,
  phaseStartedAt: prCodeReviews.phaseStartedAt,
  targetHeadSha: prCodeReviews.targetHeadSha,
  reviewedHeadSha: prCodeReviews.reviewedHeadSha,
  auto: prCodeReviews.auto,
  autoEnabled: prCodeReviews.autoEnabled,
  fixTaskId: prCodeReviews.fixTaskId,
  fixStartedAt: prCodeReviews.fixStartedAt,
  startedBy: prCodeReviews.startedBy,
  lastError: prCodeReviews.lastError,
  lastErrorAt: prCodeReviews.lastErrorAt,
  lastEvaluatedAt: prCodeReviews.lastEvaluatedAt,
  version: prCodeReviews.version,
  createdAt: prCodeReviews.createdAt,
  updatedAt: prCodeReviews.updatedAt,
} as const;

export type ReviewRow = Pick<
  typeof prCodeReviews.$inferSelect,
  keyof typeof REVIEW_COLUMNS
>;

/**
 * A unit as the engine and the poller see it.
 *
 * Excludes `parseError`, which carries a 2 KB excerpt of whatever would not
 * parse, and `costUsd`, which only the analytics path wants. Both would
 * otherwise ride along on every poll tick of every in-flight unit.
 */
export const RUN_COLUMNS = {
  id: prCodeReviewRuns.id,
  reviewId: prCodeReviewRuns.reviewId,
  workspaceId: prCodeReviewRuns.workspaceId,
  cycle: prCodeReviewRuns.cycle,
  kind: prCodeReviewRuns.kind,
  lens: prCodeReviewRuns.lens,
  chunkIndex: prCodeReviewRuns.chunkIndex,
  chunkTotal: prCodeReviewRuns.chunkTotal,
  status: prCodeReviewRuns.status,
  failureCode: prCodeReviewRuns.failureCode,
  provider: prCodeReviewRuns.provider,
  model: prCodeReviewRuns.model,
  sandboxId: prCodeReviewRuns.sandboxId,
  remoteTaskId: prCodeReviewRuns.remoteTaskId,
  remoteRunId: prCodeReviewRuns.remoteRunId,
  host: prCodeReviewRuns.host,
  endpoint: prCodeReviewRuns.endpoint,
  eventCursor: prCodeReviewRuns.eventCursor,
  findingCount: prCodeReviewRuns.findingCount,
  parseAttempts: prCodeReviewRuns.parseAttempts,
  dispatchedAt: prCodeReviewRuns.dispatchedAt,
  settledAt: prCodeReviewRuns.settledAt,
  createdAt: prCodeReviewRuns.createdAt,
} as const;

export type RunRow = Pick<typeof prCodeReviewRuns.$inferSelect, keyof typeof RUN_COLUMNS>;

/** The PR facts a cycle needs. Never `lastSummary` in bulk, never `body`. */
export const REVIEW_PR_COLUMNS = {
  id: pullRequestsTable.id,
  workspaceId: pullRequestsTable.workspaceId,
  repositoryId: pullRequestsTable.repositoryId,
  owner: pullRequestsTable.owner,
  repo: pullRequestsTable.repo,
  number: pullRequestsTable.number,
  state: pullRequestsTable.state,
  lastSummary: pullRequestsTable.lastSummary,
} as const;

export type ReviewPrRow = Pick<
  typeof pullRequestsTable.$inferSelect,
  keyof typeof REVIEW_PR_COLUMNS
>;

// ---------- Unit vocabulary ----------

export type RunKind = 'lens' | 'sweep' | 'validate' | 'repair';

export type RunStatus =
  | 'claimed'
  | 'dispatching'
  | 'running'
  | 'parsing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export type RunFailureCode =
  | 'capacity_deferred'
  | 'dispatch_lost'
  | 'dispatch_failed'
  | 'no_provider'
  | 'run_vanished'
  | 'timeout'
  | 'unparseable'
  // Failures BEFORE the agent ran. Distinct from `unparseable` because that one
  // means "it answered and we could not read it", and these mean "it never
  // started" — which is different advice for whoever reads the review.
  | 'prompt_too_large'
  | 'runner_out_of_space'
  | 'runner_out_of_memory';

/** Units that have not settled. The fan-in and the poller both read this set. */
export const IN_FLIGHT_RUN_STATUSES: RunStatus[] = [
  'claimed',
  'dispatching',
  'running',
  'parsing',
];

/** Units that have a live sandbox behind them, or should have. */
export const DISPATCHED_RUN_STATUSES: RunStatus[] = ['dispatching', 'running', 'parsing'];

// ---------- Reviews ----------

export async function getReview(reviewId: string, db: Db = getDbClient()): Promise<ReviewRow | null> {
  const rows = await db
    .select(REVIEW_COLUMNS)
    .from(prCodeReviews)
    .where(eq(prCodeReviews.id, reviewId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getReviewForPr(
  pullRequestId: string,
  db: Db = getDbClient()
): Promise<ReviewRow | null> {
  const rows = await db
    .select(REVIEW_COLUMNS)
    .from(prCodeReviews)
    .where(eq(prCodeReviews.pullRequestId, pullRequestId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPrForReview(
  pullRequestId: string,
  db: Db = getDbClient()
): Promise<ReviewPrRow | null> {
  const rows = await db
    .select(REVIEW_PR_COLUMNS)
    .from(pullRequestsTable)
    .where(eq(pullRequestsTable.id, pullRequestId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Open the living review for a pull request, or return the one already there.
 *
 * One row per PR for the review's whole life: a re-review bumps `cycle` on it
 * rather than inserting a second, which is what keeps the findings, their
 * dismissals and their history in one place across commits. `onConflictDoNothing`
 * plus a re-read handles two clients pressing the button at once.
 */
export async function ensureReview(input: {
  id: string;
  workspaceId: string;
  repositoryId: string;
  pullRequestId: string;
  startedBy?: string | null;
}): Promise<ReviewRow> {
  const db = getDbClient();
  await db
    .insert(prCodeReviews)
    .values({
      id: input.id,
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      pullRequestId: input.pullRequestId,
      startedBy: input.startedBy ?? null,
    })
    .onConflictDoNothing({ target: prCodeReviews.pullRequestId });
  const existing = await getReviewForPr(input.pullRequestId, db);
  if (!existing) {
    // Only reachable if the row vanished between the insert and the read, which
    // means the pull request was deleted underneath us.
    throw new Error(`could not open a review for pull request ${input.pullRequestId}`);
  }
  return existing;
}

export interface ReviewPatch {
  cycle?: number;
  preset?: CodeReviewPreset;
  lensKeys?: string[] | null;
  sweep?: boolean;
  validate?: boolean;
  chunkTotal?: number;
  runsTotal?: number;
  phase?: CodeReviewPhase;
  phaseStartedAt?: Date | null;
  targetHeadSha?: string;
  reviewedHeadSha?: string;
  auto?: boolean;
  autoEnabled?: boolean;
  fixTaskId?: string | null;
  fixStartedAt?: Date | null;
  startedBy?: string | null;
  lastError?: string | null;
  lastErrorAt?: Date | null;
  lastEvaluatedAt?: Date | null;
}

export interface ReviewEventDraft {
  fromPhase?: CodeReviewPhase | null;
  toPhase: CodeReviewPhase;
  trigger: string;
  code?: string;
  message?: string;
  detail?: Record<string, unknown>;
}

/**
 * Apply a patch only if the review is still at `expectedVersion`, and append its
 * audit row in the same transaction.
 *
 * Returns false when the CAS lost, and a caller that loses must drop the rest of
 * its pass rather than retry: another evaluation has already moved the review on
 * and will act from the newer state.
 *
 * The event is written with the transition, not after it, so the timeline cannot
 * claim something the row does not show.
 */
export async function casTransition(
  reviewId: string,
  expectedVersion: number,
  patch: ReviewPatch,
  event: ReviewEventDraft | null,
  db: Db = getDbClient()
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(prCodeReviews)
      .set({
        ...patch,
        version: sql`${prCodeReviews.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(prCodeReviews.id, reviewId), eq(prCodeReviews.version, expectedVersion)))
      .returning({ id: prCodeReviews.id });
    if (updated.length === 0) return false;
    if (event) {
      await tx.insert(prCodeReviewEvents).values({
        reviewId,
        fromPhase: event.fromPhase ?? null,
        toPhase: event.toPhase,
        trigger: event.trigger,
        code: event.code ?? null,
        message: event.message ?? '',
        detail: event.detail ?? null,
      });
    }
    return true;
  });
}

/**
 * Append an audit row without touching the review.
 *
 * For things that happened to a UNIT rather than to the review's phase — a
 * capacity deferral, a unit firing, findings arriving. They are worth recording
 * and they are not transitions, so forcing them through a CAS would mean
 * inventing a phase change to carry them.
 */
export async function appendReviewEvent(
  reviewId: string,
  event: ReviewEventDraft,
  db: Db = getDbClient()
): Promise<void> {
  await db.insert(prCodeReviewEvents).values({
    reviewId,
    fromPhase: event.fromPhase ?? null,
    toPhase: event.toPhase,
    trigger: event.trigger,
    code: event.code ?? null,
    message: event.message ?? '',
    detail: event.detail ?? null,
  });
}

export async function listReviewEvents(
  reviewId: string,
  limit = 200
): Promise<
  {
    at: Date;
    fromPhase: string | null;
    toPhase: string;
    trigger: string;
    code: string | null;
    message: string;
    detail: unknown;
  }[]
> {
  return getDbClient()
    .select({
      at: prCodeReviewEvents.at,
      fromPhase: prCodeReviewEvents.fromPhase,
      toPhase: prCodeReviewEvents.toPhase,
      trigger: prCodeReviewEvents.trigger,
      code: prCodeReviewEvents.code,
      message: prCodeReviewEvents.message,
      detail: prCodeReviewEvents.detail,
    })
    .from(prCodeReviewEvents)
    .where(eq(prCodeReviewEvents.reviewId, reviewId))
    .orderBy(desc(prCodeReviewEvents.at))
    .limit(limit);
}

/**
 * Non-terminal reviews nobody has evaluated lately.
 *
 * The reconciler's whole input. An evaluation lost to a deploy, a crash or a
 * replica moving leaves a review mid-phase with nothing scheduled to advance it,
 * and this is what finds those.
 *
 * `lt` on the date rather than a `sql` fragment, deliberately: an interpolated
 * Date carries no column type, so postgres-js throws before Postgres is asked —
 * and pglite encodes it itself, so the suite cannot catch it. That killed the
 * loop scheduler once.
 */
export async function loadStaleReviews(olderThan: Date, limit: number): Promise<ReviewRow[]> {
  return getDbClient()
    .select(REVIEW_COLUMNS)
    .from(prCodeReviews)
    .where(
      and(
        inArray(prCodeReviews.phase, CODE_REVIEW_ACTIVE_PHASES),
        or(isNull(prCodeReviews.lastEvaluatedAt), lt(prCodeReviews.lastEvaluatedAt, olderThan))
      )
    )
    .orderBy(asc(prCodeReviews.lastEvaluatedAt))
    .limit(limit);
}

/** Reviews whose fix run is this task — the `task:status` trigger's lookup. */
/**
 * The workspace's recent reviews, newest first.
 *
 * Powers the Code review panel, which is a cohort view: every review this
 * workspace has run, on its own pull requests and on other people's, so triage
 * does not mean opening each pull request in turn to find out whether it has
 * findings.
 *
 * Ordered by `updatedAt` rather than created, because what somebody wants at the
 * top is the review that just finished, not the one started first.
 */
export async function recentReviewsForWorkspace(
  workspaceId: string,
  limit: number
): Promise<ReviewRow[]> {
  return getDbClient()
    .select(REVIEW_COLUMNS)
    .from(prCodeReviews)
    .where(eq(prCodeReviews.workspaceId, workspaceId))
    .orderBy(desc(prCodeReviews.updatedAt))
    .limit(limit);
}

export async function reviewsByFixTask(taskId: string): Promise<ReviewRow[]> {
  return getDbClient()
    .select(REVIEW_COLUMNS)
    .from(prCodeReviews)
    .where(eq(prCodeReviews.fixTaskId, taskId));
}

/** Stamp that an evaluation happened, without disturbing the version. */
export async function touchEvaluated(reviewId: string): Promise<void> {
  await getDbClient()
    .update(prCodeReviews)
    .set({ lastEvaluatedAt: new Date() })
    .where(eq(prCodeReviews.id, reviewId));
}

// ---------- Units ----------

export interface ClaimKey {
  reviewId: string;
  workspaceId: string;
  cycle: number;
  kind: RunKind;
  /** '' for anything that is not a lens — NEVER null, see the migration. */
  lens: string;
  chunkIndex: number;
  chunkTotal: number;
}

export interface ClaimedRun {
  id: string;
  /** False when somebody else already owned this unit and we re-read theirs. */
  fresh: boolean;
  status: RunStatus;
}

/**
 * Claim a unit by inserting its row.
 *
 * The insert is the claim. On conflict we re-read the existing row and hand it
 * back with `fresh: false`, so the caller can finish a unit somebody else
 * started rather than starting a second one — the difference between recovering
 * from a crash and paying twice for the same lens.
 */
export async function claimRun(id: string, key: ClaimKey): Promise<ClaimedRun> {
  const db = getDbClient();
  const inserted = await db
    .insert(prCodeReviewRuns)
    .values({
      id,
      reviewId: key.reviewId,
      workspaceId: key.workspaceId,
      cycle: key.cycle,
      kind: key.kind,
      lens: key.lens,
      chunkIndex: key.chunkIndex,
      chunkTotal: key.chunkTotal,
    })
    .onConflictDoNothing({
      target: [
        prCodeReviewRuns.reviewId,
        prCodeReviewRuns.cycle,
        prCodeReviewRuns.kind,
        prCodeReviewRuns.lens,
        prCodeReviewRuns.chunkIndex,
      ],
    })
    .returning({ id: prCodeReviewRuns.id });
  if (inserted[0]) return { id: inserted[0].id, fresh: true, status: 'claimed' };

  const existing = await db
    .select({ id: prCodeReviewRuns.id, status: prCodeReviewRuns.status })
    .from(prCodeReviewRuns)
    .where(
      and(
        eq(prCodeReviewRuns.reviewId, key.reviewId),
        eq(prCodeReviewRuns.cycle, key.cycle),
        eq(prCodeReviewRuns.kind, key.kind),
        eq(prCodeReviewRuns.lens, key.lens),
        eq(prCodeReviewRuns.chunkIndex, key.chunkIndex)
      )
    )
    .limit(1);
  const row = existing[0];
  if (!row) throw new Error(`claim for ${key.kind}/${key.lens} conflicted but no row was found`);
  return { id: row.id, fresh: false, status: row.status as RunStatus };
}

export interface RunPatch {
  status?: RunStatus;
  failureCode?: RunFailureCode | null;
  provider?: string | null;
  model?: string | null;
  sandboxId?: string | null;
  remoteTaskId?: string | null;
  remoteRunId?: string | null;
  host?: string | null;
  endpoint?: string | null;
  eventCursor?: number;
  findingCount?: number;
  parseAttempts?: number;
  parseError?: string | null;
  costUsd?: string | null;
  dispatchedAt?: Date | null;
  settledAt?: Date | null;
}

export async function patchRun(runId: string, patch: RunPatch): Promise<void> {
  await getDbClient()
    .update(prCodeReviewRuns)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(prCodeReviewRuns.id, runId));
}

/**
 * Settle a unit, if it has not settled already.
 *
 * The status guard is what makes this idempotent: the poller and the deadline
 * reaper can both decide a unit is done, and whichever arrives second must not
 * overwrite the first one's outcome — a timeout landing on top of a success
 * would discard findings that had already been ingested.
 */
export async function settleRun(
  runId: string,
  outcome: { status: RunStatus; failureCode?: RunFailureCode | null; parseError?: string | null }
): Promise<boolean> {
  const updated = await getDbClient()
    .update(prCodeReviewRuns)
    .set({
      status: outcome.status,
      failureCode: outcome.failureCode ?? null,
      ...(outcome.parseError !== undefined ? { parseError: outcome.parseError } : {}),
      settledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(prCodeReviewRuns.id, runId),
        inArray(prCodeReviewRuns.status, IN_FLIGHT_RUN_STATUSES)
      )
    )
    .returning({ id: prCodeReviewRuns.id });
  return updated.length > 0;
}

export async function getRun(runId: string): Promise<RunRow | null> {
  const rows = await getDbClient()
    .select(RUN_COLUMNS)
    .from(prCodeReviewRuns)
    .where(eq(prCodeReviewRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

/** Every unit of one cycle — what `decide` reasons about. */
export async function runsForCycle(reviewId: string, cycle: number): Promise<RunRow[]> {
  return getDbClient()
    .select(RUN_COLUMNS)
    .from(prCodeReviewRuns)
    .where(and(eq(prCodeReviewRuns.reviewId, reviewId), eq(prCodeReviewRuns.cycle, cycle)))
    .orderBy(asc(prCodeReviewRuns.createdAt));
}

/** In-flight units with a sandbox behind them — the poller's sweep. */
export async function loadDispatchedRuns(limit: number): Promise<RunRow[]> {
  return getDbClient()
    .select(RUN_COLUMNS)
    .from(prCodeReviewRuns)
    .where(inArray(prCodeReviewRuns.status, DISPATCHED_RUN_STATUSES))
    .orderBy(asc(prCodeReviewRuns.dispatchedAt))
    .limit(limit);
}

/**
 * Units claimed long ago that never got a sandbox.
 *
 * `dispatched_at IS NULL` is the whole predicate, and it is why that column
 * exists: it separates "never got a runner" from "had one and it vanished". The
 * second case has its own failure code and its own recovery, and a reaper that
 * could not tell them apart would report every lost sandbox as a lost dispatch.
 */
export async function loadOrphanedClaims(olderThan: Date, limit: number): Promise<RunRow[]> {
  return getDbClient()
    .select(RUN_COLUMNS)
    .from(prCodeReviewRuns)
    .where(
      and(
        eq(prCodeReviewRuns.status, 'claimed'),
        isNull(prCodeReviewRuns.dispatchedAt),
        lt(prCodeReviewRuns.createdAt, olderThan)
      )
    )
    .limit(limit);
}

/**
 * How many of this workspace's units are live right now.
 *
 * The pacing read, taken immediately before each dispatch. No advisory lock
 * around it, deliberately, and the contrast with the plan gate is the point:
 * losing this race costs one extra microVM, which the fleet itself refuses with a
 * 503 the spill path already handles. Losing the PLAN gate's race lets a free
 * user run two cycles, which is why that one is locked. Do not "fix" one by
 * copying the other.
 */
export async function countLiveUnits(workspaceId: string): Promise<number> {
  const rows = await getDbClient()
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(prCodeReviewRuns)
    .where(
      and(
        eq(prCodeReviewRuns.workspaceId, workspaceId),
        inArray(prCodeReviewRuns.status, DISPATCHED_RUN_STATUSES)
      )
    );
  return rows[0]?.count ?? 0;
}

/**
 * Units dispatched so recently that the fleet's own capacity report cannot know
 * about them yet.
 *
 * Hosts push a snapshot every ~15 seconds, so `runsLive` lags. Without this
 * correction a burst of dispatches all read the same stale "there is room" and
 * overshoot together.
 */
export async function countUnitsDispatchedSince(since: Date): Promise<number> {
  const rows = await getDbClient()
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(prCodeReviewRuns)
    .where(
      and(
        inArray(prCodeReviewRuns.status, DISPATCHED_RUN_STATUSES),
        // `gte`, never an interpolated `sql` fragment — see loadStaleReviews.
        gte(prCodeReviewRuns.dispatchedAt, since)
      )
    );
  return rows[0]?.count ?? 0;
}
