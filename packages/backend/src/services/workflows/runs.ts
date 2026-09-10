import { v4 as uuid } from 'uuid';
import { and, desc, eq, gt, ne, sql } from 'drizzle-orm';
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

/** Derive the run status from the actions that ran. */
export function statusFromOutcomes(outcomes: WorkflowActionOutcome[]): WorkflowRunStatus {
  if (outcomes.length === 0) return 'skipped';
  const failed = outcomes.filter((o) => !o.ok).length;
  if (failed === 0) return 'succeeded';
  return failed === outcomes.length ? 'failed' : 'partial';
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
