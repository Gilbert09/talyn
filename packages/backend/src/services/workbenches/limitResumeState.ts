import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FleetAgent } from '@talyn/shared';
import { getDbClient, getPoolDbClient } from '../../db/client.js';
import { workbenchChats, workbenchEvents, workbenches, workspaces } from '../../db/schema.js';
import type { ChatRow } from './store.js';

export type CredentialResumeReason = 'limited' | 'reauth' | 'missing' | 'unavailable';

/** Read the saved refusal, so a restart does not depend on error text. */
export async function credentialResumeReason(chat: Pick<ChatRow, 'id' | 'turnCount'>): Promise<CredentialResumeReason | null> {
  const [row] = await getDbClient().select({
    code: sql<string>`${workbenchEvents.event}->>'code'`,
    reason: sql<string>`${workbenchEvents.event}->>'reason'`,
  }).from(workbenchEvents)
    .where(and(eq(workbenchEvents.chatId, chat.id), eq(workbenchEvents.turn, chat.turnCount),
      sql`${workbenchEvents.event}->>'type' = 'result'`))
    .orderBy(desc(workbenchEvents.seq)).limit(1);
  if (row?.code !== 'credentials_unavailable') return null;
  const reason = row.reason;
  return reason === 'limited' || reason === 'reauth' || reason === 'missing' || reason === 'unavailable' ? reason : null;
}

/** A fresh credential makes matching reconnect waits due for the existing sweep. */
export async function wakeCredentialResumes(workspaceId: string, agent: FleetAgent): Promise<void> {
  // Best effort: it runs inside every credential save, token refreshes included,
  // and a failed wake must never fail the save.
  try {
    await wakeCredentialResumesOrThrow(workspaceId, agent);
  } catch (err) {
    console.warn(`[workbench] waking chats that wait for a ${agent} sign-in in ${workspaceId} failed:`, err);
  }
}

async function wakeCredentialResumesOrThrow(workspaceId: string, agent: FleetAgent): Promise<void> {
  // The payer can own a different workspace. These chats need the pool, outside owner RLS.
  const rows = await getPoolDbClient().update(workbenchChats).set({ resumeAt: new Date() })
    .where(and(eq(workbenchChats.agent, agent), eq(workbenchChats.status, 'error'),
      isNotNull(workbenchChats.resumeAt), isNull(workbenchChats.closedAt),
      sql`CASE WHEN ${workbenchChats.payerUserId} IS NOT NULL AND ${workbenchChats.payerWorkspaceId} IS NOT NULL
        THEN ${workbenchChats.payerWorkspaceId} ELSE ${workbenchChats.workspaceId} END = ${workspaceId}`,
      sql`jsonb_array_length(${workbenchChats.queuedMessages}) = 0`,
      sql`EXISTS (SELECT 1 FROM ${workspaces} WHERE ${workspaces.id} = ${workspaceId}
        AND COALESCE(${workspaces.settings}->>'autoResumeOnLimit', 'true') <> 'false')`,
      sql`EXISTS (SELECT 1 FROM ${workbenches} WHERE ${workbenches.id} = ${workbenchChats.workbenchId}
        AND ${workbenches.archivedAt} IS NULL AND ${workbenches.archivePendingAt} IS NULL)`,
      sql`(SELECT ${workbenchEvents.event} FROM ${workbenchEvents}
        WHERE ${workbenchEvents.chatId} = ${workbenchChats.id} AND ${workbenchEvents.turn} = ${workbenchChats.turnCount}
        AND ${workbenchEvents.event}->>'type' = 'result'
        ORDER BY ${workbenchEvents.seq} DESC LIMIT 1) @> '{"code":"credentials_unavailable","reason":"reauth"}'::jsonb`,
    )).returning({ id: workbenchChats.id, workspaceId: workbenchChats.workspaceId });
  if (!rows.length) return;
  // Load the session services only after a write. Accounts also load during session service initialization.
  const { getChat, rowToChat } = await import('./store.js');
  const { emitWorkbenchChat } = await import('./emit.js');
  for (const row of rows) {
    const chat = await getChat(row.id);
    if (chat) emitWorkbenchChat(row.workspaceId, rowToChat(chat));
  }
}
