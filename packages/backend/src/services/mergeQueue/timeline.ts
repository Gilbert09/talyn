import { desc, eq } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { mergeQueueEntries, mergeQueueEvents } from '../../db/schema.js';

/**
 * The merge-queue history of one pull request: the events of its active entry,
 * or of its newest entry when none is active. Newest first, at most
 * {@link TIMELINE_LIMIT}. Shared by the app's timeline route and the public API.
 */

export const TIMELINE_LIMIT = 100;

export interface MergeQueueTimelineEvent {
  at: Date;
  fromStatus: string | null;
  toStatus: string;
  trigger: string;
  code: string | null;
  message: string;
  detail: unknown;
}

export async function mergeQueueTimelineForPr(pullRequestId: string): Promise<MergeQueueTimelineEvent[]> {
  const db = getDbClient();
  const entryRows = await db
    .select({
      id: mergeQueueEntries.id,
      status: mergeQueueEntries.status,
      enqueuedAt: mergeQueueEntries.enqueuedAt,
    })
    .from(mergeQueueEntries)
    .where(eq(mergeQueueEntries.pullRequestId, pullRequestId))
    .orderBy(desc(mergeQueueEntries.enqueuedAt))
    .limit(5);
  const entry = entryRows.find((e) => e.status !== 'merged' && e.status !== 'removed') ?? entryRows[0];
  if (!entry) return [];
  return db
    .select({
      at: mergeQueueEvents.at,
      fromStatus: mergeQueueEvents.fromStatus,
      toStatus: mergeQueueEvents.toStatus,
      trigger: mergeQueueEvents.trigger,
      code: mergeQueueEvents.code,
      message: mergeQueueEvents.message,
      detail: mergeQueueEvents.detail,
    })
    .from(mergeQueueEvents)
    .where(eq(mergeQueueEvents.entryId, entry.id))
    .orderBy(desc(mergeQueueEvents.at))
    .limit(TIMELINE_LIMIT);
}
