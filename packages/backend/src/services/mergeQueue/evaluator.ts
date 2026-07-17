// Merge queue v2 — the group evaluator.
//
// Evaluation is per-(repo, base) GROUP, triggered by events (fresh snapshot,
// check flush, task terminal, membership change) and by the reconciler. There
// is NO global tick and NO global lock: distinct groups evaluate fully in
// parallel, a hung evaluation stalls only its own group (45s timeout + CAS
// guards), and cross-replica safety is a per-group advisory lock.
//
// The walk itself carries v1's hard-won semantics verbatim: FIFO from the
// head, `hold` consumes the group's turn (one same-base merge in flight),
// `advance` skips past entries that can't make progress so a blocked head
// never gates the PRs behind it.

import { inArray } from 'drizzle-orm';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { pullRequests as pullRequestsTable } from '../../db/schema.js';
import { guardCrossReplica } from '../advisoryLock.js';
import { githubService } from '../github.js';
import { githubRateGate } from '../githubRateGate.js';
import { debugBus } from '../debugBus.js';
import {
  closeActiveEntry,
  computeEntryPositions,
  getMergeQueueEngine,
  getMergeQueueMode,
  loadActiveGroup,
  touchEvaluated,
} from './store.js';
import { evaluateEntry, PR_EVAL_COLUMNS, type PrEvalRow } from './executor.js';

/** Hard bound on one group evaluation — a hung GitHub call must not hold the
 *  group's coalescing slot (or its advisory lock) for minutes. Abandoned work
 *  is harmless: every write is CAS-guarded and the reconciler retries. */
export const GROUP_EVALUATION_TIMEOUT_MS = 45_000;

interface GroupState {
  running: boolean;
  /** A trigger arrived mid-evaluation — run once more when this one ends. */
  dirty: boolean;
  triggers: Set<string>;
}

const groups = new Map<string, GroupState>();

/** Engine flag cache — triggers fire on every PR refresh, so don't pay a
 *  settings read per event. 5s TTL keeps cutover latency negligible. */
let engineCache: { value: 'v1' | 'v2'; at: number } | null = null;
const ENGINE_CACHE_MS = 5_000;

export async function mergeQueueV2Active(): Promise<boolean> {
  const now = Date.now();
  if (engineCache && now - engineCache.at < ENGINE_CACHE_MS) return engineCache.value === 'v2';
  try {
    const value = await getMergeQueueEngine();
    engineCache = { value, at: now };
    return value === 'v2';
  } catch {
    return false; // no DB yet (boot) — treat as dormant
  }
}

/** Test hook — drop the engine cache so a flag flip is seen immediately. */
export function _resetEngineCache(): void {
  engineCache = null;
}

/**
 * Schedule an evaluation of one (repo, base) group. Coalescing: triggers for
 * a running group mark it dirty and it re-runs once at the end — a CI burst
 * of 30 check webhooks costs one extra evaluation, not 30.
 */
export function scheduleGroupEvaluation(
  repositoryId: string,
  baseBranch: string,
  trigger: string
): void {
  const key = `${repositoryId}|${baseBranch}`;
  const state = groups.get(key);
  if (state?.running) {
    state.dirty = true;
    state.triggers.add(trigger);
    return;
  }
  const fresh: GroupState = { running: true, dirty: false, triggers: new Set([trigger]) };
  groups.set(key, fresh);
  // ESCAPE THE OWNER SCOPE. A schedule call from a request handler would
  // otherwise propagate the request's scoped TRANSACTION handle (via
  // AsyncLocalStorage) into this detached evaluation — and by the time it
  // runs, that transaction has committed, so every query on it hangs until
  // the 45s timeout or dies with 25P02. The pipeline always runs on the pool.
  runWithoutScope(() => void runGroupLoop(key, repositoryId, baseBranch, fresh));
}

async function runGroupLoop(
  key: string,
  repositoryId: string,
  baseBranch: string,
  state: GroupState
): Promise<void> {
  try {
    // Loop while triggers keep arriving; each pass is one evaluation.
    do {
      state.dirty = false;
      const trigger = [...state.triggers].join('+') || 'unknown';
      state.triggers.clear();
      await evaluateGroupOnce(repositoryId, baseBranch, trigger);
    } while (state.dirty);
  } catch (err) {
    console.warn(
      `[mergeQueueV2] group evaluation failed for ${key}:`,
      err instanceof Error ? err.message : err
    );
  } finally {
    groups.delete(key);
    // A trigger that landed between the last pass and the delete re-schedules
    // via its own scheduleGroupEvaluation call — nothing is lost (and the
    // reconciler backstops any race).
  }
}

/** Awaitable single evaluation — tests and direct callers that need the
 *  result settled before proceeding (the scheduled path is fire-and-forget).
 *  Scope-escaped like the scheduled path: the pipeline never runs on a
 *  request's transaction handle. */
export async function evaluateGroupNow(
  repositoryId: string,
  baseBranch: string,
  trigger: string
): Promise<void> {
  await runWithoutScope(() => evaluateGroupOnce(repositoryId, baseBranch, trigger));
}

async function evaluateGroupOnce(
  repositoryId: string,
  baseBranch: string,
  trigger: string
): Promise<void> {
  if (!(await mergeQueueV2Active())) return;
  const outcome = await guardCrossReplica(`mqv2:group:${repositoryId}:${baseBranch}`, () =>
    withTimeout(
      walkGroup(repositoryId, baseBranch, trigger),
      GROUP_EVALUATION_TIMEOUT_MS,
      `${repositoryId}|${baseBranch}`
    )
  );
  if (!outcome.acquired) {
    // Another replica is evaluating this group right now — drop the trigger;
    // its own triggers + the reconciler cover this group.
    return;
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T | void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[mergeQueueV2] group ${label} evaluation timed out after ${ms}ms — abandoning`);
      debugBus.recordEvent({
        service: 'merge_queue',
        action: 'evaluation_timeout',
        ok: false,
        summary: `group ${label} evaluation timed out after ${Math.round(ms / 1000)}s`,
      });
      resolve();
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function walkGroup(repositoryId: string, baseBranch: string, trigger: string): Promise<void> {
  const db = getPoolDbClient();
  const entries = await loadActiveGroup(repositoryId, baseBranch, db);
  if (entries.length === 0) return;

  // One query for every PR row in the group (explicit projection).
  const prRows = await db
    .select(PR_EVAL_COLUMNS)
    .from(pullRequestsTable)
    .where(
      inArray(
        pullRequestsTable.id,
        entries.map((e) => e.pullRequestId)
      )
    );
  const prById = new Map<string, PrEvalRow>(prRows.map((r) => [r.id, r]));

  // While the group's GitHub account is in a REST backoff, every merge-path
  // call inside the walk would sleep behind waitIfBlocked — defer the whole
  // group to the reconciler instead (v1's between-heads deferral).
  const workspaceId = entries[0]!.workspaceId;
  // 'ordered' (default): FIFO, first hold consumes the group's turn, one
  // merge in flight per group. 'eager': every entry is its own head — clean
  // ones merge/arm immediately, blocked ones remediate concurrently, and the
  // walk never stops early. The decision engine is untouched; eager is purely
  // "evaluate each entry as a group of one".
  const mode = await getMergeQueueMode(workspaceId, db);
  const eager = mode === 'eager';
  const accountKey = githubService.accountKeyFor(workspaceId);
  if (githubRateGate.isBlocked(accountKey, 'rest')) {
    debugBus.recordEvent({
      service: 'merge_queue',
      action: 'group_deferred',
      summary: `group ${repositoryId}|${baseBranch} deferred — REST rate gate blocked`,
      workspaceId,
    });
    return;
  }

  const positions = computeEntryPositions(entries);
  const evaluated: string[] = [];
  // A sibling counts as "merge in flight" while merging, while its entry is
  // armed, or while GitHub still holds ANY armed auto-merge on it (the
  // armedBy mirror can outlive the status during remediation) — merging past
  // it would invalidate the CI GitHub is about to merge on. Seeded from the
  // loaded rows and kept CURRENT during the walk: an earlier entry arming in
  // this very walk must gate the ones behind it.
  const inFlight = (e: { status: string; automergeArmedBy: string | null }) =>
    e.status === 'merging' || e.status === 'automerge_armed' || e.automergeArmedBy !== null;
  const inFlightIds = new Set(entries.filter(inFlight).map((e) => e.id));
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const pr = prById.get(entry.pullRequestId);
    if (!pr) {
      // PR row deleted under the entry (workspace/repo teardown mid-flight —
      // the FK cascade usually removes the entry with it, but a row deleted
      // via a path that didn't cascade leaves an orphan; close it out).
      await closeActiveEntry(
        entry.pullRequestId,
        'removed',
        { trigger, message: 'PR row disappeared — removing from the queue.', code: 'orphaned' },
        db
      );
      continue;
    }
    // Eager mode: no sibling gates a merge, and every entry may arm/merge as
    // if it were the head. GitHub still serializes the actual base updates —
    // a sibling that goes BEHIND after a merge just re-evaluates on its own
    // snapshot event.
    const groupMergeInFlight = eager ? false : [...inFlightIds].some((id) => id !== entry.id);
    let verdict: 'hold' | 'advance' = 'hold';
    try {
      const result = await evaluateEntry({
        entry,
        pr,
        position: positions.get(entry.id) ?? i + 1,
        isHead: eager || (evaluated.length === 0 && i === 0),
        groupMergeInFlight,
        trigger,
      });
      if (result.casLost) {
        // Someone newer is writing this group — stop walking; their
        // evaluation (or the reconciler) owns it now.
        return;
      }
      verdict = result.verdict;
      if (result.finalEntry) {
        if (inFlight(result.finalEntry)) inFlightIds.add(entry.id);
        else inFlightIds.delete(entry.id);
      }
    } catch (err) {
      // One entry failing must never abort the group — log and end the turn.
      console.warn(
        `[mergeQueueV2] evaluation failed for ${pr.owner}/${pr.repo}#${pr.number}:`,
        err instanceof Error ? err.message : err
      );
    }
    evaluated.push(entry.id);
    // Ordered mode: the first 'hold' consumes the group's turn (one same-base
    // merge per evaluation). Eager mode: keep walking — every entry gets its
    // shot this evaluation.
    if (!eager && verdict === 'hold') break;
  }
  await touchEvaluated(evaluated, db);
}
