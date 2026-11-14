import { v4 as uuid } from 'uuid';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { IssueEventFacts, IssueWorkflowIntegration, PostHogInboxFacts } from '@talyn/shared';
import { TERMINAL_TASK_STATUSES } from '@talyn/shared';
import { getPoolDbClient, type Database } from '../../db/client.js';
import {
  externalIssueLinks,
  pullRequests,
  tasks,
  workbenches,
  workflowRuns,
} from '../../db/schema.js';

/**
 * `external_issue_links`: the session or task an issue rule started for one
 * issue.
 *
 * A start action claims the issue BEFORE it dispatches. The partial UNIQUE on
 * active rows is the guard: a second event on the same issue finds the claim
 * and refuses with `issue_already_running`.
 *
 * A link ends one of two ways. The work's pull request merges: the merge
 * listener (`onMerge.ts`) writes back and marks it `done`. Or the work ends
 * without a merge: the link is `failed`, and a later event can start again.
 * "Ended without a merge" is decided when the next event arrives
 * ({@link linkIsLive}), so no archive, delete or failure path has to remember
 * to release the issue:
 *  - a task that is terminal with no pull request, or whose pull request closed;
 *  - a session that is archived or deleted with no open pull request;
 *  - a claim with no task or session whose run is not still owed.
 *
 * Backend-pool only (no RLS policy, no grant). Every read names its columns.
 */

const db = (): Database => getPoolDbClient();

/**
 * How long a claim with no task or session counts as in flight when its run
 * says nothing. A start waits up to 45 s on the fleet, and a crashed delivery
 * is retried after 2 minutes. 10 minutes covers both with room.
 */
export const UNATTACHED_CLAIM_GRACE_MS = 10 * 60_000;

/**
 * The integrations whose rules claim one external item per piece of work:
 * the issue trackers, and PostHog Inbox (one report).
 */
export type LinkedWorkIntegration = IssueWorkflowIntegration | 'posthog_inbox';

/** The facts of an item a start action can claim. */
export type LinkableFacts = IssueEventFacts | PostHogInboxFacts;

/** The facts a link keeps: no long text, which the merge write-back never reads. */
export function linkFacts(facts: IssueEventFacts): IssueEventFacts;
export function linkFacts(facts: PostHogInboxFacts): PostHogInboxFacts;
export function linkFacts(facts: LinkableFacts): LinkableFacts;
export function linkFacts(facts: LinkableFacts): LinkableFacts {
  if (facts.integration === 'posthog_inbox') return { ...facts, summary: '' };
  const { comment: _comment, ...rest } = facts;
  return { ...rest, body: '' };
}

/** The columns a claim writes for one item. */
function linkSubject(facts: LinkableFacts): {
  integration: LinkedWorkIntegration;
  connectionId: string | null;
  externalId: string;
  externalKey: string;
  externalUrl: string;
} {
  if (facts.integration === 'posthog_inbox') {
    // `connection_id` references inbound_connections. A PostHog connection is
    // an `integrations` row, so it stays null; the facts keep it.
    return {
      integration: 'posthog_inbox',
      connectionId: null,
      externalId: facts.reportId,
      externalKey: facts.title.slice(0, 200) || facts.reportId,
      externalUrl: facts.url,
    };
  }
  return {
    integration: facts.integration,
    connectionId: facts.connectionId,
    externalId: facts.externalId,
    externalKey: facts.identifier,
    externalUrl: facts.url,
  };
}

export const LINK_COLUMNS = {
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
  createdAt: externalIssueLinks.createdAt,
} as const;

export type IssueLinkRow = Pick<typeof externalIssueLinks.$inferSelect, keyof typeof LINK_COLUMNS>;

export type IssueClaim =
  | { claimed: true; link: IssueLinkRow }
  | { claimed: false; link: IssueLinkRow | null };

/** The active link of one issue, or null. */
export async function activeLink(
  workspaceId: string,
  integration: LinkedWorkIntegration,
  externalId: string
): Promise<IssueLinkRow | null> {
  const rows = await db()
    .select(LINK_COLUMNS)
    .from(externalIssueLinks)
    .where(
      and(
        eq(externalIssueLinks.workspaceId, workspaceId),
        eq(externalIssueLinks.integration, integration),
        eq(externalIssueLinks.externalId, externalId),
        eq(externalIssueLinks.status, 'active')
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Claim an issue for one run's start action.
 *
 * `claimed: true` when this run holds the issue now: a new claim, or the
 * run's own claim from an earlier attempt (a parked run retried). A stale
 * claim (see {@link linkIsLive}) is released and taken over.
 */
export async function claimIssue(input: {
  workspaceId: string;
  workflowId: string;
  runId: string;
  facts: LinkableFacts;
  now?: Date;
}): Promise<IssueClaim> {
  const { facts } = input;
  const subject = linkSubject(facts);
  // Two tries: the second follows the release of a stale claim.
  for (let attempt = 0; attempt < 2; attempt++) {
    const inserted = await db()
      .insert(externalIssueLinks)
      .values({
        id: uuid(),
        workspaceId: input.workspaceId,
        integration: subject.integration,
        connectionId: subject.connectionId,
        workflowId: input.workflowId,
        runId: input.runId,
        externalId: subject.externalId,
        externalKey: subject.externalKey,
        externalUrl: subject.externalUrl,
        facts: linkFacts(facts),
      })
      .onConflictDoNothing({
        target: [externalIssueLinks.workspaceId, externalIssueLinks.integration, externalIssueLinks.externalId],
        where: sql`${externalIssueLinks.status} = 'active'`,
      })
      .returning(LINK_COLUMNS);
    if (inserted[0]) return { claimed: true, link: inserted[0] };

    const existing = await activeLink(input.workspaceId, subject.integration, subject.externalId);
    if (!existing) continue; // Settled between the insert and the read.
    if (existing.runId === input.runId) return { claimed: true, link: existing };
    const live = await linkIsLive(existing, input.now ?? new Date());
    if (live.live) return { claimed: false, link: existing };
    await settleLink(existing.id, live.status, live.reason);
  }
  return { claimed: false, link: await activeLink(input.workspaceId, subject.integration, subject.externalId) };
}

/** Attach the started work to a claim. Best effort: a link with no work is released later. */
export async function attachWork(
  linkId: string,
  work: { taskId?: string | null; workbenchId?: string | null; pullRequestId?: string | null }
): Promise<void> {
  const set: Partial<typeof externalIssueLinks.$inferInsert> = { updatedAt: new Date() };
  if (work.taskId) set.taskId = work.taskId;
  if (work.workbenchId) set.workbenchId = work.workbenchId;
  if (work.pullRequestId) set.pullRequestId = work.pullRequestId;
  await db().update(externalIssueLinks).set(set).where(eq(externalIssueLinks.id, linkId));
}

/**
 * Settle a link. Only an ACTIVE link moves: the update is the compare-and-set,
 * so two replicas cannot both settle it. Returns whether this call did.
 */
export async function settleLink(
  linkId: string,
  status: 'done' | 'failed',
  reason: string | null = null
): Promise<boolean> {
  const now = new Date();
  const rows = await db()
    .update(externalIssueLinks)
    .set({ status, statusReason: reason, settledAt: now, updatedAt: now })
    .where(and(eq(externalIssueLinks.id, linkId), eq(externalIssueLinks.status, 'active')))
    .returning({ id: externalIssueLinks.id });
  return rows.length > 0;
}

/** Record a comment Talyn wrote on the issue, so a rule never triggers on it. */
export async function recordOurComment(linkId: string, commentId: string): Promise<void> {
  await db()
    .update(externalIssueLinks)
    .set({
      ourCommentIds: sql`${externalIssueLinks.ourCommentIds} || jsonb_build_array(${commentId}::text)`,
      updatedAt: new Date(),
    })
    .where(eq(externalIssueLinks.id, linkId));
}

/**
 * The newest link of one issue, any status. A write-back with no link of its
 * own (a rule that only comments) records its comment id here.
 */
export async function latestLinkId(
  workspaceId: string,
  integration: IssueWorkflowIntegration,
  externalId: string
): Promise<string | null> {
  const rows = await db()
    .select({ id: externalIssueLinks.id })
    .from(externalIssueLinks)
    .where(
      and(
        eq(externalIssueLinks.workspaceId, workspaceId),
        eq(externalIssueLinks.integration, integration),
        eq(externalIssueLinks.externalId, externalId)
      )
    )
    .orderBy(desc(externalIssueLinks.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** The query behind {@link isOurComment}. Exported for the egress test. */
export function ourCommentQuery(integration: IssueWorkflowIntegration, externalId: string, commentId: string) {
  return db()
    .select({ id: externalIssueLinks.id })
    .from(externalIssueLinks)
    .where(
      and(
        eq(externalIssueLinks.integration, integration),
        eq(externalIssueLinks.externalId, externalId),
        sql`${externalIssueLinks.ourCommentIds} ? ${commentId}`
      )
    )
    .limit(1);
}

/** Whether Talyn wrote this comment on this issue. */
export async function isOurComment(
  integration: IssueWorkflowIntegration,
  externalId: string,
  commentId: string
): Promise<boolean> {
  return (await ourCommentQuery(integration, externalId, commentId)).length > 0;
}

export type Liveness = { live: true } | { live: false; status: 'done' | 'failed'; reason: string };

const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_TASK_STATUSES);

/**
 * Whether the work a link names is still going, so a new event must wait.
 *
 * Read from the structured rows only (the task, the session, their pull
 * request), never from text.
 */
export async function linkIsLive(link: IssueLinkRow, now: Date): Promise<Liveness> {
  const prState = async (id: string | null): Promise<string | null> => {
    if (!id) return null;
    const rows = await db().select({ state: pullRequests.state }).from(pullRequests).where(eq(pullRequests.id, id)).limit(1);
    return rows[0]?.state ?? null;
  };
  const byPr = (state: string | null, ifNone: Liveness): Liveness => {
    if (state === 'open') return { live: true };
    if (state === 'merged') return { live: false, status: 'done', reason: 'the pull request merged' };
    if (state === 'closed') return { live: false, status: 'failed', reason: 'the pull request closed without a merge' };
    return ifNone;
  };

  if (link.taskId) {
    const rows = await db()
      .select({ status: tasks.status, pullRequestId: tasks.pullRequestId })
      .from(tasks)
      .where(eq(tasks.id, link.taskId))
      .limit(1);
    const task = rows[0];
    if (!task) return { live: false, status: 'failed', reason: 'the task was deleted' };
    const state = await prState(link.pullRequestId ?? task.pullRequestId);
    if (state) return byPr(state, { live: true });
    return TERMINAL.has(task.status)
      ? { live: false, status: 'failed', reason: `the task ended (${task.status}) without a pull request` }
      : { live: true };
  }

  if (link.workbenchId) {
    const rows = await db()
      .select({ archivedAt: workbenches.archivedAt, pullRequestId: workbenches.pullRequestId })
      .from(workbenches)
      .where(eq(workbenches.id, link.workbenchId))
      .limit(1);
    const session = rows[0];
    if (!session) return { live: false, status: 'failed', reason: 'the session was deleted' };
    const state = await prState(link.pullRequestId ?? session.pullRequestId);
    if (state) return byPr(state, { live: true });
    return session.archivedAt
      ? { live: false, status: 'failed', reason: 'the session was archived without a pull request' }
      : { live: true };
  }

  // No work attached: the start is in flight, parked, or it died part way.
  if (link.runId) {
    const rows = await db()
      .select({ status: workflowRuns.status })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, link.runId))
      .limit(1);
    if (rows[0]?.status === 'pending_retry') return { live: true };
  }
  if (now.getTime() - link.createdAt.getTime() < UNATTACHED_CLAIM_GRACE_MS) return { live: true };
  return { live: false, status: 'failed', reason: 'the work never started' };
}

/**
 * The query behind {@link activeLinksForPullRequest}. Exported for the egress
 * test. A link finds its pull request three ways, all structured: its own
 * `pull_request_id`, its task's, or its session's. Never a text search.
 */
export function activeLinksForPullRequestQuery(workspaceId: string, pullRequestId: string) {
  return db()
    .select(LINK_COLUMNS)
    .from(externalIssueLinks)
    .where(
      and(
        eq(externalIssueLinks.workspaceId, workspaceId),
        eq(externalIssueLinks.status, 'active'),
        or(
          eq(externalIssueLinks.pullRequestId, pullRequestId),
          inArray(
            externalIssueLinks.taskId,
            db().select({ id: tasks.id }).from(tasks).where(eq(tasks.pullRequestId, pullRequestId))
          ),
          inArray(
            externalIssueLinks.workbenchId,
            db()
              .select({ id: workbenches.id })
              .from(workbenches)
              .where(eq(workbenches.pullRequestId, pullRequestId))
          )
        )
      )
    );
}

export async function activeLinksForPullRequest(workspaceId: string, pullRequestId: string): Promise<IssueLinkRow[]> {
  return activeLinksForPullRequestQuery(workspaceId, pullRequestId);
}
