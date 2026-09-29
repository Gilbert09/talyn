// The per-commit CHECK LEDGER. See docs/INCREMENTAL_CHECK_COUNTS.md.
//
// `pr_check_states` holds one row per (repo, head sha, check name): its state,
// GitHub's raw verdict, its required-ness and its link. Two writers feed it:
//   - `check_run` / `status` webhooks, one check at a time, through the
//     coalescer below — zero GitHub calls on the hot path;
//   - every COMPLETE GraphQL fetch, which RESEEDS the whole commit
//     (`reseedCheckLedger`). This is what the ledger used to lack: nothing ever
//     corrected it, so one lost completion left a row `pending` for good and
//     every later check event re-wrote "1/232 running" over a pill the full
//     fetch had just fixed (PostHog/posthog#104122).
//
// Every ledger write + recompute for a commit runs under one advisory lock, so
// two flushes (same process, another replica, or a deploy overlap) can no longer
// interleave read and write and land the older count last. And the recompute
// re-derives the WHOLE verdict — `ciStatus`, `humanGates`, `blockingReason` —
// from the ledger plus the PR facts already on the row, through the same
// `deriveCiVerdict` the full fetch uses. It used to patch `checks` alone and keep
// whatever verdict it found, which is how a held `'blocked'` survived a required
// `Semgrep Checks Pass` going red.
//
// Egress-conscious: the per-check rows never leave the backend; the PR facts are
// `->>`-extracted scalars, never the `last_summary` blob; the UPDATE is skipped
// when nothing it would write has changed.

import { v4 as uuid } from 'uuid';
import { and, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { deriveCiVerdict, type CheckFact, type CiVerdict } from '@talyn/shared';
import { getPoolDbClient, isRealPostgres } from '../db/client.js';
import {
  pullRequests as pullRequestsTable,
  prCheckStates,
} from '../db/schema.js';
import {
  breakdownOf,
  computeBlockingReason,
  computeCheckDigest,
  computeFailingChecksDigest,
  normalizeCheckState,
  type BlockingReason,
  type CheckBreakdown,
  type CheckState,
  type PRSummary,
  type ReviewDecision,
} from './githubGraphql.js';
import { emitPullRequestUpdated } from './websocket.js';
import { domainEvents } from './events.js';
import { forceFetchAndUpsert } from './prCache.js';
import { targetsForRepo } from './webhookIndex.js';
import { debugBus, describeError } from './debugBus.js';
import { withBlockingAdvisoryLock } from './advisoryLock.js';

/** A single check's state, from a `check_run` or `status` webhook payload. */
export interface CheckEventInput {
  repoFullName: string; // lowercased owner/repo
  owner: string;
  repo: string;
  headSha: string;
  name: string;
  source: 'check_run' | 'status';
  externalId: string | null;
  state: CheckState;
  /** GitHub's own conclusion / state before normalisation. */
  rawState?: string | null;
  url?: string | null;
  ts: Date;
}

/** Which workspaces watch the repo this delivery is for. */
export interface CheckTarget {
  workspaceId: string;
  repositoryId: string;
}

/**
 * The event time a payload vouches for, or the epoch when it vouches for none.
 *
 * NOT `new Date()`. The upsert keeps a row only against an event at least as
 * recent, so a timestamp minted at processing time — later than anything GitHub
 * stamps — let a queued event with no times outrank the completion that
 * followed it, and wedged the row `pending`. The epoch loses to every real
 * event instead, and the next complete fetch corrects the row either way.
 */
function eventTime(...values: Array<string | null | undefined>): Date {
  for (const v of values) {
    if (!v) continue;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t);
  }
  return new Date(0);
}

function ownerAndRepo(
  payload: Record<string, unknown>,
  repoFullName: string,
): { owner: string; repo: string } {
  const repo = payload.repository as { owner?: { login?: string }; name?: string } | undefined;
  return {
    owner: repo?.owner?.login ?? repoFullName.split('/')[0] ?? '',
    repo: repo?.name ?? repoFullName.split('/')[1] ?? '',
  };
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
        details_url?: string | null;
        html_url?: string | null;
      }
    | undefined;
  if (!cr || typeof cr.name !== 'string' || typeof cr.head_sha !== 'string') return null;
  return {
    repoFullName: repoFullName.toLowerCase(),
    ...ownerAndRepo(payload, repoFullName),
    headSha: cr.head_sha,
    name: cr.name,
    source: 'check_run',
    externalId: cr.id !== undefined ? String(cr.id) : null,
    state: normalizeCheckState({ status: cr.status, conclusion: cr.conclusion }),
    rawState: (cr.conclusion ?? cr.status)?.toUpperCase() ?? null,
    url: cr.details_url ?? cr.html_url ?? null,
    ts: eventTime(cr.completed_at, cr.started_at),
  };
}

/**
 * Parse a legacy commit `status` webhook payload. These carry the states
 * check runs cannot: PostHog Visual Review reports as a commit status, and its
 * approval turning green arrives ONLY this way — ignoring `status` is why a
 * person could approve a review and Talyn would not notice until the sweep.
 */
export function parseStatusPayload(
  payload: Record<string, unknown>,
  repoFullName: string,
): CheckEventInput | null {
  const sha = payload.sha;
  const context = payload.context;
  const state = payload.state;
  if (typeof sha !== 'string' || typeof context !== 'string' || typeof state !== 'string') {
    return null;
  }
  return {
    repoFullName: repoFullName.toLowerCase(),
    ...ownerAndRepo(payload, repoFullName),
    headSha: sha,
    name: context,
    source: 'status',
    externalId: payload.id !== undefined ? String(payload.id) : null,
    state: normalizeCheckState({ state }),
    rawState: state.toUpperCase(),
    url: typeof payload.target_url === 'string' ? payload.target_url : null,
    ts: eventTime(
      payload.updated_at as string | undefined,
      payload.created_at as string | undefined,
    ),
  };
}

/** An open PR a check on a given sha applies to, with the facts its verdict needs. */
interface AffectedPr {
  id: string;
  workspaceId: string;
  repositoryId: string;
  number: number;
  owner: string;
  repo: string;
  taskId: string | null;
  blockingReason: string | null;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  labels: string[] | null;
  lastCheckDigest: string | null;
}

/** Scalars only — the summary fields are `->`/`->>`-extracted, so the blob never ships. */
const AFFECTED_COLUMNS = {
  id: pullRequestsTable.id,
  workspaceId: pullRequestsTable.workspaceId,
  repositoryId: pullRequestsTable.repositoryId,
  number: pullRequestsTable.number,
  owner: pullRequestsTable.owner,
  repo: pullRequestsTable.repo,
  taskId: pullRequestsTable.taskId,
  blockingReason: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'blockingReason'`,
  mergeable: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'mergeable'`,
  mergeStateStatus: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'mergeStateStatus'`,
  reviewDecision: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'reviewDecision'`,
  labels: sql<string[] | null>`${pullRequestsTable.lastSummary} -> 'labels'`,
  lastCheckDigest: pullRequestsTable.lastCheckDigest,
} as const;

/**
 * Open PRs among `repoIds` whose current head IS `headSha`. The head match is
 * pushed into SQL so a repo with hundreds of open PRs returns only the (usually
 * one) matching row. Checks on a superseded sha match nothing, exactly like
 * GitHub's rollup.
 *
 * `lockRows` takes the rows `FOR UPDATE`: a request transaction that has just
 * written a fresh summary still holds them, and reading before it commits would
 * derive the verdict from the facts it is replacing.
 */
async function affectedPrsForSha(
  repoIds: string[],
  headSha: string,
  lockRows = false,
): Promise<AffectedPr[]> {
  if (repoIds.length === 0) return [];
  const db = getPoolDbClient();
  const query = db
    .select(AFFECTED_COLUMNS)
    .from(pullRequestsTable)
    .where(
      and(
        inArray(pullRequestsTable.repositoryId, repoIds),
        eq(pullRequestsTable.state, 'open'),
        sql`${pullRequestsTable.lastSummary} ->> 'headSha' = ${headSha}`,
      ),
    );
  return lockRows && isRealPostgres() ? query.for('update') : query;
}

/**
 * Serialize everything that writes the ledger for one commit and derives a
 * verdict from it. Blocking, transaction-scoped (the only advisory flavour the
 * transaction-mode pooler honours — see advisoryLock.ts). The pglite harness is
 * one connection whose transaction() is an exclusive mutex, so there it runs
 * unlocked; cross-connection races do not exist there.
 */
async function withShaLock<T>(repoFullName: string, headSha: string, fn: () => Promise<T>): Promise<T> {
  if (!isRealPostgres()) return fn();
  return withBlockingAdvisoryLock(getPoolDbClient(), `checks:${repoFullName}:${headSha}`, fn);
}

/**
 * Upsert one or many check states for the SAME (repo, sha) in a single
 * statement. Out-of-order safe: a row is overwritten only by an event at least
 * as recent. `required` is never set here — a webhook cannot know it — so a
 * row keeps what the last full fetch said. Callers de-dupe by name first.
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
        rawState: s.rawState ?? null,
        url: s.url ?? null,
        ts: s.ts,
      })),
    )
    .onConflictDoUpdate({
      target: [prCheckStates.repoFullName, prCheckStates.headSha, prCheckStates.name],
      // `excluded.*` so a multi-row upsert applies each row's own value.
      set: {
        state: sql`excluded.state`,
        source: sql`excluded.source`,
        externalId: sql`excluded.external_id`,
        rawState: sql`excluded.raw_state`,
        url: sql`COALESCE(excluded.url, ${prCheckStates.url})`,
        ts: sql`excluded.ts`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`${prCheckStates.ts} <= excluded.ts`,
    });
}

/** Per-check contexts a full fetch produced, as the ledger stores them. */
export type LedgerSnapshot = PRSummary['checkContexts'];

/**
 * Make the ledger for `headSha` say what a COMPLETE full fetch said.
 *
 * A row no webhook has touched since `fetchStartedAt` is overwritten outright —
 * the snapshot is newer than anything it holds, whatever its `ts` claims, which
 * is also what heals a row a bad timestamp wedged. A row a webhook wrote DURING
 * the fetch keeps the usual rule (newer event wins), so a completion that raced
 * the fetch is not rolled back. Rows the snapshot does not list, and nothing
 * touched since the fetch began, are deleted: GitHub no longer counts them.
 *
 * `required` is taken from the snapshot when it knows (a by-number fetch), and
 * kept when it does not (the by-branch path cannot ask).
 *
 * Then re-derives the verdict for the PRs on that head. A no-op write is
 * skipped, so after an ordinary poll this costs one read and no UPDATE.
 */
export async function reseedCheckLedger(opts: {
  owner: string;
  repo: string;
  headSha: string;
  contexts: LedgerSnapshot;
  fetchStartedAt: Date;
  repositoryId: string;
}): Promise<void> {
  const repoFullName = `${opts.owner}/${opts.repo}`.toLowerCase();
  const { headSha, fetchStartedAt } = opts;
  if (!headSha) return;
  // Latest per name: the snapshot is already deduped, but a duplicate would
  // fail the multi-row upsert ("cannot affect row a second time").
  const byName = new Map<string, LedgerSnapshot[number]>();
  for (const c of opts.contexts) byName.set(c.name, c);
  const snapshot = [...byName.values()];

  await withShaLock(repoFullName, headSha, async () => {
    const db = getPoolDbClient();
    if (snapshot.length > 0) {
      await db
        .insert(prCheckStates)
        .values(
          snapshot.map((c) => ({
            id: uuid(),
            repoFullName,
            headSha,
            name: c.name,
            source: 'snapshot',
            externalId: null,
            state: c.state,
            required: c.required,
            rawState: c.rawState ?? null,
            url: c.url,
            ts: new Date(c.ts ?? 0),
          })),
        )
        .onConflictDoUpdate({
          target: [prCheckStates.repoFullName, prCheckStates.headSha, prCheckStates.name],
          set: {
            state: sql`excluded.state`,
            source: sql`excluded.source`,
            required: sql`COALESCE(excluded.required, ${prCheckStates.required})`,
            rawState: sql`excluded.raw_state`,
            url: sql`COALESCE(excluded.url, ${prCheckStates.url})`,
            ts: sql`excluded.ts`,
            updatedAt: sql`now()`,
          },
          setWhere: sql`${prCheckStates.updatedAt} < ${fetchStartedAt.toISOString()}::timestamptz OR ${prCheckStates.ts} <= excluded.ts`,
        });
    }
    const names = snapshot.map((c) => c.name);
    await db
      .delete(prCheckStates)
      .where(
        and(
          eq(prCheckStates.repoFullName, repoFullName),
          eq(prCheckStates.headSha, headSha),
          lt(prCheckStates.updatedAt, fetchStartedAt),
          names.length > 0 ? notInArray(prCheckStates.name, names) : undefined,
        ),
      );
    // Every workspace tracking this PR reads the same ledger, so correct all
    // of them, not only the one whose fetch this was.
    const affected = await affectedPrsForSha(await trackingRepoIds(repoFullName, opts.repositoryId), headSha, true);
    if (affected.length === 0) return;
    await recomputeVerdicts(repoFullName, headSha, affected, { announceUnchanged: false });
  });
  debugBus.recordEvent({
    service: 'check_counts',
    action: 'reseed',
    ok: true,
    summary: `reseeded ${repoFullName} ${headSha.slice(0, 7)} ×${snapshot.length}`,
  });
}

/** Repository rows watching `repoFullName`, always including `known`. */
async function trackingRepoIds(repoFullName: string, known: string): Promise<string[]> {
  try {
    const targets = await targetsForRepo(repoFullName);
    return [...new Set([known, ...targets.map((t) => t.repositoryId)])];
  } catch {
    // The index could not authorize any recipient right now. The fetch that
    // brought us here is still ours to apply.
    return [known];
  }
}

// Per-PR cooldown for the required-ness recheck below. A webhook cannot say
// whether a check is required, so a failing ledger row the last full fetch did
// not describe has `required = null`. That reads as BLOCKING (never guess
// green), and fires one targeted authoritative refresh to find out. The cooldown
// keeps a churning CI suite from firing one GraphQL fetch per flush: 15s bounds
// rechecks to ~4/min per PR while still correcting within one window.
// Per-process (like the coalescer) — a duplicate across replicas just writes the
// same authoritative verdict.
const REQUIREDNESS_RECHECK_COOLDOWN_MS = 15_000;
const requirednessRecheckAt = new Map<string, number>();
// A recheck the cooldown suppresses parks a single trailing timer here (keyed by
// PR id), re-armed with the latest row on each suppressed call. A leading-only
// cooldown drops the recheck that matters most: the first failure of a burst
// fires it, a REQUIRED check fails a few seconds later inside the cooldown, the
// suite settles, and nothing ever asks about the second one.
const requirednessRecheckTrailing = new Map<string, { timer: NodeJS.Timeout; row: AffectedPr }>();

/** Run the authoritative by-number refresh now and stamp the cooldown. */
function fireRequirednessRecheck(row: AffectedPr): void {
  requirednessRecheckAt.set(row.id, Date.now());
  void forceFetchAndUpsert({
    workspaceId: row.workspaceId,
    repositoryId: row.repositoryId,
    taskId: row.taskId,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
  })
    .then((result) =>
      debugBus.recordEvent({
        service: 'check_counts',
        action: 'requiredness_recheck',
        ok: true,
        summary: `requiredness recheck ${row.owner}/${row.repo}#${row.number} → ${
          result?.summary.blockingReason ?? 'no-op'
        }`,
      }),
    )
    .catch((err: unknown) =>
      debugBus.recordEvent({
        service: 'check_counts',
        action: 'requiredness_recheck',
        ok: false,
        summary: `requiredness recheck ${row.owner}/${row.repo}#${row.number} failed: ${describeError(err)}`,
      }),
    );
}

/** Leading + trailing debounce around {@link fireRequirednessRecheck}. */
function scheduleRequirednessRecheck(row: AffectedPr): void {
  const now = Date.now();
  const sinceLast = now - (requirednessRecheckAt.get(row.id) ?? -Infinity);
  if (sinceLast >= REQUIREDNESS_RECHECK_COOLDOWN_MS) {
    const parked = requirednessRecheckTrailing.get(row.id);
    if (parked) {
      clearTimeout(parked.timer);
      requirednessRecheckTrailing.delete(row.id);
    }
    fireRequirednessRecheck(row);
    return;
  }
  const existing = requirednessRecheckTrailing.get(row.id);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    requirednessRecheckTrailing.delete(row.id);
    fireRequirednessRecheck(row);
  }, REQUIREDNESS_RECHECK_COOLDOWN_MS - sinceLast);
  if (typeof timer.unref === 'function') timer.unref();
  requirednessRecheckTrailing.set(row.id, { timer, row });
}

/** Test helper — clear the required-ness recheck cooldown + trailing timers. */
export function _resetRequirednessRecheck(): void {
  for (const { timer } of requirednessRecheckTrailing.values()) clearTimeout(timer);
  requirednessRecheckTrailing.clear();
  requirednessRecheckAt.clear();
}

/** Test helper — fire any parked trailing rechecks now. */
export function _flushRequirednessRecheckTrailing(): void {
  const parked = [...requirednessRecheckTrailing.values()];
  requirednessRecheckTrailing.clear();
  for (const { timer, row } of parked) {
    clearTimeout(timer);
    fireRequirednessRecheck(row);
  }
}

/** Verdicts the checks produce. A held one of these is not evidence of anything
 *  once the checks change, so "keep the held verdict over `unknown`" skips them. */
const CHECK_DERIVED_VERDICTS = new Set<string>(['checks_failed', 'checks_failed_optional', 'needs_human']);

/**
 * The whole-PR verdict from the ledger's facts plus the PR's own facts. The
 * same derivation the full fetch runs (`rawToSummary`), so the two paths can
 * only disagree about inputs, never about rules.
 *
 * A `mergeable: UNKNOWN` read makes `computeBlockingReason` answer `unknown`
 * when nothing else blocks — GitHub recomputes lazily. Like `prCache.upsertRow`,
 * keep a known held verdict over that, unless it was derived from the checks
 * that just changed.
 */
export function verdictFor(
  pr: Pick<AffectedPr, 'blockingReason' | 'mergeable' | 'mergeStateStatus' | 'reviewDecision' | 'labels'>,
  checks: CheckBreakdown,
  ci: CiVerdict,
): BlockingReason {
  const mergeable = (pr.mergeable ?? 'UNKNOWN') as PRSummary['mergeable'];
  const derived = computeBlockingReason({
    mergeable,
    mergeStateStatus: pr.mergeStateStatus ?? '',
    reviewDecision: (pr.reviewDecision ?? null) as ReviewDecision,
    checks,
    ci,
    labels: Array.isArray(pr.labels) ? pr.labels : undefined,
  });
  const held = pr.blockingReason;
  if (derived === 'unknown' && held && held !== 'unknown' && !CHECK_DERIVED_VERDICTS.has(held)) {
    return held as BlockingReason;
  }
  return derived;
}

/**
 * Re-derive every affected PR's checks + verdict from the ledger, write only
 * what changed, and broadcast. Must run inside {@link withShaLock}.
 *
 * `announceUnchanged` keeps the old webhook behaviour of emitting `pr:checks`
 * on every flush (the merge queue and workflows treat it as "checks moved");
 * a reseed passes false, because the full fetch that caused it has already
 * emitted its own snapshot event.
 */
async function recomputeVerdicts(
  repoFullName: string,
  headSha: string,
  affected: AffectedPr[],
  opts: { announceUnchanged: boolean },
): Promise<void> {
  const db = getPoolDbClient();
  const rows = await db
    .select({
      name: prCheckStates.name,
      state: prCheckStates.state,
      required: prCheckStates.required,
      rawState: prCheckStates.rawState,
      url: prCheckStates.url,
    })
    .from(prCheckStates)
    .where(and(eq(prCheckStates.repoFullName, repoFullName), eq(prCheckStates.headSha, headSha)));
  const facts: CheckFact[] = rows.map((r) => ({
    name: r.name,
    state: r.state as CheckState,
    required: r.required,
    rawState: r.rawState,
    url: r.url,
  }));
  const counts = breakdownOf(facts);
  const digest = computeCheckDigest(headSha, facts);
  const failingChecksDigest = computeFailingChecksDigest(facts);
  const countsJson = JSON.stringify(counts);

  let changedAny = false;
  for (const row of affected) {
    // No PR facts: `MERGEABLE + UNSTABLE` vouches that unknown failures are
    // optional only when it was read WITH them. The row's mergeStateStatus is
    // from the last full fetch, and a required check failing since then is
    // exactly what would have moved it to BLOCKED. Unknown reads as blocking
    // here until the recheck below answers.
    const ci = deriveCiVerdict(facts);
    const blockingReason = verdictFor(row, counts, ci);
    const patch = {
      checks: counts,
      blockingReason,
      ciStatus: ci.ciStatus,
      humanGates: ci.humanGates,
      failingChecksDigest,
    };
    const patchJson = JSON.stringify(patch);
    const updated = await db
      .update(pullRequestsTable)
      .set({
        // `||` merges just these top-level keys — never reads the blob back.
        lastSummary: sql`${pullRequestsTable.lastSummary} || ${patchJson}::jsonb`,
        lastCheckDigest: digest,
        // The summary no longer matches the digest the full fetch stored, so
        // the next full fetch must not skip its write as "unchanged".
        lastSummaryDigest: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(pullRequestsTable.id, row.id),
          sql`(
            ${pullRequestsTable.lastSummary} -> 'checks' IS DISTINCT FROM ${countsJson}::jsonb
            OR ${pullRequestsTable.lastSummary} ->> 'blockingReason' IS DISTINCT FROM ${blockingReason}
            OR ${pullRequestsTable.lastSummary} ->> 'ciStatus' IS DISTINCT FROM ${ci.ciStatus}
            OR ${pullRequestsTable.lastSummary} -> 'humanGates' IS DISTINCT FROM ${JSON.stringify(ci.humanGates)}::jsonb
            OR ${pullRequestsTable.lastSummary} ->> 'failingChecksDigest' IS DISTINCT FROM ${failingChecksDigest}
          )`,
        ),
      )
      .returning({ id: pullRequestsTable.id });
    if (updated.length === 0) continue;
    changedAny = true;
    // Partial broadcast — the front ends merge these keys into their held
    // summary. `checksAt` lets a store drop one that arrives after a newer one
    // (two replicas publish through Redis in no guaranteed order).
    emitPullRequestUpdated(row.workspaceId, {
      id: row.id,
      taskId: row.taskId,
      repositoryId: row.repositoryId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      state: 'open',
      lastSummary: { ...patch, checksAt: Date.now() },
    });
    // A failing check nobody has told us the required-ness of. It reads as
    // blocking until we know — ask, once the failing set actually changed.
    if (ci.unknownFailing > 0 && digest !== row.lastCheckDigest) {
      scheduleRequirednessRecheck(row);
    }
  }

  // Merge-queue v2 + workflows trigger: check webhooks never reach a full
  // refresh, so this recompute IS the "checks moved" signal.
  if (affected.length > 0 && (changedAny || opts.announceUnchanged)) {
    domainEvents.emit('pr:checks', {
      prs: affected.map((r) => ({
        prId: r.id,
        workspaceId: r.workspaceId,
        repositoryId: r.repositoryId,
        number: r.number,
      })),
      // Carried so a listener can answer "did this COMMIT just go green".
      repoFullName,
      headSha,
      checks: counts,
    });
  }
}

/**
 * Apply check events for ONE commit: upsert, then re-derive every tracked PR on
 * that head, all under the commit's lock. Events for a head no tracked PR is on
 * are dropped (never stored — that would accumulate the whole firehose), and the
 * settle refresh still fires, because "no PR is on this head yet" is usually the
 * `synchronize` refresh not having landed, and the refresh is what catches up.
 */
async function applyEvents(
  repoFullName: string,
  headSha: string,
  repoIds: string[],
  states: CheckEventInput[],
): Promise<number> {
  return withShaLock(repoFullName, headSha, async () => {
    const affected = await affectedPrsForSha(repoIds, headSha, true);
    if (affected.length === 0) return 0;
    await upsertCheckStates(states);
    await recomputeVerdicts(repoFullName, headSha, affected, { announceUnchanged: true });
    return affected.length;
  });
}

/**
 * Apply one check event synchronously. Returns the number of PR rows it
 * applied to (0 when the check is for an untracked PR or a superseded commit).
 *
 * `prNumbers` are the PRs the check belongs to; `trackedByRepo` (from
 * `filterTrackedOpenAcross`) says which of those each workspace tracks.
 *
 * Kept for direct/single-shot use; the webhook worker drives the
 * higher-throughput {@link checkCountCoalescer} instead.
 */
export async function ingestCheckRun(
  ev: CheckEventInput,
  targets: CheckTarget[],
  prNumbers: number[],
  trackedByRepo: Map<string, Set<number>>,
): Promise<number> {
  const repoIds = new Set<string>();
  for (const t of targets) {
    const nums = trackedByRepo.get(t.repositoryId);
    if (!nums) continue;
    if (prNumbers.some((n) => nums.has(n))) repoIds.add(t.repositoryId);
  }
  if (repoIds.size === 0) return 0;
  const n = await applyEvents(ev.repoFullName, ev.headSha, [...repoIds], [ev]);
  if (n > 0) {
    debugBus.recordEvent({
      service: 'check_counts',
      action: 'incremental',
      ok: true,
      summary: `incremental checks ${ev.repoFullName} ${ev.headSha.slice(0, 7)} ${ev.name}=${ev.state} → ${n} PR(s)`,
    });
  }
  return n;
}

// ── Settle refresh ──
//
// However carefully the webhook path is written, it can lose a completion: a
// delivery acked before its flush landed, a replica that died mid-window, a
// receiver that did not yet know the new head. The full fetch reseeds the
// ledger, so what matters is that one happens after CI goes quiet — and there is
// no periodic poll any more, and the 5-minute sweep defers under GraphQL budget
// pressure. So every check event (re)arms a per-commit timer; SETTLE_QUIET_MS
// after the LAST event, one authoritative refresh runs for the PRs on that head.
// One fetch per quiet period, whatever the burst size — typically once, just
// after CI finishes. Per-process: a restart loses the timer, and the sweep is
// still there behind it.
export const SETTLE_QUIET_MS = 90_000;
const settleTimers = new Map<string, NodeJS.Timeout>();

function armSettleRefresh(repoFullName: string, headSha: string): void {
  const key = `${repoFullName} ${headSha}`;
  const existing = settleTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    settleTimers.delete(key);
    void runSettleRefresh(repoFullName, headSha);
  }, SETTLE_QUIET_MS);
  if (typeof timer.unref === 'function') timer.unref();
  settleTimers.set(key, timer);
}

/** The refresh a quiet commit gets. Exported for tests. */
export async function runSettleRefresh(repoFullName: string, headSha: string): Promise<void> {
  try {
    const targets = await targetsForRepo(repoFullName);
    const repoIds = [...new Set(targets.map((t) => t.repositoryId))];
    const affected = await affectedPrsForSha(repoIds, headSha);
    if (affected.length === 0) return;
    // Lazy: prMonitor → prCache → checkCounts would otherwise be a cycle at
    // module load. One fetch per GitHub ACCOUNT, shared by every workspace on it.
    const { prMonitorService } = await import('./prMonitor.js');
    const byNumber = new Map<number, AffectedPr[]>();
    for (const row of affected) {
      const list = byNumber.get(row.number) ?? [];
      list.push(row);
      byNumber.set(row.number, list);
    }
    for (const [number, rows] of byNumber) {
      await prMonitorService.refreshPrAcrossWorkspaces(
        rows.map((r) => ({
          workspaceId: r.workspaceId,
          owner: r.owner,
          repo: r.repo,
          repositoryId: r.repositoryId,
        })),
        number,
      );
    }
    debugBus.recordEvent({
      service: 'check_counts',
      action: 'settle_refresh',
      ok: true,
      summary: `settle refresh ${repoFullName} ${headSha.slice(0, 7)} → ${affected.length} PR(s)`,
    });
  } catch (err) {
    debugBus.recordEvent({
      service: 'check_counts',
      action: 'settle_refresh',
      ok: false,
      summary: `settle refresh ${repoFullName} ${headSha.slice(0, 7)} failed: ${describeError(err)}`,
    });
  }
}

/** Test helper — cancel every armed settle refresh. */
export function _resetSettleRefresh(): void {
  for (const t of settleTimers.values()) clearTimeout(t);
  settleTimers.clear();
}

/** Test helper — the commits with a settle refresh armed. */
export function _armedSettleRefreshes(): string[] {
  return [...settleTimers.keys()];
}

/**
 * Coalesces the high-volume check firehose by (repo, sha).
 *
 * When a CI run starts, GitHub fires dozens of `check_run` events for the SAME
 * commit within a moment, then dozens of `completed` later. The coalescer
 * buffers them for a short window keyed by `(repoFullName, headSha)`, de-duped
 * to the latest state per check name, then flushes ONCE: one multi-row upsert,
 * one recompute, one UPDATE + broadcast per affected PR that changed.
 *
 * Buffers are per-process. That is safe now because the flush takes the
 * commit's advisory lock and recomputes from ALL stored states, so flushes from
 * two replicas (or two windows in one) serialize and the last one reads
 * everything the others wrote. Before the lock, the older read could land last.
 *
 * Durability: a delivery is acked before its flush lands, so a crash inside the
 * window, or a flush that throws, loses the buffered states. The settle refresh
 * armed on every enqueue is what recovers them.
 */
class CheckCountCoalescer {
  private readonly windowMs: number;
  private pending = new Map<string, { states: Map<string, CheckEventInput>; timer: NodeJS.Timeout }>();

  constructor(windowMs = 750) {
    this.windowMs = windowMs;
  }

  private key(repoFullName: string, headSha: string): string {
    return `${repoFullName} ${headSha}`;
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
    armSettleRefresh(ev.repoFullName, ev.headSha);
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
      const n = await applyEvents(repoFullName, headSha, repoIds, states);
      if (n === 0) return; // sha is no tracked PR's head (yet)
      debugBus.recordEvent({
        service: 'check_counts',
        action: 'incremental',
        ok: true,
        summary: `incremental checks ${repoFullName} ${headSha.slice(0, 7)} ×${states.length} → ${n} PR(s)`,
      });
    } catch (err) {
      debugBus.recordEvent({
        service: 'check_counts',
        action: 'incremental',
        ok: false,
        summary: `coalesced flush ${repoFullName} ${headSha.slice(0, 7)} failed (settle refresh will recover): ${describeError(err)}`,
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
    _resetSettleRefresh();
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
 * rows orphaned by a *missed* delivery, so the table can't grow unbounded.
 * Every full fetch of an open PR touches its rows, so a live PR's ledger is
 * never idle for a day. Returns the number of rows deleted.
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
