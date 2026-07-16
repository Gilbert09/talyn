// Merge queue v2 — the action executor.
//
// Runs the decide → execute rounds for ONE entry. `decide` (pure) names the
// actions; this module performs them: CAS transitions with audit events,
// GitHub calls (merge / verify / re-run / signature probe), cloud fix-run
// dispatch, WS mirroring. Outcome-producing actions feed their result back
// into the context and re-invoke `decide`, bounded by MAX_DECIDE_ROUNDS.
//
// Concurrency contract: every persisted change is a CAS on entry.version. A
// lost CAS means another evaluation (other replica, newer trigger) got there
// first — this one drops its remaining actions and walks away. Nothing here
// may write state unconditionally except record_merged (GitHub having merged
// is ground truth that must never be lost to a version race).

import { eq } from 'drizzle-orm';
import { buildMergeablePrompt, type PRMergeableSummary } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import {
  mergeQueueEntries,
  mergeQueueEvents,
  pullRequests as pullRequestsTable,
} from '../../db/schema.js';
import { githubService, MergeNotPermittedForAppError } from '../github.js';
import { fetchUnsignedCommitCount } from '../githubGraphql.js';
import { githubRateGate } from '../githubRateGate.js';
import { graphqlBudget } from '../graphqlBudget.js';
import { requiresSignedCommits, markSigningRequired } from '../repoSigning.js';
import { prMonitorService } from '../prMonitor.js';
import { createCloudTask } from '../taskCreate.js';
import { TaskLimitError } from '../billing/entitlements.js';
import { ACTIVE_STATUSES, linkedTaskStatus, resolveCloudEnv } from '../prCloudFix.js';
import { emitPullRequestUpdated, emitMergeQueueBlocked } from '../websocket.js';
import { broadcastMergeQueuePositions, QUEUE_RESET_COLUMNS } from '../mergeQueueBroadcast.js';
import { debugBus } from '../debugBus.js';
import { decide } from './decide.js';
import { toLegacyPublicState, toLegacyStateBlob, toPublicMergeQueue } from './legacy.js';
import { casTransition, rowToEntrySnapshot, type EntryRow } from './store.js';
import {
  MAX_ATTEMPTS,
  MAX_DECIDE_ROUNDS,
  type Action,
  type DecisionContext,
  type EntrySnapshot,
  type MergeOutcome,
  type PrSnapshot,
  type RerunOutcome,
} from './types.js';

// Only the pull_requests columns an evaluation touches (egress rules — never
// the cursor columns, never autoMergeState).
export const PR_EVAL_COLUMNS = {
  id: pullRequestsTable.id,
  workspaceId: pullRequestsTable.workspaceId,
  repositoryId: pullRequestsTable.repositoryId,
  taskId: pullRequestsTable.taskId,
  owner: pullRequestsTable.owner,
  repo: pullRequestsTable.repo,
  number: pullRequestsTable.number,
  state: pullRequestsTable.state,
  mergeQueued: pullRequestsTable.mergeQueued,
  lastSummary: pullRequestsTable.lastSummary,
} as const;

export type PrEvalRow = Pick<typeof pullRequestsTable.$inferSelect, keyof typeof PR_EVAL_COLUMNS>;

export interface EvaluateEntryInput {
  entry: EntryRow;
  pr: PrEvalRow;
  position: number;
  isHead: boolean;
  groupMergeInFlight: boolean;
  trigger: string;
}

export interface EvaluateEntryResult {
  verdict: 'hold' | 'advance';
  /** Another writer won a CAS race — the group should re-schedule. */
  casLost?: boolean;
}

export function buildPrSnapshot(pr: PrEvalRow): PrSnapshot {
  const summary = (pr.lastSummary ?? {}) as PRMergeableSummary & {
    headSha?: string;
    mergeStateStatus?: string;
    autoMergeEnabledBy?: 'talyn' | 'user' | null;
  };
  return {
    state: pr.state as PrSnapshot['state'],
    headSha: summary.headSha ?? '',
    mergeStateStatus: summary.mergeStateStatus ?? 'UNKNOWN',
    autoMergeEnabledBy: summary.autoMergeEnabledBy ?? null,
    summary: {
      url: summary.url ?? '',
      headBranch: summary.headBranch ?? '',
      baseBranch: summary.baseBranch ?? '',
      mergeable: summary.mergeable ?? 'UNKNOWN',
      reviewDecision: summary.reviewDecision ?? null,
      blockingReason: summary.blockingReason ?? 'unknown',
      checks: summary.checks ?? { total: 0, failed: 0, inProgress: 0 },
      unresolvedReviewThreads: summary.unresolvedReviewThreads ?? 0,
      draft: summary.draft,
    },
  };
}

async function buildBaseContext(
  entry: EntrySnapshot,
  pr: PrEvalRow,
  input: EvaluateEntryInput
): Promise<DecisionContext> {
  const accountKey = githubService.accountKeyFor(pr.workspaceId);
  const [ourFix, otherFix, signingRequired, cloudEnv] = await Promise.all([
    entry.fixTaskId ? linkedTaskStatus(entry.fixTaskId) : Promise.resolve(null),
    pr.taskId && pr.taskId !== entry.fixTaskId
      ? linkedTaskStatus(pr.taskId)
      : Promise.resolve(null),
    // Cached (1h) branch-protection probe; a probe failure reads as null and
    // decide proceeds — the merge's 403 safety net catches a real requirement.
    requiresSignedCommits(pr.workspaceId, pr.owner, pr.repo, entry.baseBranch).catch(() => null),
    resolveCloudEnv(pr.workspaceId),
  ]);
  return {
    nowIso: new Date().toISOString(),
    isHead: input.isHead,
    groupMergeInFlight: input.groupMergeInFlight,
    fixTaskState:
      ourFix === null ? 'none' : ACTIVE_STATUSES.has(ourFix) ? 'active' : 'terminal',
    otherLinkedTaskActive: otherFix !== null && ACTIVE_STATUSES.has(otherFix),
    signingRequired,
    autoMergeCapability: 'unavailable', // Push E wires the repo probe here
    updateBranchAvailable: false, // Push E adds githubService.updateBranch
    cloudEnvAvailable: cloudEnv !== null,
    restGateBlocked: githubRateGate.isBlocked(accountKey, 'rest'),
    graphqlGateBlocked: githubRateGate.isBlocked(accountKey, 'graphql'),
    graphqlBudgetLow: graphqlBudget.shouldDefer(accountKey),
    maxAttempts: MAX_ATTEMPTS,
  };
}

/**
 * Evaluate one entry to a settled verdict: run decide, perform its actions,
 * feed outcomes back, repeat. Never throws — a failure logs, ends the entry's
 * turn, and the reconciler retries.
 */
export async function evaluateEntry(input: EvaluateEntryInput): Promise<EvaluateEntryResult> {
  const { pr, position, trigger } = input;
  let entry = rowToEntrySnapshot(input.entry);
  let version = input.entry.version;
  const prSnap = buildPrSnapshot(pr);
  const base = await buildBaseContext(entry, pr, input);
  const extras: Partial<DecisionContext> = {};

  for (let round = 0; round < MAX_DECIDE_ROUNDS; round++) {
    const decision = decide(entry, prSnap, { ...base, ...extras });
    let redecide = false;

    for (const action of decision.actions) {
      const applied = await performAction(action, {
        entry,
        version,
        pr,
        prSnap,
        position,
        trigger,
        extras,
      });
      if (applied.casLost) return { verdict: 'advance', casLost: true };
      if (applied.abort) return { verdict: applied.abort };
      if (applied.entry) entry = applied.entry;
      if (applied.versionDelta) version += applied.versionDelta;
      if (applied.redecide) {
        redecide = true;
        break; // decide must see the outcome before any later action runs
      }
    }
    if (!redecide) return { verdict: decision.verdict };
  }
  console.warn(
    `[mergeQueueV2] decide/execute round overflow for entry ${entry.id} — advancing`
  );
  return { verdict: 'advance' };
}

interface ActionContext {
  entry: EntrySnapshot;
  version: number;
  pr: PrEvalRow;
  prSnap: PrSnapshot;
  position: number;
  trigger: string;
  extras: Partial<DecisionContext>;
}

interface ActionOutcome {
  entry?: EntrySnapshot;
  versionDelta?: number;
  redecide?: boolean;
  casLost?: boolean;
  /** Stop the evaluation with this verdict (live pre-merge check failed). */
  abort?: 'hold' | 'advance';
}

async function performAction(action: Action, ctx: ActionContext): Promise<ActionOutcome> {
  switch (action.kind) {
    case 'transition':
      return applyTransition(action, ctx);
    case 'reset_budgets':
      return applyBudgetReset(action, ctx);
    case 'verify_merged': {
      ctx.extras.verifiedMerged = await verifyMerged(ctx.pr);
      return { redecide: true };
    }
    case 'probe_signatures':
      return probeSignatures(ctx);
    case 'verify_live_then_merge':
      return verifyLiveThenMerge(ctx);
    case 'rerequest_failed_checks': {
      ctx.extras.rerunOutcome = await rerequestFailedChecks(ctx.pr);
      return { redecide: true };
    }
    case 'update_branch': {
      // Push E adds the REST method; decide never emits this while
      // ctx.updateBranchAvailable is false, so this is a safety stub.
      ctx.extras.updateBranchOutcome = 'error';
      return { redecide: true };
    }
    case 'fire_fix_run':
      return fireFixRun(action.resign, ctx);
    case 'record_merged': {
      await recordMerged(ctx.entry, ctx.pr);
      return {};
    }
    case 'refresh_snapshot': {
      await prMonitorService
        .refreshPr(ctx.pr.workspaceId, ctx.pr.owner, ctx.pr.repo, ctx.pr.number)
        .catch((err) => {
          console.warn(
            `[mergeQueueV2] snapshot refresh failed for ${ctx.pr.owner}/${ctx.pr.repo}#${ctx.pr.number}:`,
            err instanceof Error ? err.message : err
          );
        });
      return {};
    }
    case 'notify_blocked': {
      notifyBlocked(ctx.entry, ctx.pr);
      return {};
    }
    case 'mark_signing_required': {
      markSigningRequired(ctx.pr.workspaceId, ctx.pr.owner, ctx.pr.repo, ctx.entry.baseBranch);
      return {};
    }
    case 'arm_automerge':
    case 'disarm_automerge': {
      // Unreachable until Push E sets autoMergeCapability to 'available'.
      console.warn(`[mergeQueueV2] ${action.kind} requested before auto-merge shipped — ignoring`);
      return {};
    }
  }
}

async function applyTransition(
  action: Extract<Action, { kind: 'transition' }>,
  ctx: ActionContext
): Promise<ActionOutcome> {
  const next: EntrySnapshot = {
    ...ctx.entry,
    status: action.to,
    blockedCode: action.blockedCode ?? null,
    blockedReason: action.blockedReason ?? null,
    ...(action.set?.fixAttempts !== undefined ? { fixAttempts: action.set.fixAttempts } : {}),
    ...(action.set?.rerunAttempts !== undefined ? { rerunAttempts: action.set.rerunAttempts } : {}),
    ...(action.set?.resignAttempts !== undefined
      ? { resignAttempts: action.set.resignAttempts }
      : {}),
    ...(action.set?.fixTaskAccounted !== undefined
      ? { fixTaskAccounted: action.set.fixTaskAccounted }
      : {}),
    ...(action.set?.signingCheckedSha !== undefined
      ? { signingCheckedSha: action.set.signingCheckedSha }
      : {}),
    ...(action.set?.unsignedCount !== undefined ? { unsignedCount: action.set.unsignedCount } : {}),
  };
  const ok = await casTransition(
    ctx.entry.id,
    ctx.version,
    {
      status: action.to,
      blockedCode: next.blockedCode,
      blockedReason: next.blockedReason,
      ...(action.set?.fixAttempts !== undefined ? { fixAttempts: action.set.fixAttempts } : {}),
      ...(action.set?.rerunAttempts !== undefined
        ? { rerunAttempts: action.set.rerunAttempts }
        : {}),
      ...(action.set?.resignAttempts !== undefined
        ? { resignAttempts: action.set.resignAttempts }
        : {}),
      ...(action.set?.fixTaskAccounted !== undefined
        ? { fixTaskAccounted: action.set.fixTaskAccounted }
        : {}),
      ...(action.set?.signingCheckedSha !== undefined
        ? { signingCheckedSha: action.set.signingCheckedSha }
        : {}),
      ...(action.set?.unsignedCount !== undefined
        ? { unsignedCount: action.set.unsignedCount }
        : {}),
      ...(action.set?.lastError !== undefined ? { lastError: action.set.lastError } : {}),
      ...(action.set?.lastErrorAt !== undefined
        ? { lastErrorAt: new Date(action.set.lastErrorAt) }
        : {}),
      ...(action.to === 'merging' ? { mergeStartedAt: new Date() } : {}),
      lastEvaluatedAt: new Date(),
    },
    {
      trigger: ctx.trigger,
      fromStatus: ctx.entry.status,
      toStatus: action.to,
      code: action.event.code,
      message: action.event.message,
      detail: action.event.detail,
    }
  );
  if (!ok) return { casLost: true };
  debugBus.recordEvent({
    service: 'merge_queue',
    action: `${ctx.entry.status}->${action.to}`,
    summary: `${ctx.pr.owner}/${ctx.pr.repo}#${ctx.pr.number}: ${action.event.message}`,
    workspaceId: ctx.pr.workspaceId,
    meta: { entryId: ctx.entry.id, code: action.event.code, headSha: ctx.entry.headSha },
  });
  await mirrorToPrRow(next, ctx.pr, ctx.position);
  return { entry: next, versionDelta: 1 };
}

async function applyBudgetReset(
  action: Extract<Action, { kind: 'reset_budgets' }>,
  ctx: ActionContext
): Promise<ActionOutcome> {
  const wasBlocked = ctx.entry.status === 'blocked';
  const next: EntrySnapshot = {
    ...ctx.entry,
    headSha: action.newHeadSha,
    fixAttempts: 0,
    rerunAttempts: 0,
    resignAttempts: 0,
    signingCheckedSha: null,
    unsignedCount: null,
    ...(wasBlocked ? { status: 'queued' as const, blockedCode: null, blockedReason: null } : {}),
  };
  const ok = await casTransition(
    ctx.entry.id,
    ctx.version,
    {
      headSha: action.newHeadSha,
      fixAttempts: 0,
      rerunAttempts: 0,
      resignAttempts: 0,
      signingCheckedSha: null,
      unsignedCount: null,
      ...(wasBlocked ? { status: 'queued' as const, blockedCode: null, blockedReason: null } : {}),
      lastEvaluatedAt: new Date(),
    },
    {
      trigger: ctx.trigger,
      fromStatus: ctx.entry.status,
      toStatus: next.status,
      code: action.event.code,
      message: action.event.message,
      detail: action.event.detail,
    }
  );
  if (!ok) return { casLost: true };
  await mirrorToPrRow(next, ctx.pr, ctx.position);
  return { entry: next, versionDelta: 1 };
}

async function probeSignatures(ctx: ActionContext): Promise<ActionOutcome> {
  let count = 0;
  try {
    count = await fetchUnsignedCommitCount({
      workspaceId: ctx.pr.workspaceId,
      owner: ctx.pr.owner,
      repo: ctx.pr.repo,
      number: ctx.pr.number,
    });
  } catch (err) {
    // Our own check failed — don't block the merge on it; proceed as signed
    // (v1 semantics: the 403 safety net catches a real refusal).
    console.warn(
      `[mergeQueueV2] signature check failed for ${ctx.pr.owner}/${ctx.pr.repo}#${ctx.pr.number}:`,
      err instanceof Error ? err.message : err
    );
  }
  ctx.extras.unsignedCount = count;
  // Memoize per head — the probe runs at most once per (entry, head).
  const ok = await casTransition(
    ctx.entry.id,
    ctx.version,
    { signingCheckedSha: ctx.prSnap.headSha, unsignedCount: count },
    null
  );
  if (!ok) return { casLost: true };
  return {
    entry: { ...ctx.entry, signingCheckedSha: ctx.prSnap.headSha, unsignedCount: count },
    versionDelta: 1,
    redecide: true,
  };
}

async function verifyLiveThenMerge(ctx: ActionContext): Promise<ActionOutcome> {
  const db = getDbClient();
  // Last-moment live re-check: an evaluation resumed after a stall can be
  // acting on a snapshot from minutes ago, after the PR merged or the user
  // dequeued it. Never merge off a stale snapshot.
  const current = await db
    .select({ state: pullRequestsTable.state, mergeQueued: pullRequestsTable.mergeQueued })
    .from(pullRequestsTable)
    .where(eq(pullRequestsTable.id, ctx.pr.id))
    .limit(1);
  if (!current[0] || current[0].state !== 'open' || !current[0].mergeQueued) {
    return { abort: 'hold' };
  }
  // Persist 'merging' BEFORE the call — the crash marker verify-merged keys on.
  const transition = await applyTransition(
    {
      kind: 'transition',
      to: 'merging',
      blockedCode: null,
      blockedReason: null,
      event: { code: 'merge_attempt', message: 'Attempting the merge.' },
    },
    ctx
  );
  if (transition.casLost) return transition;
  const entry = transition.entry!;

  let outcome: MergeOutcome;
  try {
    const result = await githubService.mergePullRequest(
      ctx.pr.workspaceId,
      ctx.pr.owner,
      ctx.pr.repo,
      ctx.pr.number,
      { merge_method: entry.mergeMethod }
    );
    outcome = result.merged
      ? { kind: 'merged' }
      : { kind: 'not_merged', message: result.message || 'GitHub did not merge the pull request' };
  } catch (err) {
    outcome =
      err instanceof MergeNotPermittedForAppError
        ? { kind: 'refused_app', message: err.message }
        : { kind: 'error', message: err instanceof Error ? err.message : 'Merge failed' };
  }
  ctx.extras.mergeOutcome = outcome;
  // The merging transition consumed one CAS version; the merge itself writes
  // no entry state (the aftermath rules do, next round).
  return { entry, versionDelta: 1, redecide: true };
}

async function rerequestFailedChecks(pr: PrEvalRow): Promise<RerunOutcome> {
  try {
    return await githubService.rerequestFailedCheckRuns(
      pr.workspaceId,
      pr.owner,
      pr.repo,
      pr.number
    );
  } catch (err) {
    console.warn(
      `[mergeQueueV2] failed-check rerun for ${pr.owner}/${pr.repo}#${pr.number} errored:`,
      err instanceof Error ? err.message : err
    );
    return { errored: true };
  }
}

async function fireFixRun(resign: boolean, ctx: ActionContext): Promise<ActionOutcome> {
  const resolved = await resolveCloudEnv(ctx.pr.workspaceId);
  if (!resolved) {
    // decide gates on cloudEnvAvailable, but the env can disconnect between
    // context build and dispatch — hold as queued, burn nothing.
    return ensureQueuedDeferred(ctx, 'no_cloud_env', 'No connected cloud provider — deferring.');
  }
  const ref = `${ctx.pr.owner}/${ctx.pr.repo}#${ctx.pr.number}`;
  const summary = ctx.prSnap.summary;
  const prTitle = (ctx.pr.lastSummary as { title?: string } | null)?.title ?? '';
  let created: { id: string };
  try {
    created = await createCloudTask({
      workspaceId: ctx.pr.workspaceId,
      type: 'pr_response',
      title: `Get ${ref} mergeable (merge queue)`,
      description: resign
        ? `Merge queue: re-sign ${ref} ("${prTitle}") — the base requires signed commits — and take it to a clean, mergeable state.`
        : `Merge queue: take ${ref} ("${prTitle}") to a clean, mergeable, up-to-date state.`,
      prompt: buildMergeablePrompt({
        owner: ctx.pr.owner,
        repo: ctx.pr.repo,
        number: ctx.pr.number,
        summary,
        provider: resolved.provider,
        resignCommits: resign,
      }),
      repositoryId: ctx.pr.repositoryId,
      assignedEnvironmentId: resolved.envId,
      pullRequestId: ctx.pr.id,
    });
  } catch (err) {
    if (err instanceof TaskLimitError) {
      // Free-plan concurrency limit — transient; a slot frees when a task
      // ends (the task:status trigger re-evaluates). Burn NOTHING.
      return ensureQueuedDeferred(
        ctx,
        'deferred_task_limit',
        'Fix run deferred — free-plan task slots are full.'
      );
    }
    throw err;
  }
  const next: EntrySnapshot = {
    ...ctx.entry,
    status: 'fixing',
    blockedCode: null,
    blockedReason: null,
    fixTaskId: created.id,
    fixTaskAccounted: false,
    fixKind: resign ? 'resign' : 'blockers',
    ...(resign ? { resignAttempts: ctx.entry.resignAttempts + 1 } : {}),
  };
  const ok = await casTransition(
    ctx.entry.id,
    ctx.version,
    {
      status: 'fixing',
      blockedCode: null,
      blockedReason: null,
      fixTaskId: created.id,
      fixTaskAccounted: false,
      fixKind: resign ? 'resign' : 'blockers',
      ...(resign ? { resignAttempts: ctx.entry.resignAttempts + 1 } : {}),
      lastEvaluatedAt: new Date(),
    },
    {
      trigger: ctx.trigger,
      fromStatus: ctx.entry.status,
      toStatus: 'fixing',
      code: resign ? 'resign_run_fired' : 'fix_run_fired',
      message: resign
        ? `Re-sign run dispatched (attempt ${ctx.entry.resignAttempts + 1}/${MAX_ATTEMPTS}).`
        : 'Cloud fix run dispatched.',
      detail: { taskId: created.id },
    }
  );
  if (!ok) return { casLost: true };
  await mirrorToPrRow(next, ctx.pr, ctx.position);
  return { entry: next, versionDelta: 1 };
}

async function ensureQueuedDeferred(
  ctx: ActionContext,
  code: string,
  message: string
): Promise<ActionOutcome> {
  if (ctx.entry.status === 'queued') return {};
  return applyTransition(
    {
      kind: 'transition',
      to: 'queued',
      blockedCode: null,
      blockedReason: null,
      event: { code, message },
    },
    ctx
  );
}

/**
 * Ask GitHub (REST — `merged_at` is the canonical signal) whether the PR is
 * in fact merged. Best-effort: any failure reads as "not merged".
 */
async function verifyMerged(pr: PrEvalRow): Promise<boolean> {
  try {
    const live = await githubService.getPullRequest(pr.workspaceId, pr.owner, pr.repo, pr.number);
    return Boolean(live.merged_at || live.merged);
  } catch {
    return false;
  }
}

/**
 * The single success path: entry → merged (unconditional — GitHub having
 * merged is ground truth no version race may discard), PR row terminal,
 * queue mirror cleared, positions rebroadcast.
 */
async function recordMerged(entry: EntrySnapshot, pr: PrEvalRow): Promise<void> {
  const db = getDbClient();
  await db
    .update(pullRequestsTable)
    .set({ state: 'merged', mergedAt: new Date(), ...QUEUE_RESET_COLUMNS, updatedAt: new Date() })
    .where(eq(pullRequestsTable.id, pr.id));
  await db
    .update(mergeQueueEntries)
    .set({ status: 'merged', updatedAt: new Date() })
    .where(eq(mergeQueueEntries.id, entry.id));
  await db.insert(mergeQueueEvents).values({
    entryId: entry.id,
    fromStatus: entry.status,
    toStatus: 'merged',
    trigger: 'executor',
    code: 'merged',
    message: 'Merged.',
  });
  debugBus.recordEvent({
    service: 'merge_queue',
    action: 'merged',
    summary: `${pr.owner}/${pr.repo}#${pr.number} merged`,
    workspaceId: pr.workspaceId,
    meta: { entryId: entry.id },
  });
  emitPullRequestUpdated(pr.workspaceId, {
    id: pr.id,
    taskId: pr.taskId,
    repositoryId: pr.repositoryId,
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    state: 'merged',
    lastSummary: pr.lastSummary as Record<string, unknown>,
    mergeQueued: false,
    mergeQueueState: null,
    mergeQueue: null,
  });
  await broadcastMergeQueuePositions(pr.workspaceId);
}

function notifyBlocked(entry: EntrySnapshot, pr: PrEvalRow): void {
  const summary = pr.lastSummary as { title?: string; url?: string } | null;
  emitMergeQueueBlocked(pr.workspaceId, {
    pullRequestId: pr.id,
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    title: summary?.title ?? '',
    url: summary?.url ?? '',
    reason: entry.blockedReason ?? 'needs attention',
    attempts: entry.fixAttempts,
  });
}

/**
 * Mirror the entry into the legacy blob + emit the WS badge (legacy shape and
 * the v2 payload side by side). Keeps every desktop build live during the
 * rollout; deleted with the blob columns at cleanup.
 */
async function mirrorToPrRow(entry: EntrySnapshot, pr: PrEvalRow, position: number): Promise<void> {
  const db = getDbClient();
  const terminal = entry.status === 'merged' || entry.status === 'removed';
  await db
    .update(pullRequestsTable)
    .set(
      terminal
        ? { ...QUEUE_RESET_COLUMNS, updatedAt: new Date() }
        : { mergeQueueState: toLegacyStateBlob(entry), updatedAt: new Date() }
    )
    .where(eq(pullRequestsTable.id, pr.id));
  emitPullRequestUpdated(pr.workspaceId, {
    id: pr.id,
    taskId: pr.taskId,
    repositoryId: pr.repositoryId,
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    state: pr.state,
    lastSummary: pr.lastSummary as Record<string, unknown>,
    mergeQueued: !terminal,
    mergeQueueState: terminal ? null : toLegacyPublicState(entry, position),
    mergeQueue: terminal ? null : toPublicMergeQueue(entry, position),
  });
}
