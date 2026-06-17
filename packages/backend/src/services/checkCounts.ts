// Incremental check counts from webhooks. See docs/INCREMENTAL_CHECK_COUNTS.md.
//
// A `check_run` webhook carries one check's new state. Instead of a full GraphQL
// `refreshPr` (~1-2s) per event, we keep per-check state in `pr_check_states`
// (one row per repo+sha+name, self-deduping via the unique index) and derive a
// PR's pill counts from a `GROUP BY` — zero GitHub calls on the hot path. The
// 5-min sweep + the detail-overlay's full fetch remain the source of truth, so
// any drift self-heals.
//
// Egress-conscious: we read the small per-check rows (never the `lastSummary`
// blob), write counts back with `jsonb_set`, and broadcast a partial update the
// desktop merges. Nothing per-check ever leaves the backend.

import { v4 as uuid } from 'uuid';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { getPoolDbClient } from '../db/client.js';
import {
  pullRequests as pullRequestsTable,
  prCheckStates,
} from '../db/schema.js';
import {
  normalizeCheckState,
  computeCheckDigest,
  type CheckState,
  type CheckBreakdown,
} from './githubGraphql.js';
import { emitPullRequestUpdated } from './websocket.js';
import { targetsForRepo } from './webhookIndex.js';
import { debugBus } from './debugBus.js';

/** A single check's state extracted from a `check_run` webhook payload. */
export interface CheckEventInput {
  repoFullName: string; // lowercased owner/repo
  owner: string;
  repo: string;
  headSha: string;
  name: string;
  source: 'check_run' | 'status';
  externalId: string | null;
  state: CheckState;
  ts: Date;
}

/** Which workspaces watch the repo this delivery is for. */
export interface CheckTarget {
  workspaceId: string;
  repositoryId: string;
}

/**
 * Parse a `check_run` webhook payload into a {@link CheckEventInput}, or null if
 * it isn't usable (missing name/sha). `repoFullName` comes from the delivery.
 */
export function parseCheckRunPayload(
  payload: Record<string, unknown>,
  repoFullName: string,
): CheckEventInput | null {
  const cr = payload.check_run as
    | {
        id?: number | string;
        name?: string;
        status?: string;
        conclusion?: string | null;
        head_sha?: string;
        started_at?: string | null;
        completed_at?: string | null;
      }
    | undefined;
  if (!cr || typeof cr.name !== 'string' || typeof cr.head_sha !== 'string') return null;
  const repo = payload.repository as { owner?: { login?: string }; name?: string } | undefined;
  const owner = repo?.owner?.login ?? repoFullName.split('/')[0] ?? '';
  const repoName = repo?.name ?? repoFullName.split('/')[1] ?? '';
  const tsStr = cr.completed_at ?? cr.started_at ?? null;
  return {
    repoFullName: repoFullName.toLowerCase(),
    owner,
    repo: repoName,
    headSha: cr.head_sha,
    name: cr.name,
    source: 'check_run',
    externalId: cr.id !== undefined ? String(cr.id) : null,
    state: normalizeCheckState({ status: cr.status, conclusion: cr.conclusion }),
    ts: tsStr ? new Date(tsStr) : new Date(),
  };
}

/** Roll a deduped check list into the pill's {@link CheckBreakdown} (matches `rawToSummary`). */
function countsFromStates(states: CheckState[]): CheckBreakdown {
  return {
    total: states.length,
    passed: states.filter((s) => s === 'success').length,
    failed: states.filter((s) => s === 'failure').length,
    inProgress: states.filter((s) => s === 'in_progress' || s === 'pending').length,
    skipped: states.filter((s) => s === 'skipped').length,
  };
}

/** An open PR a check on a given sha applies to. */
interface AffectedPr {
  id: string;
  workspaceId: string;
  repositoryId: string;
  number: number;
  owner: string;
  repo: string;
  taskId: string | null;
}

/** Columns of an affected PR — never the `last_summary` blob. */
const AFFECTED_COLUMNS = {
  id: pullRequestsTable.id,
  workspaceId: pullRequestsTable.workspaceId,
  repositoryId: pullRequestsTable.repositoryId,
  number: pullRequestsTable.number,
  owner: pullRequestsTable.owner,
  repo: pullRequestsTable.repo,
  taskId: pullRequestsTable.taskId,
} as const;

/**
 * Open PRs among `repoIds` whose current head IS `headSha`. The head match is
 * pushed into SQL (`last_summary ->> 'headSha' = $sha`) so a repo with hundreds
 * of open PRs returns only the (usually one) matching row — not the whole open
 * set to filter in JS. Checks on a superseded sha (post-force-push) match
 * nothing, exactly like GitHub's rollup.
 */
async function affectedPrsForSha(repoIds: string[], headSha: string): Promise<AffectedPr[]> {
  if (repoIds.length === 0) return [];
  const db = getPoolDbClient();
  return db
    .select(AFFECTED_COLUMNS)
    .from(pullRequestsTable)
    .where(
      and(
        inArray(pullRequestsTable.repositoryId, repoIds),
        eq(pullRequestsTable.state, 'open'),
        sql`${pullRequestsTable.lastSummary} ->> 'headSha' = ${headSha}`,
      ),
    );
}

/**
 * Upsert one or many check states for the SAME (repo, sha) in a single
 * statement. Out-of-order safe: a conflicting row is overwritten only when the
 * incoming event is at least as recent (`pr_check_states.ts <= excluded.ts`).
 * Callers must de-dupe by name first (one row per conflict target per statement).
 */
async function upsertCheckStates(states: CheckEventInput[]): Promise<void> {
  if (states.length === 0) return;
  const db = getPoolDbClient();
  await db
    .insert(prCheckStates)
    .values(
      states.map((s) => ({
        id: uuid(),
        repoFullName: s.repoFullName,
        headSha: s.headSha,
        name: s.name,
        source: s.source,
        externalId: s.externalId,
        state: s.state,
        ts: s.ts,
      })),
    )
    .onConflictDoUpdate({
      target: [prCheckStates.repoFullName, prCheckStates.headSha, prCheckStates.name],
      // Reference the incoming row via `excluded.*` so a multi-row upsert applies
      // each row's own value (a literal would force every conflict to the last).
      set: {
        state: sql`excluded.state`,
        source: sql`excluded.source`,
        externalId: sql`excluded.external_id`,
        ts: sql`excluded.ts`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`${prCheckStates.ts} <= excluded.ts`,
    });
}

/**
 * Recompute a sha's pill counts from the deduped per-check rows, write them to
 * every affected PR, and broadcast. One GROUP-BY read + one UPDATE per PR,
 * regardless of how many check events drove it.
 */
async function recomputeAndBroadcast(
  repoFullName: string,
  headSha: string,
  affected: AffectedPr[],
): Promise<void> {
  const db = getPoolDbClient();
  const stateRows = await db
    .select({ state: prCheckStates.state, name: prCheckStates.name })
    .from(prCheckStates)
    .where(and(eq(prCheckStates.repoFullName, repoFullName), eq(prCheckStates.headSha, headSha)));
  const counts = countsFromStates(stateRows.map((r) => r.state as CheckState));
  const digest = computeCheckDigest(
    headSha,
    stateRows.map((r) => ({ name: r.name, state: r.state as CheckState })),
  );

  const now = new Date();
  for (const row of affected) {
    await db
      .update(pullRequestsTable)
      .set({
        // jsonb_set patches just the `checks` key — never reads the blob back.
        lastSummary: sql`jsonb_set(${pullRequestsTable.lastSummary}, '{checks}', ${JSON.stringify(
          counts,
        )}::jsonb)`,
        lastCheckDigest: digest,
        updatedAt: now,
      })
      .where(eq(pullRequestsTable.id, row.id));
    // Partial broadcast — the desktop merges `checks` into its held summary.
    emitPullRequestUpdated(row.workspaceId, {
      id: row.id,
      taskId: row.taskId,
      repositoryId: row.repositoryId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      state: 'open',
      lastSummary: { checks: counts },
    });
  }
}

/**
 * Apply one `check_run` event synchronously: upsert its state, then for every
 * tracked PR on THIS commit recompute the counts and broadcast them. Returns the
 * number of PR rows updated (0 when the check is for an untracked PR or a
 * superseded commit).
 *
 * `prNumbers` are the PRs the check belongs to; `trackedByRepo` (from
 * `filterTrackedOpenAcross`) says which of those each workspace tracks.
 *
 * Kept for direct/single-shot use and as the canonical reference; the webhook
 * worker drives the higher-throughput {@link checkCountCoalescer} instead.
 */
export async function ingestCheckRun(
  ev: CheckEventInput,
  targets: CheckTarget[],
  prNumbers: number[],
  trackedByRepo: Map<string, Set<number>>,
): Promise<number> {
  // Which (repositoryId, number) pairs does this check belong to AND we track?
  // Resolved in memory from the worker's filter result — never store check state
  // for PRs nobody tracks (that would accumulate the whole firehose).
  const repoIds = new Set<string>();
  for (const t of targets) {
    const nums = trackedByRepo.get(t.repositoryId);
    if (!nums) continue;
    if (prNumbers.some((n) => nums.has(n))) repoIds.add(t.repositoryId);
  }
  if (repoIds.size === 0) return 0;

  const affected = await affectedPrsForSha([...repoIds], ev.headSha);
  if (affected.length === 0) return 0;

  await upsertCheckStates([ev]);
  await recomputeAndBroadcast(ev.repoFullName, ev.headSha, affected);
  debugBus.recordEvent({
    service: 'check_counts',
    action: 'incremental',
    ok: true,
    summary: `incremental checks ${ev.repoFullName} ${ev.headSha.slice(0, 7)} ${ev.name}=${ev.state} → ${affected.length} PR(s)`,
  });
  return affected.length;
}

/**
 * Coalesces the high-volume `check_run` firehose by (repo, sha).
 *
 * When a CI run starts, GitHub fires dozens of `check_run` events for the SAME
 * commit within a moment, then dozens of `completed` later. Handling each one
 * independently means N upserts + N GROUP-BY recomputes + N UPDATEs + N
 * broadcasts for a single PR's suite. The coalescer instead buffers events for a
 * short window keyed by `(repoFullName, headSha)`, de-duping to the latest state
 * per check name, then flushes ONCE: a single multi-row upsert, one recompute,
 * one UPDATE + broadcast per affected PR — independent of burst size.
 *
 * Multi-replica note: buffers are per-process, so with the consumer group each
 * replica coalesces its own slice of a burst. That's still a large reduction;
 * and because the recompute reads ALL stored states for the sha (a GROUP BY over
 * the shared table), the final counts converge correctly no matter which replica
 * wrote which check.
 *
 * Durability: a delivery is ack'd before its buffered flush lands, so a crash
 * inside the (sub-second) window can drop a pending count update. Pill counts
 * are non-critical and self-heal — the next event for the sha re-flushes, and
 * the 5-min reconcile sweep re-derives authoritative counts regardless.
 */
class CheckCountCoalescer {
  private readonly windowMs: number;
  private pending = new Map<string, { states: Map<string, CheckEventInput>; timer: NodeJS.Timeout }>();

  constructor(windowMs = 750) {
    this.windowMs = windowMs;
  }

  private key(repoFullName: string, headSha: string): string {
    return `${repoFullName} ${headSha}`;
  }

  /** Buffer one parsed check event; schedules a flush for its (repo, sha). */
  enqueue(ev: CheckEventInput): void {
    const k = this.key(ev.repoFullName, ev.headSha);
    let entry = this.pending.get(k);
    if (!entry) {
      const timer = setTimeout(() => {
        void this.flush(k);
      }, this.windowMs);
      if (typeof timer.unref === 'function') timer.unref();
      entry = { states: new Map(), timer };
      this.pending.set(k, entry);
    }
    // Latest activity wins (matches the upsert's out-of-order guard).
    const prev = entry.states.get(ev.name);
    if (!prev || prev.ts <= ev.ts) entry.states.set(ev.name, ev);
  }

  private async flush(k: string): Promise<void> {
    const entry = this.pending.get(k);
    if (!entry) return;
    this.pending.delete(k);
    clearTimeout(entry.timer);
    const states = [...entry.states.values()];
    if (states.length === 0) return;
    const { repoFullName, headSha } = states[0];
    try {
      const targets = await targetsForRepo(repoFullName);
      const repoIds = [...new Set(targets.map((t) => t.repositoryId))];
      const affected = await affectedPrsForSha(repoIds, headSha);
      if (affected.length === 0) return; // sha no longer any tracked PR's head
      await upsertCheckStates(states);
      await recomputeAndBroadcast(repoFullName, headSha, affected);
      debugBus.recordEvent({
        service: 'check_counts',
        action: 'incremental',
        ok: true,
        summary: `incremental checks ${repoFullName} ${headSha.slice(0, 7)} ×${states.length} → ${affected.length} PR(s)`,
      });
    } catch (err) {
      debugBus.recordEvent({
        service: 'check_counts',
        action: 'incremental',
        ok: false,
        summary: `coalesced flush ${repoFullName} ${headSha.slice(0, 7)} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** Flush everything now — for graceful shutdown and deterministic tests. */
  async flushAllNow(): Promise<void> {
    for (const k of [...this.pending.keys()]) await this.flush(k);
  }

  /** Test helper — drop buffered state without flushing. */
  _reset(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }
}

export const checkCountCoalescer = new CheckCountCoalescer();

/** Drop all check state for a commit — called on PR close/merge and force-push. */
export async function pruneChecksForSha(repoFullName: string, headSha: string): Promise<void> {
  if (!headSha) return;
  const db = getPoolDbClient();
  await db
    .delete(prCheckStates)
    .where(
      and(
        eq(prCheckStates.repoFullName, repoFullName.toLowerCase()),
        eq(prCheckStates.headSha, headSha),
      ),
    );
}

/**
 * Safety-net TTL prune (run from the reconcile sweep): drop check state untouched
 * for `olderThanMs`. Close/merge/force-push prune precisely; this only catches
 * rows orphaned by a *missed* delivery, so the table can't grow unbounded —
 * checks settle within hours, so anything idle for a day is from a gone PR.
 * Returns the number of rows deleted.
 */
export async function pruneStaleCheckStates(
  olderThanMs = 24 * 60 * 60_000,
): Promise<number> {
  const db = getPoolDbClient();
  const cutoff = new Date(Date.now() - olderThanMs);
  const deleted = await db
    .delete(prCheckStates)
    .where(lt(prCheckStates.updatedAt, cutoff))
    .returning({ id: prCheckStates.id });
  return deleted.length;
}
