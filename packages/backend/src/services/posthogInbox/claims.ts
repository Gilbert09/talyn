import { and, desc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
import type { PostHogClaimState, PostHogInboxFacts } from '@talyn/shared';
import { parseReportNotFixedSentinel } from '@talyn/shared';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import {
  externalIssueLinks,
  pullRequests,
  tasks,
  workbenchChats,
  workbenchEvents,
  workbenches,
} from '../../db/schema.js';
import { guardCrossReplica } from '../advisoryLock.js';
import { debugBus } from '../debugBus.js';
import { domainEvents } from '../events.js';
import { activeLinksForPullRequest, linkIsLive, settleLink, type IssueLinkRow } from '../inbound/issueLinks.js';
import { PostHogCodeApiError } from '../posthogCode/client.js';
import { TickGuard } from '../tickGuard.js';
import { emitWorkflowRun } from '../websocket.js';
import { sessionActivity } from '../workbenches/prSessions.js';
import { getWorkflowRunWithClaim } from '../workflows/store.js';
import { workflowsKillSwitchPulled } from '../workflowsAccess.js';
import { isPostHogAuthStatus, posthogBackoffMs } from './backoff.js';
import { getPostHogInboxConnection, type PostHogInboxConnection } from './connection.js';

/**
 * Talyn's claim on a PostHog Inbox report, in PostHog.
 *
 * # The lifecycle
 *
 * 1. **Claim, before the session.** `startPostHogInboxSession` takes Talyn's
 *    own link first (`external_issue_links`), then claims the report in
 *    PostHog ({@link claimReportForStart}), and only then creates the
 *    session. A 409 means somebody else holds the report: no session, and the
 *    run is skipped. Any other refusal parks the run and blocks the
 *    connection's claims for the poller's backoff ({@link claimGate}). No
 *    session ever starts without a claim id.
 * 2. **Attach the pull request.** When the session's pull request opens,
 *    {@link syncPostHogClaim} adds its URL to the claim. PostHog's
 *    `pull_requests` is additive and deduplicated, so the write is idempotent.
 *    PostHog resolves the report itself when a linked pull request merges.
 * 3. **Release.** When the work ends without a pull request (the session is
 *    archived, deleted or failed, or the agent ended on
 *    `TALYN_REPORT_NOT_FIXED:`), or the pull request closes without a merge,
 *    Talyn settles its link and releases the claim. PostHog's release has no
 *    reason field, so Talyn keeps the reason on its own link only.
 *
 * # Exactly what is owed, retried
 *
 * `posthog_claim_next_check_at` is the schedule. A live claim is looked at
 * every {@link WATCH_INTERVAL_MS}; a failed write is retried with the
 * poller's backoff ({@link posthogBackoffMs}) up to {@link MAX_SYNC_ATTEMPTS}
 * times. NULL means nothing is owed. The sweep ({@link posthogClaimSweep})
 * reads the due rows; `pr:snapshot` (through the merge listener) and
 * `pr:session` sync a link at once, so the sweep is the backstop, not the
 * fast path.
 */

const db = () => getPoolDbClient();

/** How often the sweep looks at a live claim when nothing is owed. */
export const WATCH_INTERVAL_MS = 2 * 60_000;
/** Failed writes before Talyn stops trying. */
export const MAX_SYNC_ATTEMPTS = 8;
/** A session in `error` this long, with no pull request, counts as failed. */
export const SESSION_ERROR_GRACE_MS = 60 * 60_000;

// ---- Failures and the per-connection gate ----------------------------------

export type ClaimFailureKind = 'conflict' | 'unauthorized' | 'rate_limited' | 'unavailable' | 'invalid';

export interface ClaimFailure {
  kind: ClaimFailureKind;
  status: number | null;
  retryAfterMs: number | null;
  message: string;
}

/**
 * PURE: what a failed claim call means. 409 is PostHog's answer when another
 * actor holds the report, the claim id is stale, or the report's status does
 * not allow it. 400 is a request PostHog will never take.
 */
export function classifyClaimError(err: unknown): ClaimFailure {
  if (err instanceof PostHogCodeApiError) {
    const base = { status: err.status, retryAfterMs: err.retryAfterMs, message: err.message };
    if (err.status === 409) return { ...base, kind: 'conflict' };
    if (isPostHogAuthStatus(err.status)) return { ...base, kind: 'unauthorized' };
    if (err.status === 429) return { ...base, kind: 'rate_limited' };
    if (err.status === 400 || err.status === 404 || err.status === 422) return { ...base, kind: 'invalid' };
    return { ...base, kind: 'unavailable' };
  }
  return { kind: 'unavailable', status: null, retryAfterMs: null, message: err instanceof Error ? err.message : String(err) };
}

/** Whether a failure should stop every claim on the connection for a while. */
function blocksConnection(f: ClaimFailure): boolean {
  return f.kind === 'unauthorized' || f.kind === 'rate_limited' || f.kind === 'unavailable';
}

export interface ClaimGate {
  until: number;
  failure: ClaimFailure;
}

/**
 * Per-connection claim gate, in memory like `githubRateGate`. A replica that
 * restarts forgets it and pays one more refused call, which sets it again.
 */
const gates = new Map<string, ClaimGate>();

export function blockClaims(connectionId: string, failure: ClaimFailure, now = Date.now()): ClaimGate {
  const until = now + posthogBackoffMs(failure.status, failure.retryAfterMs);
  const known = gates.get(connectionId);
  const gate = known && known.until > until ? known : { until, failure };
  gates.set(connectionId, gate);
  return gate;
}

/** The connection's active gate, or null. */
export function claimGate(connectionId: string, now = Date.now()): ClaimGate | null {
  const gate = gates.get(connectionId);
  if (!gate) return null;
  if (gate.until <= now) {
    gates.delete(connectionId);
    return null;
  }
  return gate;
}

/** When the connection's claims may be tried again, or 0. */
export function claimBlockedUntil(connectionId: string | null | undefined, now = Date.now()): number {
  if (!connectionId) return 0;
  return claimGate(connectionId, now)?.until ?? 0;
}

export function _resetClaimGatesForTests(): void {
  gates.clear();
}

// ---- 1. The claim before a session ------------------------------------------

export type StartClaim = { ok: true; claimId: string } | { ok: false; failure: ClaimFailure };

/**
 * Claim the report in PostHog for one run's session, and store the claim id
 * on Talyn's link. A link that already holds a claim (a parked run retried)
 * resumes it with `claim_id`. Never throws.
 */
export async function claimReportForStart(
  connection: Pick<PostHogInboxConnection, 'id' | 'client'>,
  link: Pick<IssueLinkRow, 'id' | 'posthogClaimId'>,
  reportId: string,
  now = new Date()
): Promise<StartClaim> {
  const gate = claimGate(connection.id, now.getTime());
  if (gate) return { ok: false, failure: gate.failure };
  let claimId: string | null | undefined;
  try {
    const res = await connection.client.claimReport(reportId, link.posthogClaimId ? { claim_id: link.posthogClaimId } : {});
    claimId = res?.assignee?.claim_id;
  } catch (err) {
    const failure = classifyClaimError(err);
    if (blocksConnection(failure)) blockClaims(connection.id, failure, now.getTime());
    return { ok: false, failure };
  }
  if (typeof claimId !== 'string' || claimId.length === 0) {
    return {
      ok: false,
      failure: { kind: 'invalid', status: 200, retryAfterMs: null, message: 'PostHog took the claim but sent no claim id.' },
    };
  }
  await db()
    .update(externalIssueLinks)
    .set({
      posthogClaimId: claimId,
      posthogClaimState: 'claimed',
      posthogClaimNextCheckAt: new Date(now.getTime() + WATCH_INTERVAL_MS),
      posthogClaimAttempts: 0,
      posthogClaimError: null,
      posthogClaimUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(externalIssueLinks.id, link.id));
  return { ok: true, claimId };
}

// ---- 2 and 3. Attach and release -------------------------------------------

const SYNC_COLUMNS = {
  id: externalIssueLinks.id,
  workspaceId: externalIssueLinks.workspaceId,
  integration: externalIssueLinks.integration,
  connectionId: externalIssueLinks.connectionId,
  workflowId: externalIssueLinks.workflowId,
  runId: externalIssueLinks.runId,
  externalId: externalIssueLinks.externalId,
  externalKey: externalIssueLinks.externalKey,
  externalUrl: externalIssueLinks.externalUrl,
  facts: externalIssueLinks.facts,
  taskId: externalIssueLinks.taskId,
  workbenchId: externalIssueLinks.workbenchId,
  pullRequestId: externalIssueLinks.pullRequestId,
  status: externalIssueLinks.status,
  statusReason: externalIssueLinks.statusReason,
  createdAt: externalIssueLinks.createdAt,
  posthogClaimId: externalIssueLinks.posthogClaimId,
  posthogClaimState: externalIssueLinks.posthogClaimState,
  posthogClaimPrUrl: externalIssueLinks.posthogClaimPrUrl,
  posthogClaimAttempts: externalIssueLinks.posthogClaimAttempts,
} as const;

type SyncLink = Awaited<ReturnType<typeof readLink>>;

async function readLink(linkId: string) {
  const rows = await db().select(SYNC_COLUMNS).from(externalIssueLinks).where(eq(externalIssueLinks.id, linkId)).limit(1);
  return rows[0] ?? null;
}

/** The claim states in which Talyn still owes PostHog something, or watches. */
const OPEN_STATES: ReadonlySet<string> = new Set<PostHogClaimState>(['claimed', 'pr_attached']);

/** The pull request of the link's work: its own, its session's or its task's. */
async function workPullRequest(link: NonNullable<SyncLink>): Promise<{ url: string; state: string } | null> {
  let prId = link.pullRequestId;
  if (!prId && link.workbenchId) {
    const rows = await db()
      .select({ pullRequestId: workbenches.pullRequestId })
      .from(workbenches)
      .where(eq(workbenches.id, link.workbenchId))
      .limit(1);
    prId = rows[0]?.pullRequestId ?? null;
  }
  if (!prId && link.taskId) {
    const rows = await db().select({ pullRequestId: tasks.pullRequestId }).from(tasks).where(eq(tasks.id, link.taskId)).limit(1);
    prId = rows[0]?.pullRequestId ?? null;
  }
  if (!prId) return null;
  const rows = await db()
    .select({ owner: pullRequests.owner, repo: pullRequests.repo, number: pullRequests.number, state: pullRequests.state })
    .from(pullRequests)
    .where(eq(pullRequests.id, prId))
    .limit(1);
  const pr = rows[0];
  return pr ? { url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`, state: pr.state } : null;
}

/** The closing text of the session's newest turn since the link was made. */
async function lastSessionResult(workbenchId: string, since: Date): Promise<string | null> {
  const rows = await db()
    .select({ text: sql<string | null>`${workbenchEvents.event} ->> 'result'` })
    .from(workbenchEvents)
    .innerJoin(workbenchChats, eq(workbenchChats.id, workbenchEvents.chatId))
    .where(
      and(
        eq(workbenchChats.workbenchId, workbenchId),
        sql`${workbenchEvents.event} ->> 'type' = 'result'`,
        sql`${workbenchEvents.createdAt} >= ${since.toISOString()}::timestamptz`
      )
    )
    .orderBy(desc(workbenchEvents.createdAt), desc(workbenchEvents.seq))
    .limit(1);
  return rows[0]?.text ?? null;
}

/**
 * Why a live-looking session's work on the report has ended without a pull
 * request, beyond what {@link linkIsLive} reads: the agent ended its turn on
 * `TALYN_REPORT_NOT_FIXED:`, or the session has been in `error` for
 * {@link SESSION_ERROR_GRACE_MS}. Null while the work goes on.
 */
export async function sessionStoppedWithoutFix(
  link: Pick<NonNullable<SyncLink>, 'workbenchId' | 'createdAt'>,
  now: Date
): Promise<string | null> {
  if (!link.workbenchId) return null;
  const rows = await db()
    .select({ status: workbenches.status, updatedAt: workbenches.updatedAt })
    .from(workbenches)
    .where(eq(workbenches.id, link.workbenchId))
    .limit(1);
  const session = rows[0];
  if (!session) return null;
  if (session.status === 'error') {
    return now.getTime() - session.updatedAt.getTime() >= SESSION_ERROR_GRACE_MS ? 'the session failed' : null;
  }
  const activity = await sessionActivity(link.workbenchId);
  if (!activity || activity.activity !== 'idle') return null;
  const said = parseReportNotFixedSentinel(await lastSessionResult(link.workbenchId, link.createdAt));
  return said ? `the agent stopped without a fix: ${said.reason}` : null;
}

export type SyncOutcome =
  | 'attached'
  | 'released'
  | 'merged'
  | 'lost'
  | 'watching'
  | 'deferred'
  | 'failed'
  | 'gave_up'
  | 'skipped';

interface ClaimWrite {
  state?: PostHogClaimState;
  prUrl?: string | null;
  reason?: string | null;
  nextCheckAt: Date | null;
  attempts?: number;
  error?: string | null;
}

async function writeClaim(linkId: string, w: ClaimWrite, now: Date): Promise<void> {
  const set: Partial<typeof externalIssueLinks.$inferInsert> = {
    posthogClaimNextCheckAt: w.nextCheckAt,
    updatedAt: now,
  };
  if (w.state !== undefined) {
    set.posthogClaimState = w.state;
    set.posthogClaimUpdatedAt = now;
  }
  if (w.prUrl !== undefined) set.posthogClaimPrUrl = w.prUrl;
  if (w.reason !== undefined) set.posthogClaimReason = w.reason;
  if (w.attempts !== undefined) set.posthogClaimAttempts = w.attempts;
  if (w.error !== undefined) set.posthogClaimError = w.error;
  await db().update(externalIssueLinks).set(set).where(eq(externalIssueLinks.id, linkId));
}

/** Tell the clients the run's claim moved. Best effort. */
async function emitRun(link: NonNullable<SyncLink>): Promise<void> {
  if (!link.runId) return;
  try {
    const run = await getWorkflowRunWithClaim(link.runId);
    if (run) emitWorkflowRun(link.workspaceId, run);
  } catch {
    // The history shows the claim on its next read.
  }
}

/** A failed write: back off, or give up after {@link MAX_SYNC_ATTEMPTS}. */
async function recordWriteFailure(
  link: NonNullable<SyncLink>,
  connectionId: string | null,
  failure: ClaimFailure,
  now: Date
): Promise<SyncOutcome> {
  if (connectionId && blocksConnection(failure)) blockClaims(connectionId, failure, now.getTime());
  const attempts = link.posthogClaimAttempts + 1;
  const gaveUp = attempts >= MAX_SYNC_ATTEMPTS || failure.kind === 'invalid';
  const error = failure.status ? `${failure.status}: ${failure.message}`.slice(0, 300) : failure.message.slice(0, 300);
  await writeClaim(
    link.id,
    {
      attempts,
      error,
      nextCheckAt: gaveUp ? null : new Date(now.getTime() + posthogBackoffMs(failure.status, failure.retryAfterMs)),
    },
    now
  );
  debugBus.recordEvent({
    service: 'workflows',
    action: gaveUp ? 'posthog_claim_gave_up' : 'posthog_claim_write_failed',
    summary: `report ${link.externalId}: ${error}`,
    ok: false,
    workspaceId: link.workspaceId,
  });
  await emitRun(link);
  return gaveUp ? 'gave_up' : 'failed';
}

function factsConnectionId(link: NonNullable<SyncLink>): string | null {
  const facts = link.facts as Partial<PostHogInboxFacts> | null;
  return typeof facts?.connectionId === 'string' ? facts.connectionId : null;
}

/** Whether a newer active link for the same report holds this claim (a stale link taken over). */
async function claimHandedOn(link: NonNullable<SyncLink>): Promise<boolean> {
  if (!link.posthogClaimId) return false;
  const rows = await db()
    .select({ id: externalIssueLinks.id })
    .from(externalIssueLinks)
    .where(
      and(
        eq(externalIssueLinks.workspaceId, link.workspaceId),
        eq(externalIssueLinks.integration, 'posthog_inbox'),
        eq(externalIssueLinks.externalId, link.externalId),
        eq(externalIssueLinks.status, 'active'),
        eq(externalIssueLinks.posthogClaimId, link.posthogClaimId),
        ne(externalIssueLinks.id, link.id)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** Links being synced on this replica, so the sweep and an event never overlap here. */
const inFlight = new Set<string>();

/**
 * Bring one link's PostHog claim in line with Talyn's state: settle the link
 * when its work has ended, then attach, release or mark merged. Idempotent:
 * a repeat finds nothing owed. Never throws.
 */
export async function syncPostHogClaim(linkId: string, now: Date = new Date()): Promise<SyncOutcome> {
  if (inFlight.has(linkId)) return 'skipped';
  inFlight.add(linkId);
  try {
    return await syncOne(linkId, now);
  } catch (err) {
    debugBus.recordEvent({ service: 'workflows', action: 'posthog_claim_sync_error', summary: linkId, ok: false, error: err });
    return 'failed';
  } finally {
    inFlight.delete(linkId);
  }
}

async function syncOne(linkId: string, now: Date): Promise<SyncOutcome> {
  let link = await readLink(linkId);
  if (!link || link.integration !== 'posthog_inbox' || !link.posthogClaimId) return 'skipped';
  const claimId = link.posthogClaimId;
  if (!link.posthogClaimState || !OPEN_STATES.has(link.posthogClaimState)) {
    await writeClaim(link.id, { nextCheckAt: null }, now);
    return 'skipped';
  }

  // Decide whether the work has ended, from Talyn's own rows.
  if (link.status === 'active') {
    const live = await linkIsLive(link, now);
    const stopped = live.live ? await sessionStoppedWithoutFix(link, now) : null;
    if (!live.live) await settleLink(link.id, live.status, live.reason);
    else if (stopped) await settleLink(link.id, 'failed', stopped);
    if (!live.live || stopped) link = (await readLink(linkId)) ?? link;
  }

  const pr = await workPullRequest(link);
  type Want = { kind: 'attach'; url: string; then: PostHogClaimState } | { kind: 'release'; reason: string | null } | { kind: 'watch' } | { kind: 'merged' };
  let want: Want;
  if (link.status === 'done') {
    want = pr && pr.url !== link.posthogClaimPrUrl ? { kind: 'attach', url: pr.url, then: 'merged' } : { kind: 'merged' };
  } else if (link.status === 'failed') {
    want = { kind: 'release', reason: link.statusReason ?? null };
  } else if (pr && pr.url !== link.posthogClaimPrUrl) {
    want = { kind: 'attach', url: pr.url, then: 'pr_attached' };
  } else {
    want = { kind: 'watch' };
  }

  if (want.kind === 'watch') {
    await writeClaim(link.id, { nextCheckAt: new Date(now.getTime() + WATCH_INTERVAL_MS) }, now);
    return 'watching';
  }
  if (want.kind === 'merged') {
    await writeClaim(link.id, { state: 'merged', nextCheckAt: null, error: null }, now);
    await emitRun(link);
    return 'merged';
  }
  if (want.kind === 'release' && (await claimHandedOn(link))) {
    await writeClaim(link.id, { state: 'released', reason: 'a newer run took the claim over', nextCheckAt: null, error: null }, now);
    await emitRun(link);
    return 'released';
  }

  const connectionId = factsConnectionId(link);
  const gate = connectionId ? claimGate(connectionId, now.getTime()) : null;
  if (gate) {
    await writeClaim(link.id, { nextCheckAt: new Date(gate.until + 5_000) }, now);
    return 'deferred';
  }
  const connection = await getPostHogInboxConnection(link.workspaceId);
  if (!connection || (connectionId && connection.id !== connectionId)) {
    return recordWriteFailure(
      link,
      null,
      { kind: 'unauthorized', status: null, retryAfterMs: null, message: 'The PostHog connection cannot claim reports. Connect PostHog again.' },
      now
    );
  }

  try {
    if (want.kind === 'attach') {
      await connection.client.claimReport(link.externalId, { claim_id: claimId, pull_requests: [want.url] });
      await writeClaim(link.id, {
        state: want.then,
        prUrl: want.url,
        attempts: 0,
        error: null,
        nextCheckAt: want.then === 'merged' ? null : new Date(now.getTime() + WATCH_INTERVAL_MS),
      }, now);
      await emitRun(link);
      return want.then === 'merged' ? 'merged' : 'attached';
    }
    await connection.client.claimReport(link.externalId, { claim_id: claimId, release: true });
    await writeClaim(link.id, { state: 'released', reason: want.reason, attempts: 0, error: null, nextCheckAt: null }, now);
    await emitRun(link);
    return 'released';
  } catch (err) {
    const failure = classifyClaimError(err);
    if (failure.kind === 'conflict') {
      // PostHog no longer holds this claim for Talyn: somebody took the report
      // over, or PostHog closed the work itself (a closed pull request
      // suppresses the report). Nothing more to send.
      if (want.kind === 'release') {
        await writeClaim(link.id, { state: 'released', reason: want.reason ? `${want.reason} (PostHog had already ended the claim)` : 'PostHog had already ended the claim', error: null, nextCheckAt: null }, now);
        await emitRun(link);
        return 'released';
      }
      if (want.then === 'merged') {
        await writeClaim(link.id, { state: 'merged', error: null, nextCheckAt: null }, now);
        await emitRun(link);
        return 'merged';
      }
      await writeClaim(link.id, { state: 'lost', reason: 'somebody else took the report over', error: null, nextCheckAt: null }, now);
      await emitRun(link);
      return 'lost';
    }
    return recordWriteFailure(link, connection.id, failure, now);
  }
}

// ---- The sweep, and the fast paths -------------------------------------------

const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_BATCH = 25;

/** The query behind the sweep. Exported for the egress test. */
export function dueClaimsQuery(now: Date, limit: number) {
  return db()
    .select({ id: externalIssueLinks.id })
    .from(externalIssueLinks)
    .where(
      and(
        lte(externalIssueLinks.posthogClaimNextCheckAt, now),
        eq(externalIssueLinks.integration, 'posthog_inbox'),
        inArray(externalIssueLinks.posthogClaimState, ['claimed', 'pr_attached'])
      )
    )
    .orderBy(externalIssueLinks.posthogClaimNextCheckAt)
    .limit(limit);
}

class PostHogClaimSweep {
  private timer: NodeJS.Timeout | null = null;
  private guard = new TickGuard('posthog_claim_sweep', 5 * 60_000);

  init(): void {
    if (this.timer) return;
    debugBus.registerPoller(
      'posthog_claim_sweep',
      SWEEP_INTERVAL_MS,
      'PostHog Inbox claims: attaches a session\'s pull request to its claim in PostHog, and releases the claim when the work ends without one.'
    );
    this.timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests. Returns the number of links looked at. */
  async tick(now: Date = new Date()): Promise<number> {
    // The deployment-wide break glass only, like the retry sweep: a claim
    // Talyn already holds is released even when a workspace leaves the flag.
    if (workflowsKillSwitchPulled()) return 0;
    if (!this.guard.tryBegin()) return 0;
    const startedAt = Date.now();
    try {
      const outcome = await guardCrossReplica(
        'posthog_claim_sweep:tick',
        async () => {
          const due = await dueClaimsQuery(now, SWEEP_BATCH);
          for (const row of due) await syncPostHogClaim(row.id, now);
          return due.length;
        },
        { maxHoldMs: this.guard.maxMs }
      );
      debugBus.pollerTick('posthog_claim_sweep', { durationMs: Date.now() - startedAt, ok: true });
      return outcome.acquired ? (outcome.result ?? 0) : 0;
    } catch (err) {
      debugBus.pollerTick('posthog_claim_sweep', { durationMs: Date.now() - startedAt, ok: false, error: err });
      return 0;
    } finally {
      this.guard.end();
    }
  }
}

export const posthogClaimSweep = new PostHogClaimSweep();

/** Sync the PostHog claims of the work on one pull request. Never throws. */
export async function syncPostHogClaimsForPullRequest(workspaceId: string, pullRequestId: string): Promise<number> {
  try {
    const links = (await activeLinksForPullRequest(workspaceId, pullRequestId)).filter(
      (l) => l.integration === 'posthog_inbox' && l.posthogClaimId
    );
    for (const link of links) await syncPostHogClaim(link.id);
    return links.length;
  } catch (err) {
    debugBus.recordEvent({ service: 'workflows', action: 'posthog_claim_sync_error', summary: pullRequestId, ok: false, error: err });
    return 0;
  }
}

let listening = false;

/** Start the sweep and listen for sessions that link a pull request. Called once at boot. */
export function initPostHogClaimSweep(): void {
  runWithoutScope(() => posthogClaimSweep.init());
  if (listening) return;
  listening = true;
  // A session's turn ended with a pull request, or its hold on one changed:
  // attach it now rather than on the next sweep.
  domainEvents.on('pr:session', (evt) => {
    void runWithoutScope(() => syncPostHogClaimsForPullRequest(evt.workspaceId, evt.prId));
  });
}
