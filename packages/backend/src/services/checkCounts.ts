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

/**
 * Apply one `check_run` event: upsert its state, then for every tracked PR on
 * THIS commit recompute the counts and broadcast them. Returns the number of PR
 * rows updated (0 when the check is for an untracked PR or a superseded commit).
 *
 * `prNumbers` are the PRs the check belongs to; `trackedByRepo` (from
 * `filterTrackedOpenAcross`) says which of those each workspace tracks.
 */
export async function ingestCheckRun(
  ev: CheckEventInput,
  targets: CheckTarget[],
  prNumbers: number[],
  trackedByRepo: Map<string, Set<number>>,
): Promise<number> {
  const db = getPoolDbClient();

  // 1. Which (repositoryId, number) pairs does this check belong to AND we track?
  //    Resolved entirely in memory from the worker's filter result. If none, we
  //    bail BEFORE any DB write — we never store check state for PRs nobody
  //    tracks (that would accumulate the whole firehose).
  const wanted: Array<{ repositoryId: string; number: number }> = [];
  for (const t of targets) {
    const nums = trackedByRepo.get(t.repositoryId);
    if (!nums) continue;
    for (const n of prNumbers) if (nums.has(n)) wanted.push({ repositoryId: t.repositoryId, number: n });
  }
  if (wanted.length === 0) return 0;

  // 2. Read those rows + their CURRENT head sha (via `->>`, not the blob). Only
  //    PRs whose current head IS this commit count — checks on a superseded sha
  //    (post-force-push) are dropped, matching GitHub's rollup, and aren't even
  //    stored (keeps the table to live checks on tracked PRs).
  const repoIds = [...new Set(wanted.map((w) => w.repositoryId))];
  const numbers = [...new Set(wanted.map((w) => w.number))];
  const wantedKey = new Set(wanted.map((w) => `${w.repositoryId}:${w.number}`));
  const rows = await db
    .select({
      id: pullRequestsTable.id,
      workspaceId: pullRequestsTable.workspaceId,
      repositoryId: pullRequestsTable.repositoryId,
      number: pullRequestsTable.number,
      owner: pullRequestsTable.owner,
      repo: pullRequestsTable.repo,
      taskId: pullRequestsTable.taskId,
      headSha: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'headSha'`,
    })
    .from(pullRequestsTable)
    .where(
      and(
        inArray(pullRequestsTable.repositoryId, repoIds),
        inArray(pullRequestsTable.number, numbers),
        eq(pullRequestsTable.state, 'open'),
      ),
    );
  const affected = rows.filter(
    (r) => wantedKey.has(`${r.repositoryId}:${r.number}`) && r.headSha === ev.headSha,
  );
  if (affected.length === 0) return 0;

  // 3. Upsert the check's latest state (workspace-independent). Guard against
  //    out-of-order events: only overwrite when this event is at least as recent.
  await db
    .insert(prCheckStates)
    .values({
      id: uuid(),
      repoFullName: ev.repoFullName,
      headSha: ev.headSha,
      name: ev.name,
      source: ev.source,
      externalId: ev.externalId,
      state: ev.state,
      ts: ev.ts,
    })
    .onConflictDoUpdate({
      target: [prCheckStates.repoFullName, prCheckStates.headSha, prCheckStates.name],
      set: {
        state: ev.state,
        source: ev.source,
        externalId: ev.externalId,
        ts: ev.ts,
        updatedAt: new Date(),
      },
      // NB: pass the timestamp as an ISO string, not a Date. In a raw `sql`
      // fragment drizzle can't apply the column's type serializer, so a Date
      // reaches postgres-js unserialized — which the transaction pooler's
      // `prepare:false` simple protocol rejects (ERR_INVALID_ARG_TYPE). The
      // `.values({ ts })` above is fine: there drizzle knows the column type.
      setWhere: sql`${prCheckStates.ts} <= ${ev.ts.toISOString()}::timestamptz`,
    });

  // Recompute counts + digest ONCE from the deduped per-check rows for this sha.
  const stateRows = await db
    .select({ state: prCheckStates.state, name: prCheckStates.name })
    .from(prCheckStates)
    .where(
      and(eq(prCheckStates.repoFullName, ev.repoFullName), eq(prCheckStates.headSha, ev.headSha)),
    );
  const states = stateRows.map((r) => r.state as CheckState);
  const counts = countsFromStates(states);
  const digest = computeCheckDigest(
    ev.headSha,
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
  debugBus.recordEvent({
    service: 'check_counts',
    action: 'incremental',
    ok: true,
    summary: `incremental checks ${ev.repoFullName} ${ev.headSha.slice(0, 7)} ${ev.name}=${ev.state} → ${affected.length} PR(s)`,
  });
  return affected.length;
}

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
