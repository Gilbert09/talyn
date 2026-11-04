import { asc, eq, gt, sql } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import { usageInsightsBackfill, workbenchChats } from '../../db/schema.js';
import { withMaintenanceClaim } from '../workbenches/maintenanceClaim.js';
import { bootSampleFromMetric, storeBootSamples, type BootSampleRow } from './bootSamples.js';
import { loadChatFacts, loadTurnFacts, rowsForChat, storeTurnUsageRows } from './turnUsage.js';

/**
 * The one-off backfill of Insights' tables from the events stored before the
 * live writers shipped.
 *
 * It walks `workbench_chats` in id order, a batch of chats per tick, and keeps
 * its cursor in `usage_insights_backfill`. Each batch reads the chats' events
 * ONCE (scalars and the result events' `usage` objects only, never a whole
 * event), so the whole run reads the transcript table once. Rows already there
 * win (`ON CONFLICT DO NOTHING`), so a re-run, an overlap with the live writer,
 * or two replicas cost a repeated read and nothing else. When a batch comes
 * back short the run stamps `completed_at`, and every later tick is one row read.
 */

export const USAGE_INSIGHTS_BACKFILL = 'usage-insights-backfill';

/**
 * Chats per tick. A tick reads every event of these chats; the biggest chats
 * hold a few thousand events, so a batch stays well under the 2-minute claim.
 */
export const BACKFILL_BATCH_CHATS = 40;

const db = () => getPoolDbClient();

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

export interface BackfillTick {
  chats: number;
  turnRows: number;
  bootSamples: number;
  completed: boolean;
}

/** The boot metrics of a batch of chats. Scalars only. */
async function loadBootSamples(chatIds: readonly string[], chats: Map<string, { workspaceId: string; workbenchId: string }>): Promise<BootSampleRow[]> {
  if (chatIds.length === 0) return [];
  const rows = rowsOf<{
    chat_id: string; seq: number | string; created_at: unknown; metric: string | null;
    total_ms: string | null; ms: string | null; ok: string | null; source: string | null; layer: string | null; cause: string | null;
  }>(await db().execute(sql`
    SELECT chat_id, seq, created_at, event ->> 'metric' AS metric,
      event ->> 'totalMs' AS total_ms, event ->> 'ms' AS ms, event ->> 'ok' AS ok,
      event ->> 'from' AS source, event ->> 'layer' AS layer, event ->> 'cause' AS cause
    FROM workbench_events
    WHERE chat_id IN (${sql.join(chatIds.map((id) => sql`${id}`), sql`, `)})
      AND event ->> 'type' = 'system' AND event ->> 'subtype' = 'boot_metric'
      AND event ->> 'metric' IN ('box_created', 'wake_end')
  `));
  const out: BootSampleRow[] = [];
  for (const row of rows) {
    const chat = chats.get(row.chat_id);
    const sample = bootSampleFromMetric(row.metric, {
      totalMs: row.total_ms, ms: row.ms, ok: row.ok, from: row.source, layer: row.layer, cause: row.cause,
    });
    const at = row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at));
    if (!chat || !sample || Number.isNaN(at.getTime())) continue;
    out.push({ ...sample, chatId: row.chat_id, seq: Number(row.seq), workspaceId: chat.workspaceId, workbenchId: chat.workbenchId, at });
  }
  return out;
}

/** One batch. Exported for tests; production runs {@link backfillUsageInsights}. */
export async function backfillBatch(batchSize = BACKFILL_BATCH_CHATS): Promise<BackfillTick> {
  const [state] = await db()
    .select({ cursor: usageInsightsBackfill.cursor, completedAt: usageInsightsBackfill.completedAt })
    .from(usageInsightsBackfill)
    .where(eq(usageInsightsBackfill.name, USAGE_INSIGHTS_BACKFILL))
    .limit(1);
  if (state?.completedAt) return { chats: 0, turnRows: 0, bootSamples: 0, completed: true };

  const batch = await db()
    .select({ id: workbenchChats.id })
    .from(workbenchChats)
    .where(state?.cursor ? gt(workbenchChats.id, state.cursor) : undefined)
    .orderBy(asc(workbenchChats.id))
    .limit(batchSize);
  const ids = batch.map((c) => c.id);

  let turnRows = 0;
  let bootSamples = 0;
  if (ids.length > 0) {
    const [chats, facts] = await Promise.all([loadChatFacts(ids), loadTurnFacts(ids)]);
    const rows = [...facts.entries()].flatMap(([chatId, turns]) => {
      const chat = chats.get(chatId);
      return chat ? rowsForChat(chat, turns) : [];
    });
    turnRows = await storeTurnUsageRows(rows, 'keep');
    bootSamples = await storeBootSamples(await loadBootSamples(ids, chats));
  }

  const completed = ids.length < batchSize;
  const cursor = ids.length > 0 ? ids[ids.length - 1] : state?.cursor ?? null;
  await db()
    .insert(usageInsightsBackfill)
    .values({ name: USAGE_INSIGHTS_BACKFILL, cursor, chatsDone: ids.length, completedAt: completed ? new Date() : null })
    .onConflictDoUpdate({
      target: usageInsightsBackfill.name,
      set: {
        cursor,
        chatsDone: sql`${usageInsightsBackfill.chatsDone} + ${ids.length}`,
        completedAt: completed ? new Date() : null,
        updatedAt: new Date(),
      },
    });
  return { chats: ids.length, turnRows, bootSamples, completed };
}

/** One tick of the maintenance poller: a batch under the shared claim, so one replica works at a time. */
export async function backfillUsageInsights(): Promise<boolean> {
  return withMaintenanceClaim(USAGE_INSIGHTS_BACKFILL, async (renew) => {
    await renew();
    await backfillBatch();
  });
}
