import { and, asc, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { MobileNotificationCategory, MobileNotificationDestination } from '@talyn/shared';
import { getPoolDbClient, type Database } from '../db/client.js';
import { mergeQueueEntries, mobileNotificationSourceEvents, pullRequests, workbenchChats, workbenches } from '../db/schema.js';
import { enqueueMobileNotification } from './mobileNotifications/store.js';

export { mobileNotificationSourceEvents } from '../db/schema.js';

export async function notificationStillActionable(
  category: MobileNotificationCategory,
  destination: MobileNotificationDestination,
  db: Database = getPoolDbClient(),
): Promise<boolean> {
  if (destination.kind === 'pull_request') {
    const [row] = await db.select({ state: pullRequests.state, summary: pullRequests.lastSummary,
      requested: pullRequests.reviewRequested, authored: pullRequests.authored, watching: pullRequests.watching })
      .from(pullRequests).where(and(eq(pullRequests.id, destination.entityId), eq(pullRequests.workspaceId, destination.workspaceId)));
    if (!row || row.state !== 'open') return false;
    const summary = row.summary && typeof row.summary === 'object' && !Array.isArray(row.summary)
      ? row.summary as Record<string, unknown> : {};
    if (category === 'human_gate') {
      if (Array.isArray(summary.humanGates) && summary.humanGates.length > 0 && (row.requested || row.authored || row.watching)) return true;
      const [gate] = await db.select({ id: mergeQueueEntries.id }).from(mergeQueueEntries).where(and(
        eq(mergeQueueEntries.pullRequestId, destination.entityId), eq(mergeQueueEntries.workspaceId, destination.workspaceId),
        inArray(mergeQueueEntries.status, ['blocked', 'blocked_manual']),
        inArray(mergeQueueEntries.blockedCode, ['agent_needs_human', 'code_review_blocker']),
      )).limit(1);
      return !!gate;
    }
    if (!(row.requested || row.authored || row.watching)) return false;
    if (category === 'ci_failure') return summary.ciStatus === 'failing_required' || summary.blockingReason === 'checks_failed';
    if (category === 'merge_ready') return summary.blockingReason === 'mergeable' && summary.draft !== true;
    if (category === 'pr_review') return row.requested || ['APPROVED', 'CHANGES_REQUESTED'].includes(summary.reviewDecision as string);
    return false;
  }
  const [row] = await db.select({ id: workbenches.id }).from(workbenches).where(and(
    eq(workbenches.id, destination.entityId), eq(workbenches.workspaceId, destination.workspaceId), eq(workbenches.kind, destination.kind),
    isNull(workbenches.archivedAt),
  ));
  if (!row) return false;
  if (category === 'human_gate') {
    const [chat] = await db.select({ id: workbenchChats.id }).from(workbenchChats).where(and(
      eq(workbenchChats.workbenchId, row.id), eq(workbenchChats.status, 'awaiting_input'), isNull(workbenchChats.closedAt),
    )).limit(1);
    return !!chat;
  }
  return category === 'session_update';
}

/** Journal consumption and outbox creation commit together. A crash replays the row safely. */
export async function reconcileMobileNotificationEvents(db: Database = getPoolDbClient()): Promise<number> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await db.delete(mobileNotificationSourceEvents).where(lt(mobileNotificationSourceEvents.createdAt, cutoff));
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(mobileNotificationSourceEvents)
      .orderBy(asc(mobileNotificationSourceEvents.createdAt), asc(mobileNotificationSourceEvents.id))
      .limit(100).for('update', { skipLocked: true });
    for (const row of rows) {
      const destination: MobileNotificationDestination = {
        kind: row.destinationKind, workspaceId: row.workspaceId, entityId: row.entityId,
      };
      if (await notificationStillActionable(row.category, destination, tx as unknown as Database)) {
        await enqueueMobileNotification({ eventId: row.id, ownerId: row.ownerId, workspaceId: row.workspaceId,
          category: row.category, destination, deduplicationKey: row.deduplicationKey,
          expiresAt: new Date(row.createdAt.getTime() + 24 * 60 * 60 * 1000),
        }, tx as unknown as Database);
      }
    }
    if (rows.length) await tx.delete(mobileNotificationSourceEvents).where(inArray(mobileNotificationSourceEvents.id, rows.map((row) => row.id)));
    return rows.length;
  });
}
