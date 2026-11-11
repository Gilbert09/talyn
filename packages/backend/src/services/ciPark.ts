import { v4 as uuid } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import {
  buildAwaitCiResumePrompt,
  deriveCiVerdict,
  isSandboxSize,
  readCloudTaskMeta,
  type AwaitCiOutcome,
  type CheckFact,
  type CloudTaskMetadata,
  type SandboxSize,
  type TaskResult,
  type TaskStatus,
} from '@talyn/shared';
import { getDbClient, runWithoutScope } from '../db/client.js';
import { pullRequests as pullRequestsTable, tasks as tasksTable } from '../db/schema.js';
import { guardCrossReplica } from './advisoryLock.js';
import { captureWorkspaceEvent } from './analytics.js';
import { billingEnabled, checkBoxGate, isBoxGateError } from './billing/entitlements.js';
import { boxDeferral, deferralRetryAt, noteBoxRefusal, ownerBoxHold, releaseBoxHold } from './billing/boxDeferral.js';
import { meterBoxClosed, meterBoxOpened } from './billing/usageHooks.js';
import { readLedgerFacts } from './checkCounts.js';
import { debugBus } from './debugBus.js';
import { domainEvents, type DomainPrChecksEvent } from './events.js';
import { getSelfHostedClient } from './selfHosted/credentials.js';
import {
  FleetCapacityError,
  FleetHttpError,
  FleetRunNotFoundError,
  FleetTaskRefusedError,
  FleetThrottleError,
  type FleetClient,
  type FleetSandboxTask,
} from './selfHosted/client.js';
import { resolveRunCredentials } from './selfHosted/runCredentials.js';
import { TASK_SYSTEM_PROMPT } from './selfHosted/systemPrompts.js';
import { patchTaskMetadata } from './taskMetadataMutex.js';
import { TickGuard } from './tickGuard.js';
import { emitTaskStatus } from './websocket.js';
import { withMemoryIndex } from './workbenches/memory.js';
import { ownerOfWorkspace } from './workflows/owner.js';

/**
 * CI park: a Talyn Fleet fix run that published ends its turn with
 * `TALYN_AWAIT_CI: <sha>`, the fleet poller suspends its box and marks the
 * task `waiting_ci`, and this module resumes the same conversation when the
 * PR's checks settle. A suspended box bills nothing; the alternative was an
 * agent sleeping through a 40-minute CI on an awake box.
 *
 * Everything here reads `metadata.awaitCi`, which only a run stamped with
 * `metadata.ciPark` (the `ci-park` flag, decided at creation) can get. With the
 * flag off no task is ever `waiting_ci`, so the sweep finds nothing and the
 * `pr:checks` listener returns on an empty set.
 */

/** How often the sweep looks at parked runs. */
const SWEEP_INTERVAL_MS = 60_000;
/** The longest a run waits for CI before Talyn resumes it to look itself. */
export const CI_PARK_DEADLINE_MS = 3 * 60 * 60_000;
/** A run may park this many times; the next sentinel finishes it. */
export const MAX_CI_PARKS = 6;
/** A fresh wall for a resumed box. Longer than any CI wait plus the fix after it. */
const RESUME_MAX_LIFETIME_SEC = 6 * 60 * 60;
/** How long to wait after a busy fleet or a failed wake before trying again. */
const WAKE_RETRY_MS = 2 * 60_000;
/** After this many failed wakes for a reason we cannot name, stop trying. */
const MAX_WAKE_FAILURES = 5;
/** Parked runs one sweep tick handles. The rest wait for the next tick. */
const BATCH = 20;

/** What a parked run carries on `metadata.awaitCi`. */
export interface AwaitCiState {
  /** The commit whose checks the run waits for. Full, or as short as the agent gave it. */
  headSha: string;
  /**
   * The PR row's head when the run parked. The row learns of the agent's own
   * push from a webhook, so for a while it still names the commit before it.
   * That commit is not somebody else's push.
   */
  prHeadAtPark?: string | null;
  parkedAt: string;
  /** New on every park, so a waker that read an old park cannot claim a new one. */
  wakeToken: string;
  /** The fleet task that emitted the sentinel. */
  fleetTaskId: string;
  deadlineAt: string;
  /** When each park happened, oldest first. */
  parks: string[];
  /** Set by the claim; cleared when the next prompt is on the box. */
  wakingAt?: string | null;
  /** A refused or failed wake: do not try again before this. */
  deferredUntil?: string | null;
  deferral?: { reason: string; message: string; retryAt: string | null } | null;
  wakeFailures?: number;
  lastWake?: { at: string; outcome: AwaitCiOutcome['kind'] } | null;
}

/** The park state on a task's metadata, or null when it has none. */
export function readAwaitCi(metadata: Record<string, unknown> | null | undefined): AwaitCiState | null {
  const raw = (metadata ?? {}).awaitCi as Partial<AwaitCiState> | undefined;
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.headSha !== 'string' || typeof raw.wakeToken !== 'string' || typeof raw.fleetTaskId !== 'string') {
    return null;
  }
  return {
    ...raw,
    headSha: raw.headSha,
    wakeToken: raw.wakeToken,
    fleetTaskId: raw.fleetTaskId,
    parkedAt: typeof raw.parkedAt === 'string' ? raw.parkedAt : new Date(0).toISOString(),
    deadlineAt: typeof raw.deadlineAt === 'string' ? raw.deadlineAt : new Date(0).toISOString(),
    parks: Array.isArray(raw.parks) ? raw.parks.filter((p): p is string => typeof p === 'string') : [],
  };
}

/** Same commit, when one side may be a short sha. */
export function sameCommit(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/** The PR a task works, with the two facts the park needs. */
async function prForTask(taskId: string): Promise<{ state: string; headSha: string | null } | null> {
  const rows = await getDbClient()
    .select({
      state: pullRequestsTable.state,
      headSha: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'headSha'`,
    })
    .from(tasksTable)
    .innerJoin(pullRequestsTable, eq(pullRequestsTable.id, tasksTable.pullRequestId))
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Park (called by the fleet poller)
// ---------------------------------------------------------------------------

export interface ParkInput {
  taskId: string;
  workspaceId: string;
  metadata: Record<string, unknown>;
  runId: string;
  client: Pick<FleetClient, 'suspendSandbox'>;
  /** The fleet task that just ended with the sentinel. */
  fleetTask: FleetSandboxTask;
  /** The sha from the sentinel, or null when it gave none we could read. */
  headSha: string | null;
}

/**
 * Suspend the box and mark the task `waiting_ci`. Returns false when the run
 * must not park (its PR is gone or not open, no commit to wait for, too many
 * parks, the box is gone, or the task moved on), and the caller finishes it
 * the usual way.
 */
export async function parkForCi(input: ParkInput): Promise<boolean> {
  const previous = readAwaitCi(input.metadata);
  const parks = previous?.parks ?? [];
  if (parks.length >= MAX_CI_PARKS) return false;

  const pr = await prForTask(input.taskId);
  if (!pr || pr.state !== 'open') return false;
  const headSha = input.headSha && pr.headSha && sameCommit(input.headSha, pr.headSha) && pr.headSha.length > input.headSha.length
    ? pr.headSha
    : (input.headSha ?? pr.headSha);
  if (!headSha) return false;

  let suspended = false;
  try {
    await input.client.suspendSandbox(input.runId);
    suspended = true;
  } catch (err) {
    // A box that is gone cannot be resumed. Anything else (a full disk, a
    // suspend the guest refused) leaves an idle box that the fleet's own idle
    // timeout suspends in three minutes, and the meter sweep closes its interval.
    if (err instanceof FleetRunNotFoundError) return false;
    console.warn(
      `[ci-park] suspending ${input.runId} failed; the idle timeout will suspend it:`,
      err instanceof Error ? err.message : err,
    );
  }

  const now = new Date();
  const state: AwaitCiState = {
    headSha,
    prHeadAtPark: pr.headSha,
    parkedAt: now.toISOString(),
    wakeToken: uuid(),
    fleetTaskId: input.fleetTask.taskId,
    deadlineAt: new Date(now.getTime() + CI_PARK_DEADLINE_MS).toISOString(),
    parks: [...parks, now.toISOString()],
    wakingAt: null,
    deferredUntil: null,
    deferral: null,
    wakeFailures: 0,
    lastWake: previous?.lastWake ?? null,
  };
  // The state first, then the status: the sweep reads only `waiting_ci` rows,
  // so it never sees a parked task without the state it needs to wake it.
  await patchTaskMetadata(input.taskId, (existing) => ({ ...existing, awaitCi: state }));
  const moved = await getDbClient()
    .update(tasksTable)
    .set({ status: 'waiting_ci', updatedAt: now })
    .where(and(eq(tasksTable.id, input.taskId), eq(tasksTable.status, 'in_progress')))
    .returning({ id: tasksTable.id });
  if (moved.length === 0) return true; // Stopped or settled meanwhile; that path owns the box.

  if (suspended) {
    await meterBoxClosed({ sandboxId: input.runId, reason: 'suspended', workspaceId: input.workspaceId });
  }
  recentlyParked.add(input.taskId);
  emitTaskStatus(input.workspaceId, input.taskId, 'waiting_ci');
  captureWorkspaceEvent(input.workspaceId, 'task_ci_parked', {
    task_id: input.taskId,
    park_count: state.parks.length,
    suspended,
  });
  console.log(`[ci-park] task ${input.taskId.slice(0, 8)} parked on ${headSha.slice(0, 12)} (park ${state.parks.length})`);
  return true;
}

// ---------------------------------------------------------------------------
// Reading CI
// ---------------------------------------------------------------------------

/**
 * What the checks on one commit say, or null while they have not settled.
 * Settled means at least one check and none pending or in progress. A failure
 * with others still running waits: the agent gets one complete answer.
 */
export function settledOutcome(facts: readonly CheckFact[]): AwaitCiOutcome | null {
  if (facts.length === 0) return null;
  if (facts.some((f) => f.state === 'pending' || f.state === 'in_progress')) return null;
  const verdict = deriveCiVerdict(facts);
  if (verdict.ciStatus === 'failing_required' || verdict.ciStatus === 'needs_human') {
    const checks = facts.filter((f) => f.state === 'failure' && f.required !== false).map((f) => f.name);
    return { kind: 'failing', checks: [...new Set(checks)].sort() };
  }
  return { kind: 'passing' };
}

// ---------------------------------------------------------------------------
// Wake
// ---------------------------------------------------------------------------

export type WakeResult = 'woken' | 'lost_claim' | 'deferred' | 'finished';

const WAKE_CLAIM_COLUMNS = {
  id: tasksTable.id,
  workspaceId: tasksTable.workspaceId,
  repositoryId: tasksTable.repositoryId,
  metadata: tasksTable.metadata,
} as const;

/**
 * Resume a parked run with what CI said. The CAS from `waiting_ci` with the
 * park's token is the one-winner claim: the `pr:checks` listener, the sweep,
 * and another replica can all try, and only one resumes the box.
 */
export async function wakeParkedTask(
  taskId: string,
  wakeToken: string,
  outcome: AwaitCiOutcome,
  deps: { clientFor?: (workspaceId: string) => Promise<FleetClient | null> } = {},
): Promise<WakeResult> {
  const now = new Date();
  const claimed = await getDbClient()
    .update(tasksTable)
    .set({
      status: 'in_progress',
      updatedAt: now,
      metadata: sql`jsonb_set(${tasksTable.metadata}, '{awaitCi,wakingAt}', to_jsonb(${now.toISOString()}::text))`,
    })
    .where(
      and(
        eq(tasksTable.id, taskId),
        eq(tasksTable.status, 'waiting_ci'),
        sql`${tasksTable.metadata} -> 'awaitCi' ->> 'wakeToken' = ${wakeToken}`,
      ),
    )
    .returning(WAKE_CLAIM_COLUMNS);
  const row = claimed[0];
  if (!row) return 'lost_claim';

  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const state = readAwaitCi(metadata);
  const cloud = readCloudTaskMeta({ metadata });
  const runId = cloud?.remoteTaskId;
  if (!state || !runId) {
    await finishParkedTask(taskId, row.workspaceId, null, 'in_progress', {
      status: 'completed',
      summary: RESUME_FAILED_SUMMARY,
    });
    return 'finished';
  }
  const extra = (cloud.extra ?? {}) as { host?: string; model?: string; sandboxSize?: unknown };
  const size: SandboxSize = isSandboxSize(extra.sandboxSize) ? extra.sandboxSize : 'standard';

  // The box gate, as unattended work: a refusal is a deferral, never a 402.
  // `checkBoxGate` rather than `withBoxGate`: the wake below is a long HTTP
  // call, and the lock path would hold a pool transaction across it. Losing a
  // race on Free costs one extra box.
  if (billingEnabled()) {
    const ownerId = await ownerOfWorkspace(row.workspaceId);
    if (ownerId) {
      try {
        const held = ownerBoxHold(ownerId);
        if (held) throw held;
        await checkBoxGate(ownerId, {
          size,
          unattended: true,
          existingBox: 'asleep',
          workspaceId: row.workspaceId,
          excludeTaskId: taskId,
        });
        releaseBoxHold(ownerId);
      } catch (err) {
        if (!isBoxGateError(err)) throw err;
        noteBoxRefusal(ownerId, err);
        const retryAt = deferralRetryAt(err) ?? new Date(Date.now() + 15 * 60_000);
        await deferWake(taskId, retryAt, { deferral: boxDeferral(err) });
        return 'deferred';
      }
    }
  }

  const clientFor = deps.clientFor ?? getSelfHostedClient;
  const client = await clientFor(row.workspaceId);
  if (!client) {
    await finishParkedTask(taskId, row.workspaceId, null, 'in_progress', {
      status: 'completed',
      summary: RESUME_FAILED_SUMMARY,
    });
    return 'finished';
  }

  try {
    const creds = extra.host ? await resolveRunCredentials(extra.host, runId) : null;
    await client.resumeSandbox(runId, {
      ...(creds?.ok ? { credentials: creds.credentials } : {}),
      maxLifetimeSec: RESUME_MAX_LIFETIME_SEC,
    });
  } catch (err) {
    return wakeFailed(err, { taskId, workspaceId: row.workspaceId, runId, client, state, awake: false });
  }
  await meterBoxOpened({
    workspaceId: row.workspaceId,
    subjectKind: 'task',
    subjectId: taskId,
    sandboxId: runId,
    size,
  });

  let next: FleetSandboxTask;
  try {
    const ref = await prRefForTask(taskId);
    next = await client.submitTask(runId, {
      prompt: buildAwaitCiResumePrompt({ ref: ref ?? 'this pull request', headSha: state.headSha, outcome }),
      taskType: 'pr_response',
      systemPrompt: row.repositoryId
        ? await withMemoryIndex(TASK_SYSTEM_PROMPT, { workspaceId: row.workspaceId, repositoryId: row.repositoryId })
        : TASK_SYSTEM_PROMPT,
      ...(extra.model ? { model: extra.model } : {}),
    });
  } catch (err) {
    return wakeFailed(err, { taskId, workspaceId: row.workspaceId, runId, client, state, awake: true });
  }

  const wokeAt = new Date().toISOString();
  await patchTaskMetadata(taskId, (existing) => {
    const prev = existing.cloudTask as CloudTaskMetadata | undefined;
    const current = readAwaitCi(existing) ?? state;
    return {
      ...existing,
      ...(prev
        ? { cloudTask: { ...prev, status: 'running', extra: { ...(prev.extra ?? {}), fleetTaskId: next.taskId } } }
        : {}),
      awaitCi: {
        ...current,
        wakingAt: null,
        deferredUntil: null,
        deferral: null,
        wakeFailures: 0,
        lastWake: { at: wokeAt, outcome: outcome.kind },
      },
    };
  });
  emitTaskStatus(row.workspaceId, taskId, 'in_progress');
  captureWorkspaceEvent(row.workspaceId, 'task_ci_woken', {
    task_id: taskId,
    outcome: outcome.kind,
    park_count: state.parks.length,
    parked_ms: Date.now() - Date.parse(state.parkedAt),
  });
  console.log(`[ci-park] task ${taskId.slice(0, 8)} resumed (${outcome.kind})`);
  return 'woken';
}

export const RESUME_FAILED_SUMMARY =
  'This run published, then paused for CI. The sandbox could not be resumed, so the run stops here. Start a new fix run if the PR still needs work.';

/** `owner/repo#n` for the resume prompt. */
async function prRefForTask(taskId: string): Promise<string | null> {
  const rows = await getDbClient()
    .select({ owner: pullRequestsTable.owner, repo: pullRequestsTable.repo, number: pullRequestsTable.number })
    .from(tasksTable)
    .innerJoin(pullRequestsTable, eq(pullRequestsTable.id, tasksTable.pullRequestId))
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  const pr = rows[0];
  return pr ? `${pr.owner}/${pr.repo}#${pr.number}` : null;
}

/** Whether a wake error means the box can never take the next prompt. */
export function isUnrecoverableWakeError(err: unknown): boolean {
  if (err instanceof FleetRunNotFoundError) return true; // 404, gone, hibernation_unusable
  if (err instanceof FleetTaskRefusedError) return err.code === 'tasks_unsupported';
  if (err instanceof FleetHttpError) return err.code === 'guest_too_old' || err.code === 'tasks_unsupported';
  return false;
}

async function wakeFailed(
  err: unknown,
  ctx: {
    taskId: string;
    workspaceId: string;
    runId: string;
    client: Pick<FleetClient, 'suspendSandbox' | 'deleteSandbox'>;
    state: AwaitCiState;
    awake: boolean;
  },
): Promise<WakeResult> {
  const message = err instanceof Error ? err.message : String(err);
  if (isUnrecoverableWakeError(err)) {
    console.warn(`[ci-park] task ${ctx.taskId.slice(0, 8)} cannot be resumed: ${message}`);
    await finishParkedTask(ctx.taskId, ctx.workspaceId, ctx.runId, 'in_progress', {
      status: 'completed',
      summary: RESUME_FAILED_SUMMARY,
    }, { client: ctx.client });
    return 'finished';
  }
  // The box woke but took no prompt: put it back to sleep rather than bill an
  // idle box until its idle timeout.
  if (ctx.awake) {
    try {
      await ctx.client.suspendSandbox(ctx.runId);
      await meterBoxClosed({ sandboxId: ctx.runId, reason: 'suspended', workspaceId: ctx.workspaceId });
    } catch (suspendErr) {
      console.warn(
        `[ci-park] re-suspending ${ctx.runId} failed:`,
        suspendErr instanceof Error ? suspendErr.message : suspendErr,
      );
    }
  }
  const named = err instanceof FleetCapacityError || err instanceof FleetThrottleError || err instanceof FleetTaskRefusedError;
  const failures = (ctx.state.wakeFailures ?? 0) + (named ? 0 : 1);
  if (failures >= MAX_WAKE_FAILURES) {
    console.warn(`[ci-park] task ${ctx.taskId.slice(0, 8)} failed to resume ${failures} times: ${message}`);
    await finishParkedTask(ctx.taskId, ctx.workspaceId, ctx.runId, 'in_progress', {
      status: 'completed',
      summary: RESUME_FAILED_SUMMARY,
    }, { client: ctx.client });
    return 'finished';
  }
  console.warn(`[ci-park] waking task ${ctx.taskId.slice(0, 8)} failed, retrying later: ${message}`);
  await deferWake(ctx.taskId, new Date(Date.now() + WAKE_RETRY_MS), { wakeFailures: failures });
  return 'deferred';
}

/** Back to `waiting_ci`, not to be tried again before `retryAt`. */
async function deferWake(
  taskId: string,
  retryAt: Date,
  extra: Partial<AwaitCiState>,
): Promise<void> {
  await patchTaskMetadata(taskId, (existing) => {
    const current = readAwaitCi(existing);
    if (!current) return existing;
    return {
      ...existing,
      awaitCi: { ...current, ...extra, wakingAt: null, deferredUntil: retryAt.toISOString() },
    };
  });
  await getDbClient()
    .update(tasksTable)
    .set({ status: 'waiting_ci', updatedAt: new Date() })
    .where(and(eq(tasksTable.id, taskId), eq(tasksTable.status, 'in_progress')));
}

/**
 * End a parked run without resuming it: its PR merged or closed, or the box
 * could not take the next prompt. The box goes too: a box nothing will
 * resume must not sit on the host's disk.
 */
export async function finishParkedTask(
  taskId: string,
  workspaceId: string,
  runId: string | null,
  from: Extract<TaskStatus, 'waiting_ci' | 'in_progress'>,
  outcome: { status: Extract<TaskStatus, 'completed' | 'cancelled'>; summary: string },
  deps: { client?: Pick<FleetClient, 'deleteSandbox'> | null } = {},
): Promise<boolean> {
  const now = new Date();
  const result: TaskResult = { success: outcome.status === 'completed', summary: outcome.summary };
  const moved = await getDbClient()
    .update(tasksTable)
    .set({
      status: outcome.status,
      result,
      completedAt: outcome.status === 'completed' ? now : null,
      updatedAt: now,
    })
    .where(and(eq(tasksTable.id, taskId), eq(tasksTable.status, from)))
    .returning({ id: tasksTable.id });
  if (moved.length === 0) return false;
  recentlyParked.delete(taskId);
  emitTaskStatus(workspaceId, taskId, outcome.status, result);

  const sandboxId = runId ?? (await runIdForTask(taskId));
  if (sandboxId) {
    try {
      const client = deps.client !== undefined ? deps.client : await getSelfHostedClient(workspaceId);
      await client?.deleteSandbox(sandboxId);
    } catch (err) {
      console.warn(`[ci-park] deleting ${sandboxId} failed:`, err instanceof Error ? err.message : err);
    }
    await meterBoxClosed({ sandboxId, reason: 'deleted', workspaceId });
  }
  return true;
}

async function runIdForTask(taskId: string): Promise<string | null> {
  const rows = await getDbClient()
    .select({ runId: sql<string | null>`${tasksTable.metadata} -> 'cloudTask' ->> 'remoteTaskId'` })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  return rows[0]?.runId ?? null;
}

// ---------------------------------------------------------------------------
// Triggers: the checks event and the sweep
// ---------------------------------------------------------------------------

/**
 * The PRs of parked tasks as of the last sweep tick, and the tasks this
 * process parked since. Together they let the `pr:checks` listener, which runs
 * on every check flush, return without a query while nothing is parked.
 */
let parkedPrIds = new Set<string>();
const recentlyParked = new Set<string>();

export interface ParkedRow {
  id: string;
  workspaceId: string;
  pullRequestId: string | null;
  awaitCi: unknown;
  remoteTaskId: string | null;
  prState: string | null;
  prHeadSha: string | null;
  owner: string | null;
  repo: string | null;
}

/** Every parked task with the PR facts the sweep decides on. No transcript, no full metadata. */
export function parkedTasksQuery(limit = 200) {
  return getDbClient()
    .select({
      id: tasksTable.id,
      workspaceId: tasksTable.workspaceId,
      pullRequestId: tasksTable.pullRequestId,
      awaitCi: sql<unknown>`${tasksTable.metadata} -> 'awaitCi'`,
      remoteTaskId: sql<string | null>`${tasksTable.metadata} -> 'cloudTask' ->> 'remoteTaskId'`,
      prState: pullRequestsTable.state,
      prHeadSha: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'headSha'`,
      owner: pullRequestsTable.owner,
      repo: pullRequestsTable.repo,
    })
    .from(tasksTable)
    .leftJoin(pullRequestsTable, eq(pullRequestsTable.id, tasksTable.pullRequestId))
    .where(eq(tasksTable.status, 'waiting_ci'))
    .limit(limit);
}

export type SweepDecision =
  | { kind: 'skip' }
  | { kind: 'finish'; status: 'completed' | 'cancelled'; summary: string }
  | { kind: 'wake'; outcome: AwaitCiOutcome }
  | { kind: 'check_ci'; repoFullName: string; headSha: string; timedOut: boolean };

/** What the sweep does with one parked task, before it reads the ledger. Pure. */
export function decideParked(row: ParkedRow, state: AwaitCiState | null, now = Date.now()): SweepDecision {
  if (!state) return { kind: 'finish', status: 'completed', summary: RESUME_FAILED_SUMMARY };
  if (row.prState === 'merged') {
    return { kind: 'finish', status: 'completed', summary: 'The PR merged while this run was paused for CI.' };
  }
  if (row.prState !== 'open') {
    return { kind: 'finish', status: 'cancelled', summary: 'The PR closed while this run was paused for CI.' };
  }
  if (state.deferredUntil && Date.parse(state.deferredUntil) > now) return { kind: 'skip' };
  const stale = Boolean(row.prHeadSha && state.prHeadAtPark && row.prHeadSha === state.prHeadAtPark);
  if (row.prHeadSha && !stale && !sameCommit(row.prHeadSha, state.headSha)) {
    return { kind: 'wake', outcome: { kind: 'head_moved', headSha: row.prHeadSha } };
  }
  const timedOut = Date.parse(state.deadlineAt) <= now;
  if (!row.owner || !row.repo) return timedOut ? { kind: 'wake', outcome: { kind: 'timed_out' } } : { kind: 'skip' };
  const headSha = row.prHeadSha && !stale && row.prHeadSha.length > state.headSha.length ? row.prHeadSha : state.headSha;
  // The ledger first, even past the deadline: a settled answer beats "go and look".
  return { kind: 'check_ci', repoFullName: `${row.owner}/${row.repo}`, headSha, timedOut };
}

/** One parked task, start to finish. Returns what happened. */
export async function handleParked(
  row: ParkedRow,
  deps: { readFacts?: typeof readLedgerFacts; clientFor?: (workspaceId: string) => Promise<FleetClient | null> } = {},
): Promise<WakeResult | 'skipped'> {
  const state = readAwaitCi({ awaitCi: row.awaitCi });
  const decision = decideParked(row, state);
  switch (decision.kind) {
    case 'skip':
      return 'skipped';
    case 'finish': {
      const client = deps.clientFor ? await deps.clientFor(row.workspaceId) : undefined;
      const done = await finishParkedTask(row.id, row.workspaceId, row.remoteTaskId, 'waiting_ci', decision, { client });
      return done ? 'finished' : 'lost_claim';
    }
    case 'wake':
      return wakeParkedTask(row.id, state!.wakeToken, decision.outcome, deps);
    case 'check_ci': {
      const facts = await (deps.readFacts ?? readLedgerFacts)(decision.repoFullName, decision.headSha);
      const outcome = settledOutcome(facts) ?? (decision.timedOut ? { kind: 'timed_out' as const } : null);
      if (!outcome) return 'skipped';
      return wakeParkedTask(row.id, state!.wakeToken, outcome, deps);
    }
  }
}

/** The `pr:checks` listener: a flush for a parked PR's head may be the one CI settled on. */
export async function onPrChecks(
  evt: DomainPrChecksEvent,
  deps: { readFacts?: typeof readLedgerFacts; clientFor?: (workspaceId: string) => Promise<FleetClient | null> } = {},
): Promise<number> {
  if (parkedPrIds.size === 0 && recentlyParked.size === 0) return 0;
  const prIds = new Set(evt.prs.map((p) => p.prId));
  if (recentlyParked.size === 0 && ![...prIds].some((id) => parkedPrIds.has(id))) return 0;
  const rows = (await parkedTasksQuery()).filter((r) => r.pullRequestId && prIds.has(r.pullRequestId));
  let woken = 0;
  for (const row of rows) {
    const state = readAwaitCi({ awaitCi: row.awaitCi });
    if (!state || !sameCommit(state.headSha, evt.headSha)) continue;
    if (state.deferredUntil && Date.parse(state.deferredUntil) > Date.now()) continue;
    const facts = await (deps.readFacts ?? readLedgerFacts)(evt.repoFullName, evt.headSha);
    const outcome = settledOutcome(facts);
    if (!outcome) continue;
    if ((await wakeParkedTask(row.id, state.wakeToken, outcome, deps)) === 'woken') woken += 1;
  }
  return woken;
}

/** Tests: forget what this process knows about parked tasks. */
export function resetCiParkForTests(): void {
  recentlyParked.clear();
  parkedPrIds = new Set();
}

class CiParkSweep {
  private timer: NodeJS.Timeout | null = null;
  private guard = new TickGuard('ci_park_sweep', 15 * 60_000);
  private subscribed = false;

  init(): void {
    if (!this.subscribed) {
      this.subscribed = true;
      domainEvents.on('pr:checks', (evt) => {
        runWithoutScope(() => {
          void onPrChecks(evt).catch((err) => {
            console.warn(`[ci-park] checks listener failed for ${evt.repoFullName}:`, err instanceof Error ? err.message : err);
          });
        });
      });
    }
    if (this.timer) return;
    debugBus.registerPoller(
      'ci_park_sweep',
      SWEEP_INTERVAL_MS,
      'Wakes fleet fix runs paused for CI (ci-park): when the head moves, the wait times out, a deferred wake is due, or a checks event was missed. Finishes runs whose PR merged or closed.',
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(deps: Parameters<typeof handleParked>[1] = {}): Promise<number> {
    if (!this.guard.tryBegin()) return 0;
    const startedAt = Date.now();
    let handled = 0;
    try {
      // Every replica refreshes its own hint; only one drains.
      const rows = await runWithoutScope(() => parkedTasksQuery());
      parkedPrIds = new Set(rows.map((r) => r.pullRequestId).filter((id): id is string => Boolean(id)));
      recentlyParked.clear();
      if (rows.length > 0) {
        const outcome = await guardCrossReplica(
          'ci_park_sweep:tick',
          async () => {
            let n = 0;
            for (const row of rows.slice(0, BATCH)) {
              try {
                const result = await handleParked(row, deps);
                if (result !== 'skipped' && result !== 'lost_claim') n += 1;
              } catch (err) {
                console.warn(`[ci-park] sweep failed for task ${row.id.slice(0, 8)}:`, err instanceof Error ? err.message : err);
              }
            }
            return n;
          },
          { maxHoldMs: this.guard.maxMs },
        );
        handled = outcome.acquired ? (outcome.result ?? 0) : 0;
      }
      debugBus.pollerTick('ci_park_sweep', { durationMs: Date.now() - startedAt, ok: true });
    } catch (err) {
      debugBus.pollerTick('ci_park_sweep', { durationMs: Date.now() - startedAt, ok: false, error: err });
    } finally {
      this.guard.end();
    }
    return handled;
  }
}

export const ciParkSweep = new CiParkSweep();
