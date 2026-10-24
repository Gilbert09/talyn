import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
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
