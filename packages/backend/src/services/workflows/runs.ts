import { v4 as uuid } from 'uuid';
import { and, desc, eq, gt, lte, ne, sql } from 'drizzle-orm';
import type {
  WorkflowActionOutcome,
  WorkflowEventFacts,
  WorkflowRun,
  WorkflowRunStatus,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { workflowRuns as runsTable } from '../../db/schema.js';
import { rowToWorkflowRun } from './store.js';

/**
 * The run row's lifecycle, and the rate cap that reads it.
 *
 * # The insert IS the claim
 *
 * `claimRun` inserts the row BEFORE any action executes, relying on the unique
 * index on `(workflow_id, delivery_id)`. A conflict means this delivery has
 * already been handled — by another replica, or by GitHub's own redelivery of
 * the same event — and the caller returns without acting. That is the whole
 * distributed-idempotency design: no advisory lock, no shared cache, and it is
 * correct across a deploy overlap because it is the database enforcing it.
 *
 * The webhook worker's own `recentRefresh` coalescing map cannot serve here: it
 * is in-memory and per-replica, which is fine for "should I re-fetch this PR"
 * and useless for "should I post this comment".
 */

/** What a claim attempt found. */
export type ClaimResult =
  | { claimed: true; run: WorkflowRun }
  /** Another delivery/replica owns this (workflow, delivery). */
  | { claimed: false; reason: 'duplicate' };

export interface ClaimInput {
  workflowId: string;
  workspaceId: string;
  repositoryId: string | null;
  facts: WorkflowEventFacts;
  deliveryId: string;
  pullRequestId?: string | null;
}

export async function claimRun(input: ClaimInput): Promise<ClaimResult> {
  const { facts } = input;
  const row = {
    id: uuid(),
    workflowId: input.workflowId,
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    repoFullName: facts.repoFullName,
    prNumber: facts.number,
    prTitle: facts.title,
    prUrl: facts.url,
    prAuthor: facts.author.login,
    pullRequestId: input.pullRequestId ?? null,
    taskId: null,
    event: facts.event,
    deliveryId: input.deliveryId,
    status: 'running' as WorkflowRunStatus,
    actions: [] as WorkflowActionOutcome[],
    error: null,
    retryAfter: null,
    attempts: 1,
    // Kept so a retry is faithful — see the column's note. The webhook payload
    // is gone by the time a rate-limit gate clears.
    facts,
    createdAt: new Date(),
  };

  const inserted = await getDbClient()
    .insert(runsTable)
    .values(row)
    .onConflictDoNothing({ target: [runsTable.workflowId, runsTable.deliveryId] })
    .returning({ id: runsTable.id });

  if (inserted.length === 0) return { claimed: false, reason: 'duplicate' };
  return { claimed: true, run: rowToWorkflowRun(row as typeof runsTable.$inferSelect) };
}

/** Record a run that deliberately did nothing, so the refusal is visible. */
export async function recordSkippedRun(
  input: ClaimInput,
  outcome: WorkflowActionOutcome
): Promise<WorkflowRun | null> {
  const claim = await claimRun(input);
  if (!claim.claimed) return null;
  return settleRun(claim.run.id, { status: 'skipped', actions: [outcome] });
}

export interface SettleInput {
  status: WorkflowRunStatus;
  actions: WorkflowActionOutcome[];
  taskId?: string | null;
  pullRequestId?: string | null;
  error?: string | null;
  /** When a `pending_retry` run becomes due. Cleared on any other status. */
  retryAfter?: Date | null;
  /** Set when re-running, so the sweep can bound how many times it tries. */
  attempts?: number;
}

/**
 * Write a claimed run's outcome and return the settled row.
 *
 * TWO writes, and the split is deliberate. The status and the per-action
 * outcomes are the record — what the workflow did, and what refused. The task
 * and pull-request pointers are convenience links behind foreign keys, and a row
 * either can name may be gone by the time this runs (a task deleted mid-run, a
 * PR un-watched, which deletes its row). One combined UPDATE would fail on the
 * FK and leave the run stuck at `running` forever: the history would lose the
 * outcome to protect a link. So the outcome lands first, unconditionally, and
 * the links are attached best-effort afterwards.
 */
export async function settleRun(runId: string, input: SettleInput): Promise<WorkflowRun | null> {
  const db = getDbClient();
  await db
    .update(runsTable)
    .set({
      status: input.status,
      actions: input.actions,
      error: input.error ?? null,
      // Always written, never merged: a run that has just succeeded must not keep
      // the schedule that parked it, or the sweep would pick it up forever.
      retryAfter: input.status === 'pending_retry' ? (input.retryAfter ?? null) : null,
      ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
    })
    .where(eq(runsTable.id, runId));

  const links: { taskId?: string | null; pullRequestId?: string | null } = {};
  if (input.taskId !== undefined) links.taskId = input.taskId;
  if (input.pullRequestId !== undefined) links.pullRequestId = input.pullRequestId;
  if (Object.keys(links).length > 0) {
    await db
      .update(runsTable)
      .set(links)
      .where(eq(runsTable.id, runId))
      .catch((err: unknown) => {
        console.warn(
          `[workflows] could not link run ${runId} to its task/PR (the row is gone?):`,
          err instanceof Error ? err.message : err
        );
      });
  }

  const rows = await db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
  return rows[0] ? rowToWorkflowRun(rows[0]) : null;
}

/**
 * How many times a run's actions are attempted before it is given up on.
 *
 * Each attempt is scheduled for the moment the gate clears, and GitHub's longest
 * single backoff is five minutes (`MAX_BACKOFF_MS`). So five attempts spans a
 * sustained ~25-minute throttle — past which the account has a problem that
 * retrying a label will not fix, and the PR event is old enough that acting on it
 * is arguably wrong anyway.
 */
export const MAX_RETRY_ATTEMPTS = 5;

/** Derive the run status from the actions that ran. */
export function statusFromOutcomes(outcomes: WorkflowActionOutcome[]): WorkflowRunStatus {
  if (outcomes.length === 0) return 'skipped';
  const failed = outcomes.filter((o) => !o.ok).length;
  if (failed === 0) return 'succeeded';
  return failed === outcomes.length ? 'failed' : 'partial';
}

/**
 * Failure codes worth trying again.
 *
 * Only `rate_gated`. It is the one failure that is unambiguously TRANSIENT and
 * that tells us WHEN it clears — the gate holds the instant, so the retry can be
 * scheduled rather than guessed at.
 *
 * Deliberately not the others, each for its own reason:
 *  - `task_limit_reached` is a plan decision, not a fault. Retrying it in a loop
 *    would be Talyn nagging its way around a limit the user has chosen to live
 *    with, and the slot frees on a human timescale anyway.
 *  - `github_error` covers a 500 and a 422 alike, and nothing in the message
 *    reliably separates "try again" from "this will never work".
 *  - `task_already_running` resolves, but by the time it does the PR event that
 *    triggered the workflow is old news.
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(['rate_gated']);

/** Whether an outcome is one the sweep should have another go at. */
export function isRetryable(outcome: WorkflowActionOutcome): boolean {
  return !outcome.ok && RETRYABLE_CODES.has(outcome.code ?? '');
}

/**
 * Never re-run sooner than this after a gate is reported clear.
 *
 * The gate's own instant is when GitHub said it would lift, not when it provably
 * has — retrying on the exact tick walks straight back into it and burns an
 * attempt. A few seconds past is enough to tell the two apart.
 */
const RETRY_GRACE_MS = 5_000;

/**
 * How a run should settle given what its actions did, and when it is due if
 * anything is owed.
 *
 * `blockedUntilMs` is the gate's own answer (0 when it has already cleared), so
 * the schedule is read from the thing that knows rather than inferred from an
 * error string.
 */
export function settlementFor(
  outcomes: WorkflowActionOutcome[],
  opts: { blockedUntilMs: number; attempts: number; now?: number }
): { status: WorkflowRunStatus; retryAfter: Date | null } {
  const status = statusFromOutcomes(outcomes);
  const owed = outcomes.some(isRetryable);
  if (!owed || opts.attempts >= MAX_RETRY_ATTEMPTS) {
    // Out of attempts is a real failure and reads as one — the history should not
    // claim a run is still waiting when nothing will pick it up again.
    return { status, retryAfter: null };
  }
  const now = opts.now ?? Date.now();
  return {
    status: 'pending_retry',
    retryAfter: new Date(Math.max(opts.blockedUntilMs, now) + RETRY_GRACE_MS),
  };
}

// ---- The rate cap ---------------------------------------------------------

export type RateVerdict =
  /** Under the cap — go ahead. */
  | { allowed: true }
  /** Over the cap, and this is the first refusal in the window: record it. */
  | { allowed: false; announce: true }
  /**
   * Over the cap and already announced. Say nothing — a storm must not fill the
   * history with identical refusals.
   */
  | { allowed: false; announce: false };

/**
 * Whether this workflow may run on this PR again right now.
 *
 * Counted from `workflow_runs` rather than an in-process window, so it survives
 * a restart and is shared by every replica. `skipped` rows are excluded from the
 * count — otherwise each refusal would count toward the cap that produced it and
 * the workflow could never recover.
 */
export async function checkRateCap(opts: {
  workflowId: string;
  repoFullName: string;
  prNumber: number;
  cap: number;
  windowMs?: number;
}): Promise<RateVerdict> {
  const windowMs = opts.windowMs ?? 60 * 60 * 1000;
  const since = new Date(Date.now() - windowMs);
  const db = getDbClient();
  const scope = and(
    eq(runsTable.workflowId, opts.workflowId),
    eq(runsTable.repoFullName, opts.repoFullName),
    eq(runsTable.prNumber, opts.prNumber),
    gt(runsTable.createdAt, since)
  );

  const counted = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runsTable)
    .where(and(scope, ne(runsTable.status, 'skipped')));
  if (Number(counted[0]?.n ?? 0) < opts.cap) return { allowed: true };

  // Announce only the first refusal in the window: if the newest row for this
  // PR is already a skip, the user has been told.
  const latest = await db
    .select({ status: runsTable.status })
    .from(runsTable)
    .where(scope)
    .orderBy(desc(runsTable.createdAt))
    .limit(1);
  return { allowed: false, announce: latest[0]?.status !== 'skipped' };
}


// ---- The retry sweep's queries -------------------------------------------

/** A parked run the sweep should re-run, with what it needs to do it. */
export interface DueRetry {
  id: string;
  workflowId: string;
  workspaceId: string;
  repositoryId: string | null;
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  prAuthor: string;
  pullRequestId: string | null;
  taskId: string | null;
  event: string;
  actions: WorkflowActionOutcome[];
  attempts: number;
  facts: unknown;
}

/**
 * Runs whose retry has come due, oldest first.
 *
 * Oldest first because a workflow action is about a pull request event, and the
 * one that has been waiting longest is the one closest to being stale. The
 * `limit` bounds a sweep tick rather than the work: anything left is picked up by
 * the next one, which is what keeps one tick from trying to drain a whole
 * outage's backlog through a rate-limited account.
 */
export async function dueRetries(limit: number, now = new Date()): Promise<DueRetry[]> {
  const rows = await getDbClient()
    .select({
      id: runsTable.id,
      workflowId: runsTable.workflowId,
      workspaceId: runsTable.workspaceId,
      repositoryId: runsTable.repositoryId,
      repoFullName: runsTable.repoFullName,
      prNumber: runsTable.prNumber,
      prTitle: runsTable.prTitle,
      prUrl: runsTable.prUrl,
      prAuthor: runsTable.prAuthor,
      pullRequestId: runsTable.pullRequestId,
      taskId: runsTable.taskId,
      event: runsTable.event,
      actions: runsTable.actions,
      attempts: runsTable.attempts,
      facts: runsTable.facts,
    })
    .from(runsTable)
    .where(and(eq(runsTable.status, 'pending_retry'), lte(runsTable.retryAfter, now)))
    .orderBy(runsTable.retryAfter)
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    actions: (r.actions ?? []) as WorkflowActionOutcome[],
  }));
}
