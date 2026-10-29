import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { SlackPendingRequest, SlackRepoCandidate, SlackSessionSource } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { slackThreads, slackTriggerMessages } from '../../db/schema.js';

/**
 * Reads and writes for `slack_threads` and `slack_trigger_messages`. All on
 * the pool: the tables are backend-only and event processing has no request.
 */

export type SlackThreadPhase = 'starting' | 'needs_repository' | 'started' | 'failed';

/**
 * A `starting` row older than this is presumed dead (a crash mid-start), so a
 * later trigger may take the thread over. Longer than a start takes: the
 * Slack reads, at most two code searches and the create are each bounded by a
 * 10-30 s timeout.
 */
export const STALE_START_MS = 5 * 60_000;

export const THREAD_COLUMNS = {
  id: slackThreads.id,
  teamId: slackThreads.teamId,
  channelId: slackThreads.channelId,
  threadTs: slackThreads.threadTs,
  userId: slackThreads.userId,
  workspaceId: slackThreads.workspaceId,
  workbenchId: slackThreads.workbenchId,
  phase: slackThreads.phase,
  triggerMessageTs: slackThreads.triggerMessageTs,
  statusReaction: slackThreads.statusReaction,
  lastState: slackThreads.lastState,
  updatedAt: slackThreads.updatedAt,
} as const;

export type SlackThreadRow = Pick<typeof slackThreads.$inferSelect, keyof typeof THREAD_COLUMNS>;

const db = () => getPoolDbClient();

/**
 * Claim a message as a trigger. False when another event already used it (a
 * reaction removed and added again, or a mention and a DM event for one
 * message). True for the first claim and for a retry of the same event.
 */
export async function claimTriggerMessage(input: {
  teamId: string;
  channelId: string;
  messageTs: string;
  eventId: string;
}): Promise<boolean> {
  const inserted = await db()
    .insert(slackTriggerMessages)
    .values(input)
    .onConflictDoNothing()
    .returning({ eventId: slackTriggerMessages.eventId });
  if (inserted.length > 0) return true;
  const existing = await db()
    .select({ eventId: slackTriggerMessages.eventId })
    .from(slackTriggerMessages)
    .where(
      and(
        eq(slackTriggerMessages.teamId, input.teamId),
        eq(slackTriggerMessages.channelId, input.channelId),
        eq(slackTriggerMessages.messageTs, input.messageTs)
      )
    )
    .limit(1);
  return existing[0]?.eventId === input.eventId;
}

export async function getThread(teamId: string, channelId: string, threadTs: string): Promise<SlackThreadRow | null> {
  const rows = await db()
    .select(THREAD_COLUMNS)
    .from(slackThreads)
    .where(and(eq(slackThreads.teamId, teamId), eq(slackThreads.channelId, channelId), eq(slackThreads.threadTs, threadTs)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getThreadById(id: string): Promise<SlackThreadRow | null> {
  const rows = await db().select(THREAD_COLUMNS).from(slackThreads).where(eq(slackThreads.id, id)).limit(1);
  return rows[0] ?? null;
}

/** The thread a session was started from, if it was started from Slack. */
export async function threadForWorkbench(workbenchId: string): Promise<SlackThreadRow | null> {
  const rows = await db().select(THREAD_COLUMNS).from(slackThreads).where(eq(slackThreads.workbenchId, workbenchId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Start (or restart) a thread for `userId`. Inserts a `starting` row, or takes
 * over an existing row of the same user that is not live: one waiting for a
 * repository, a failed one, one whose session was deleted, or a `starting` row
 * past {@link STALE_START_MS}. Null when the thread is busy or belongs to
 * someone else; the caller reads the row to tell which.
 */
export async function beginThread(input: {
  teamId: string;
  channelId: string;
  threadTs: string;
  userId: string;
  workspaceId: string;
  triggerMessageTs: string;
}): Promise<SlackThreadRow | null> {
  const now = new Date();
  const inserted = await db()
    .insert(slackThreads)
    .values({ id: uuid(), ...input, phase: 'starting', createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning(THREAD_COLUMNS);
  if (inserted[0]) return inserted[0];
  const taken = await db()
    .update(slackThreads)
    .set({
      // `trigger_message_ts` stays: the caller moves the status reaction to the
      // new message, which takes ours off the old one first.
      phase: 'starting',
      workspaceId: input.workspaceId,
      workbenchId: null,
      pendingPrompt: null,
      pendingSource: null,
      pendingCandidates: null,
      pendingNamingText: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(slackThreads.teamId, input.teamId),
        eq(slackThreads.channelId, input.channelId),
        eq(slackThreads.threadTs, input.threadTs),
        eq(slackThreads.userId, input.userId),
        or(
          eq(slackThreads.phase, 'needs_repository'),
          eq(slackThreads.phase, 'failed'),
          and(eq(slackThreads.phase, 'started'), isNull(slackThreads.workbenchId)),
          and(eq(slackThreads.phase, 'starting'), lt(slackThreads.updatedAt, new Date(now.getTime() - STALE_START_MS)))
        )
      )
    )
    .returning(THREAD_COLUMNS);
  return taken[0] ?? null;
}

export async function markThreadStarted(
  id: string,
  input: { workbenchId: string; repoReason: string; repoReasonDetail: string }
): Promise<void> {
  await db()
    .update(slackThreads)
    .set({
      phase: 'started',
      workbenchId: input.workbenchId,
      repoReason: input.repoReason,
      repoReasonDetail: input.repoReasonDetail,
      pendingPrompt: null,
      pendingSource: null,
      pendingCandidates: null,
      pendingNamingText: null,
      updatedAt: new Date(),
    })
    .where(eq(slackThreads.id, id));
}

export async function markThreadNeedsRepository(
  id: string,
  input: { prompt: string; namingText: string; source: SlackSessionSource; candidates: SlackRepoCandidate[]; detail: string }
): Promise<void> {
  await db()
    .update(slackThreads)
    .set({
      phase: 'needs_repository',
      pendingPrompt: input.prompt,
      pendingNamingText: input.namingText,
      pendingSource: input.source,
      pendingCandidates: input.candidates,
      repoReason: null,
      repoReasonDetail: input.detail,
      updatedAt: new Date(),
    })
    .where(eq(slackThreads.id, id));
}

export async function markThreadFailed(id: string, detail: string): Promise<void> {
  await db()
    .update(slackThreads)
    .set({ phase: 'failed', repoReasonDetail: detail.slice(0, 1000), updatedAt: new Date() })
    .where(eq(slackThreads.id, id));
}

/**
 * Claim a pending request for starting: `needs_repository` → `starting`, for
 * its own user only. The conditional UPDATE is the claim, so a double click
 * starts one session.
 */
export async function claimPendingThread(
  id: string,
  userId: string
): Promise<{ row: SlackThreadRow; prompt: string; namingText: string | null; source: SlackSessionSource } | null> {
  const rows = await db()
    .update(slackThreads)
    .set({ phase: 'starting', updatedAt: new Date() })
    .where(and(eq(slackThreads.id, id), eq(slackThreads.userId, userId), eq(slackThreads.phase, 'needs_repository')))
    .returning({
      ...THREAD_COLUMNS,
      pendingPrompt: slackThreads.pendingPrompt,
      pendingSource: slackThreads.pendingSource,
      pendingNamingText: slackThreads.pendingNamingText,
    });
  const row = rows[0];
  if (!row || !row.pendingPrompt || !row.pendingSource) return null;
  const { pendingPrompt, pendingSource, pendingNamingText, ...rest } = row;
  return { row: rest, prompt: pendingPrompt, namingText: pendingNamingText, source: pendingSource };
}

/** Put a claimed pending request back, when its start failed for a reason the user can fix. */
export async function releasePendingThread(id: string): Promise<void> {
  await db()
    .update(slackThreads)
    .set({ phase: 'needs_repository', updatedAt: new Date() })
    .where(and(eq(slackThreads.id, id), eq(slackThreads.phase, 'starting')));
}

const PENDING_COLUMNS = {
  id: slackThreads.id,
  workspaceId: slackThreads.workspaceId,
  pendingPrompt: slackThreads.pendingPrompt,
  pendingSource: slackThreads.pendingSource,
  pendingCandidates: slackThreads.pendingCandidates,
  createdAt: slackThreads.createdAt,
} as const;

function toPending(row: {
  id: string;
  workspaceId: string | null;
  pendingPrompt: string | null;
  pendingSource: SlackSessionSource | null;
  pendingCandidates: SlackRepoCandidate[] | null;
  createdAt: Date;
}): SlackPendingRequest | null {
  if (!row.workspaceId || !row.pendingPrompt || !row.pendingSource) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    prompt: row.pendingPrompt,
    source: row.pendingSource,
    candidates: row.pendingCandidates ?? [],
    createdAt: row.createdAt.toISOString(),
  };
}

export async function pendingRequestById(id: string): Promise<SlackPendingRequest | null> {
  const rows = await db().select(PENDING_COLUMNS).from(slackThreads).where(and(eq(slackThreads.id, id), eq(slackThreads.phase, 'needs_repository'))).limit(1);
  return rows[0] ? toPending(rows[0]) : null;
}

/** The caller's requests waiting for a repository, oldest first. */
export async function pendingRequestsFor(userId: string): Promise<SlackPendingRequest[]> {
  const rows = await db()
    .select(PENDING_COLUMNS)
    .from(slackThreads)
    .where(and(eq(slackThreads.userId, userId), eq(slackThreads.phase, 'needs_repository')))
    .orderBy(asc(slackThreads.createdAt));
  return rows.map(toPending).filter((p): p is SlackPendingRequest => p !== null);
}

/**
 * Compare-and-set the status reaction: succeeds only while the row still
 * shows `expected`, so two replicas cannot both swap it (and leave two).
 */
export async function swapStatusReaction(
  id: string,
  expected: { reaction: string | null; messageTs: string },
  next: { reaction: string | null; state: string | null; messageTs?: string }
): Promise<boolean> {
  const rows = await db()
    .update(slackThreads)
    .set({
      statusReaction: next.reaction,
      lastState: next.state,
      ...(next.messageTs ? { triggerMessageTs: next.messageTs } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(slackThreads.id, id),
        eq(slackThreads.triggerMessageTs, expected.messageTs),
        expected.reaction === null ? isNull(slackThreads.statusReaction) : eq(slackThreads.statusReaction, expected.reaction)
      )
    )
    .returning({ id: slackThreads.id });
  return rows.length > 0;
}
