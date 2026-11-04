import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { WorkbenchStatus } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { pullRequests as prTable, workbenches as workbenchesTable } from '../../db/schema.js';
import { emitPullRequestUpdated } from '../websocket.js';
import { domainEvents } from '../events.js';

/** The live session on a pull request, as the pull-request payload carries it. */
export interface PrSession {
  id: string;
  name: string;
  status: WorkbenchStatus;
}

const SESSION_COLUMNS = {
  id: workbenchesTable.id,
  name: workbenchesTable.name,
  status: workbenchesTable.status,
  pullRequestId: workbenchesTable.pullRequestId,
} as const;

/** The query behind the lookup, exposed for the egress test. */
export function liveWorkbenchesForPrsQuery(workspaceIds: string[], prIds: string[]) {
  return getPoolDbClient()
    .select(SESSION_COLUMNS)
    .from(workbenchesTable)
    .where(
      and(
        inArray(workbenchesTable.workspaceId, workspaceIds),
        inArray(workbenchesTable.pullRequestId, prIds),
        isNull(workbenchesTable.archivedAt)
      )
    )
    .orderBy(desc(workbenchesTable.updatedAt));
}

/**
 * The live (non-archived) session linked to each pull request, in one indexed
 * query. When several sessions share a PR the most recently updated wins.
 * Degrades to an empty map: a missing chip must not fail the list.
 */
export async function liveWorkbenchesForPrs(
  workspaceIds: string | string[],
  prIds: string[]
): Promise<Map<string, PrSession>> {
  const out = new Map<string, PrSession>();
  const workspaces = Array.isArray(workspaceIds) ? workspaceIds : [workspaceIds];
  if (!prIds.length || !workspaces.length) return out;
  try {
    for (const r of await liveWorkbenchesForPrsQuery(workspaces, prIds)) {
      if (r.pullRequestId && !out.has(r.pullRequestId)) {
        out.set(r.pullRequestId, { id: r.id, name: r.name, status: r.status as WorkbenchStatus });
      }
    }
  } catch (err) {
    console.warn('[workbenches] live session lookup failed:', err instanceof Error ? err.message : err);
  }
  return out;
}

export async function liveWorkbenchForPr(workspaceId: string, prId: string): Promise<PrSession | null> {
  return (await liveWorkbenchesForPrs(workspaceId, [prId])).get(prId) ?? null;
}

/**
 * What a live session does on its pull request NOW. Only `working` holds the
 * merge queue back.
 *
 * - `working`: a chat runs a turn, has queued messages (a message that waits
 *   for a sandbox carries `capacityWait` and stays in the queue), or the
 *   session is provisioning or moving.
 * - `idle`: ready, and no chat has work. Asleep is idle too: a message wakes it.
 * - `local`: runs on the person's computer. The backend cannot see its turns
 *   or send it a message.
 * - `unavailable`: in error, or archived. It cannot take a message.
 */
export type PrSessionActivity = 'working' | 'idle' | 'local' | 'unavailable';

export function classifySessionActivity(input: {
  status: string;
  runtime: string;
  archived: boolean;
  chatBusy: boolean;
}): PrSessionActivity {
  if (input.archived) return 'unavailable';
  if (input.runtime === 'local') return 'local';
  if (input.status === 'provisioning' || input.status === 'moving') return 'working';
  if (input.status === 'ready') return input.chatBusy ? 'working' : 'idle';
  return 'unavailable';
}

/** The query behind {@link sessionActivity}, exposed for the egress test. */
export function sessionActivityQuery(workbenchId: string) {
  return getPoolDbClient()
    .select({
      status: workbenchesTable.status,
      runtime: workbenchesTable.runtime,
      archived: sql<boolean>`${workbenchesTable.archivedAt} IS NOT NULL`,
      // Derived in SQL: the queue blob never ships. Raw, aliased SQL because
      // drizzle leaves a column in a subquery unqualified.
      chatBusy: sql<boolean>`EXISTS (
        SELECT 1 FROM workbench_chats c
        WHERE c.workbench_id = ${workbenchId}
          AND (c.status = 'running' OR jsonb_array_length(c.queued_messages) > 0)
      )`,
      lastActivityAt: sql<string | Date | null>`(
        SELECT max(COALESCE(c.turn_heartbeat_at, c.updated_at))
        FROM workbench_chats c WHERE c.workbench_id = ${workbenchId}
      )`,
    })
    .from(workbenchesTable)
    .where(eq(workbenchesTable.id, workbenchId))
    .limit(1);
}

/**
 * Whether a session works its pull request now, and when a chat last moved.
 * Null when the session is gone. A failed read answers `working`: holding
 * the queue back for one more evaluation is cheap, and a second agent on the
 * branch is not.
 */
export async function sessionActivity(
  workbenchId: string
): Promise<{ activity: PrSessionActivity; lastActivityAt: string | null } | null> {
  try {
    const [row] = await sessionActivityQuery(workbenchId);
    if (!row) return null;
    const last = row.lastActivityAt ? new Date(row.lastActivityAt) : null;
    return {
      activity: classifySessionActivity({
        status: row.status,
        runtime: row.runtime,
        archived: Boolean(row.archived),
        chatBusy: Boolean(row.chatBusy),
      }),
      lastActivityAt: last && !Number.isNaN(last.getTime()) ? last.toISOString() : null,
    };
  } catch (err) {
    console.warn('[workbenches] session activity read failed:', err instanceof Error ? err.message : err);
    return { activity: 'working', lastActivityAt: null };
  }
}

/** The live session on a pull request with what it does now, for the merge queue. */
export async function liveSessionActivityForPr(
  workspaceId: string,
  prId: string
): Promise<(PrSession & { activity: PrSessionActivity }) | null> {
  const session = await liveWorkbenchForPr(workspaceId, prId);
  if (!session) return null;
  const state = await sessionActivity(session.id);
  // Archived between the two reads: no longer live.
  if (!state) return null;
  return { ...session, activity: state.activity };
}

/**
 * Why a background fix run did not start. One sentence, shown as the merge
 * queue's blocked reason, the auto-keep note and the workflow history.
 */
export function sessionHoldReason(name: string): string {
  return (
    `The session "${name}" is working on this pull request, so Talyn starts no fix run of its own. ` +
    'Archive the session to hand the pull request back.'
  );
}

/** Why a manual Fix was sent to the session rather than started as a task. */
export function prHasSessionMessage(name: string): string {
  return `The session "${name}" is working on this pull request. Send the fix from that session.`;
}

/** The 409 a manual fix gets when a live session works the PR. */
export function prHasSessionBody(session: PrSession) {
  return {
    success: false as const,
    code: 'pr_has_session',
    error: prHasSessionMessage(session.name),
    workbenchId: session.id,
    name: session.name,
  };
}

/**
 * Ask the background fixers (merge queue, auto-keep) to look at a pull request
 * again: a session's turn ended, or its hold on the PR changed.
 */
export function notifyPrSessionChanged(workspaceId: string, prId: string, trigger: string): void {
  try {
    domainEvents.emit('pr:session', { workspaceId, prId, trigger });
  } catch (err) {
    console.warn('[workbenches] pr:session listener failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Tell the clients which session (if any) now works a pull request. Recomputed
 * from the table rather than taken from the caller, so two sessions on one PR
 * cannot disagree. `null` is a real value: it clears the chip.
 */
export async function emitPrSession(workspaceId: string, prId: string): Promise<void> {
  notifyPrSessionChanged(workspaceId, prId, 'session:changed');
  try {
    const [pr] = await getPoolDbClient()
      .select({
        id: prTable.id,
        taskId: prTable.taskId,
        repositoryId: prTable.repositoryId,
        owner: prTable.owner,
        repo: prTable.repo,
        number: prTable.number,
        state: prTable.state,
        lastSummary: prTable.lastSummary,
      })
      .from(prTable)
      .where(and(eq(prTable.id, prId), eq(prTable.workspaceId, workspaceId)))
      .limit(1);
    if (!pr) return;
    emitPullRequestUpdated(workspaceId, {
      ...pr,
      lastSummary: (pr.lastSummary ?? {}) as Record<string, unknown>,
      session: await liveWorkbenchForPr(workspaceId, prId),
    });
  } catch (err) {
    console.warn('[workbenches] broadcasting the PR session failed:', err instanceof Error ? err.message : err);
  }
}
