import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { getDbClient, runWithoutScope } from '../../db/client.js';
import { workbenchChats as chats, workbenches, workspaces } from '../../db/schema.js';
import { guardCrossReplica } from '../advisoryLock.js';
import { debugBus } from '../debugBus.js';
import { isWorkbenchDraining } from './ownership.js';
import { exhaustedAgentFrom, rateLimitedAgentFrom } from '../selfHosted/exhaustedQuota.js';
import { chatLimitAgent, handleChatLimit, MAX_CREDENTIAL_RETRIES } from './limitResume.js';
import { credentialResumeReason } from './limitResumeState.js';
import { emitWorkbenchChat } from './emit.js';
import { CHAT_COLUMNS, rowToChat } from './store.js';

const POLLER = 'chat_limit_resume';
export const LIMIT_RESUME_SWEEP_BUDGET_MS = 60_000;
let timer: NodeJS.Timeout | undefined;
let ticking = false;

/** Seed recent failures. The reason also records that a person cancelled a wait. */
export async function backfillChatLimits(now = new Date()): Promise<number> {
  const db = getDbClient();
  const rows = await db.select(CHAT_COLUMNS).from(chats)
    .innerJoin(workbenches, eq(chats.workbenchId, workbenches.id))
    .innerJoin(workspaces, sql`${workspaces.id} = CASE
      WHEN ${chats.payerUserId} IS NOT NULL AND ${chats.payerWorkspaceId} IS NOT NULL
      THEN ${chats.payerWorkspaceId} ELSE ${chats.workspaceId} END`)
    .where(and(eq(chats.status, 'error'), isNull(chats.resumeAt), isNull(chats.closedAt),
      isNull(workbenches.archivedAt), eq(workbenches.runtime, 'sandbox'),
      gte(chats.updatedAt, new Date(now.getTime() - 48 * 60 * 60_000)),
      sql`COALESCE(${workspaces.settings}->>'autoResumeOnLimit', 'true') <> 'false'`,
      sql`${chats.resumeReason} IS DISTINCT FROM ''`, sql`jsonb_array_length(${chats.queuedMessages}) = 0`));
  let count = 0;
  for (const chat of rows) {
    const reason = chat.resumeReason ?? chat.statusMessage;
    if (!reason) continue;
    const credentialReason = await credentialResumeReason(chat);
    if (credentialReason) {
      if (!['limited', 'reauth'].includes(credentialReason)) continue;
      if (chat.limitCount >= MAX_CREDENTIAL_RETRIES && !(credentialReason === 'limited' && chat.resumeReason)) continue;
    } else {
      if (!(exhaustedAgentFrom(reason) || rateLimitedAgentFrom(reason))) continue;
      if (chat.limitCount === 0 && !chatLimitAgent(chat, reason)) continue;
    }
    const claimed = await db.update(chats).set({ resumeAt: now, resumeReason: reason })
      .where(and(eq(chats.id, chat.id), eq(chats.status, 'error'), isNull(chats.resumeAt),
        eq(chats.resumeVersion, chat.resumeVersion), eq(chats.turnCount, chat.turnCount)))
      .returning({ id: chats.id });
    count += claimed.length;
  }
  return count;
}

export async function sweepChatLimits(now = new Date()): Promise<number> {
  if (ticking || isWorkbenchDraining()) return 0;
  ticking = true;
  const start = Date.now();
  let error: unknown;
  try {
    const result = await guardCrossReplica(POLLER, async () => {
      const db = getDbClient();
      const rows = await db.select(CHAT_COLUMNS).from(chats)
        .innerJoin(workbenches, eq(chats.workbenchId, workbenches.id))
        .where(and(lte(chats.resumeAt, now), eq(chats.status, 'error'), isNull(chats.closedAt),
          isNull(workbenches.archivedAt), isNull(workbenches.archivePendingAt)))
        .orderBy(chats.resumeAt).limit(25);
      let count = 0;
      for (const chat of rows) {
        if (Date.now() - start >= LIMIT_RESUME_SWEEP_BUDGET_MS) break;
        const [claimed] = await db.update(chats).set({ resumeAt: null, statusMessage: chat.resumeReason ?? chat.statusMessage })
          .where(and(eq(chats.id, chat.id), eq(chats.resumeAt, chat.resumeAt!),
            eq(chats.status, 'error'), eq(chats.resumeVersion, chat.resumeVersion)))
          .returning(CHAT_COLUMNS);
        if (!claimed) continue;
        emitWorkbenchChat(claimed.workspaceId, rowToChat(claimed));
        try {
          const reason = claimed.resumeReason ?? claimed.statusMessage ?? '';
          await handleChatLimit(claimed, reason, claimed.limitCount > 0);
          count++;
        } catch (err) {
          await db.update(chats).set({ resumeAt: new Date(now.getTime() + 60_000) })
            .where(and(eq(chats.id, chat.id), eq(chats.resumeVersion, claimed.resumeVersion),
              eq(chats.status, 'error'), isNull(chats.resumeAt)));
          error = err;
        }
      }
      return count;
    });
    return result.result ?? 0;
  } catch (err) {
    error = err;
    return 0;
  } finally {
    ticking = false;
    debugBus.pollerTick(POLLER, { durationMs: Date.now() - start, ok: !error, error });
  }
}

export function initChatLimitResume(): void {
  if (timer) return;
  debugBus.registerPoller(POLLER, 60_000, 'Continue chats after an agent limit clears.');
  timer = setInterval(() => { void runWithoutScope(() => sweepChatLimits()); }, 60_000);
  timer.unref();
  void runWithoutScope(async () => {
    await backfillChatLimits();
    await sweepChatLimits();
  }).catch((error) => debugBus.pollerTick(POLLER, { durationMs: 0, ok: false, error }));
}
