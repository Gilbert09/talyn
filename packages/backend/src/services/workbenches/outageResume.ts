import { and, eq, isNull, sql } from 'drizzle-orm';
import { agentOutageFrom, type FleetAgent } from '@talyn/shared';
import { getDbClient, runWithoutScope } from '../../db/client.js';
import { workbenchChats, workspaces } from '../../db/schema.js';
import { deferralRetryAt } from '../billing/boxDeferral.js';
import { debugBus } from '../debugBus.js';
import { agentLabel, exhaustedAgentFrom, rateLimitedAgentFrom } from '../selfHosted/exhaustedQuota.js';
import { turnPayerFor } from '../teams/payer.js';
import { existingBoxRefusal } from './boxGate.js';
import { emitWorkbenchChat } from './emit.js';
import { fleetClientFor } from './sandboxRuntime.js';
import { CHAT_COLUMNS, getChat, getWorkbench, otherRunningChats, rowToChat, type ChatRow } from './store.js';
import { sendMessage } from './turns.js';
import { meterWorkbenchSuspended } from './usageMeter.js';

/**
 * An agent's API failed on the vendor's side (5xx, overloaded, no answer).
 * Waiting fixes it, and an awake box bills while it waits. So the failed turn
 * suspends its box and Talyn sends "continue" later, on the same path as a
 * usage limit (`resumeAt`, swept by `limitResumeSweep`).
 */

/** Minutes before each retry. The last value repeats. */
const OUTAGE_RETRY_MINUTES = [2, 5, 10, 20, 30] as const;

/** Retries before Talyn stops and leaves the error for the person. About 2.5 hours of waits. */
export const MAX_OUTAGE_RETRIES = 8;

/** Time after the turn ends before the box suspends: the turn's own checkpoint and backup run first. */
export const OUTAGE_SUSPEND_DELAY_MS = 30_000;

export function outageRetryDelay(count: number): number {
  return OUTAGE_RETRY_MINUTES[Math.min(Math.max(count - 1, 0), OUTAGE_RETRY_MINUTES.length - 1)] * 60_000;
}

/** The agent whose API failed, or null. A rate limit or a spent quota is not an outage. */
export function outageAgentFrom(text: string | null | undefined): FleetAgent | null {
  if (exhaustedAgentFrom(text) || rateLimitedAgentFrom(text)) return null;
  return agentOutageFrom(text);
}

/** The chat's own agent failed on its vendor's side. */
export function chatOutageAgent(chat: Pick<ChatRow, 'agent'>, text: string): FleetAgent | null {
  const agent = outageAgentFrom(text);
  return agent === chat.agent ? agent : null;
}

export function outageResumeMessage(reason: string): string {
  return `Continue from where you stopped. The last turn ended because the model API failed: ${reason.trim().slice(0, 300)}.`;
}

export function outageWaitMessage(agent: FleetAgent, at: Date): string {
  return `${agentLabel(agent)}'s API is failing. Talyn suspended this box and tries again at ${at.toISOString().slice(11, 16)} UTC.`;
}

/** The workspace setting that also turns on usage-limit resumes. On unless set to false. */
export async function autoResumeEnabled(workspaceId: string): Promise<boolean> {
  const [row] = await getDbClient().select({ settings: workspaces.settings }).from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return Boolean(row) && (row.settings as { autoResumeOnLimit?: boolean } | null)?.autoResumeOnLimit !== false;
}

/**
 * A turn ended on an outage (`retry` false): record the wait and suspend the
 * box. The wait ended (`retry` true, from the sweep): wake the box with a
 * "continue" message. After {@link MAX_OUTAGE_RETRIES} the error stays.
 */
export async function handleChatOutage(chat: ChatRow, text: string, retry = false): Promise<void> {
  const agent = retry ? (outageAgentFrom(text) ? chat.agent as FleetAgent : null) : chatOutageAgent(chat, text);
  const payer = chat.payerUserId && chat.payerWorkspaceId
    ? { userId: chat.payerUserId, workspaceId: chat.payerWorkspaceId }
    : null;
  const workspaceId = payer?.workspaceId ?? chat.workspaceId;
  if (!agent || !(await autoResumeEnabled(workspaceId))) return;
  const wb = await getWorkbench(chat.workbenchId);
  if (!wb || wb.archivedAt || wb.archivePendingAt || wb.runtime !== 'sandbox' || chat.closedAt) return;
  const db = getDbClient();
  const now = new Date();

  if (!retry) {
    if (chat.limitCount >= MAX_OUTAGE_RETRIES) return;
    const at = new Date(now.getTime() + outageRetryDelay(chat.limitCount + 1));
    const [claimed] = await db.update(workbenchChats).set({
      resumeReason: text, limitCount: sql`${workbenchChats.limitCount} + 1`, resumeAt: at,
      statusMessage: outageWaitMessage(agent, at),
    }).where(and(eq(workbenchChats.id, chat.id), eq(workbenchChats.status, 'error'),
      eq(workbenchChats.turnCount, chat.turnCount), eq(workbenchChats.resumeVersion, chat.resumeVersion),
      isNull(workbenchChats.resumeAt), sql`jsonb_array_length(${workbenchChats.queuedMessages}) = 0`)).returning(CHAT_COLUMNS);
    if (!claimed) return;
    emitWorkbenchChat(claimed.workspaceId, rowToChat(claimed));
    debugBus.recordEvent({
      service: 'workbench', action: 'agent_outage_wait', ok: true, workspaceId: claimed.workspaceId,
      summary: `Chat ${chat.id}: ${agent} API failed; retry ${claimed.limitCount} at ${at.toISOString()}`,
    });
    scheduleOutageSuspend(wb.id, chat.id, claimed.resumeVersion);
    return;
  }

  const refusal = wb.status === 'ready' ? await existingBoxRefusal(wb, true, payer) : null;
  if (wb.status === 'ready' && !refusal) {
    const fresh = await getChat(chat.id);
    if (!fresh || fresh.resumeVersion !== chat.resumeVersion || fresh.status !== 'error' || fresh.queuedMessages.length) return;
    // Talyn messages use the unattended box gate at turn start. Sending wakes the box.
    await sendMessage(chat.id, { text: outageResumeMessage(text) }, {
      origin: 'talyn',
      resumeVersion: chat.resumeVersion,
      ...(payer ? { payer: await turnPayerFor(payer.userId, payer.workspaceId) } : {}),
    });
    return;
  }
  // The box cannot take a turn now (still moving, or the plan refuses it). Wait again, without a count.
  const later = new Date(now.getTime() + outageRetryDelay(Math.max(chat.limitCount, 1)));
  const at = refusal ? deferralRetryAt(refusal, now.getTime()) : later;
  const [waiting] = await db.update(workbenchChats).set({
    resumeAt: at, resumeReason: text, statusMessage: refusal?.message ?? outageWaitMessage(agent, later),
  }).where(and(eq(workbenchChats.id, chat.id), eq(workbenchChats.status, 'error'),
    eq(workbenchChats.resumeVersion, chat.resumeVersion))).returning(CHAT_COLUMNS);
  if (waiting) emitWorkbenchChat(chat.workspaceId, rowToChat(waiting));
}

/** Suspend the box a little after the turn ends. Best effort: a deploy loses it, and the fleet's idle timeout suspends the box then. */
export function scheduleOutageSuspend(workbenchId: string, chatId: string, resumeVersion: number, delayMs = OUTAGE_SUSPEND_DELAY_MS): void {
  const timer = setTimeout(() => {
    void runWithoutScope(() => suspendAfterOutage(workbenchId, chatId, resumeVersion)).catch((error: unknown) => {
      debugBus.recordEvent({ service: 'workbench', action: 'agent_outage_suspend_failed', ok: false, error, summary: `Could not suspend workbench ${workbenchId}` });
    });
  }, delayMs);
  timer.unref();
}

/**
 * Suspend the session's box while its chat waits for the API. Only when the
 * chat still waits, no other chat runs a turn, and the fleet reports the box
 * `idle`: `busy` means a background job, terminal, SSH session or preview
 * holds it, and suspending would freeze that work. Returns whether it suspended.
 */
export async function suspendAfterOutage(workbenchId: string, chatId: string, resumeVersion: number): Promise<boolean> {
  const chat = await getChat(chatId);
  if (!chat || chat.status !== 'error' || !chat.resumeAt || chat.resumeVersion !== resumeVersion || chat.queuedMessages.length) return false;
  const wb = await getWorkbench(workbenchId);
  if (!wb || wb.archivedAt || wb.archivePendingAt || wb.runtime !== 'sandbox' || wb.status !== 'ready' || !wb.sandboxId) return false;
  if (wb.sandboxState !== 'running') return false;
  if ((await otherRunningChats(wb.id)) > 0) return false;
  const client = await fleetClientFor(wb.workspaceId, wb.fleetHost);
  const { sandbox } = await client.getSandbox(wb.sandboxId);
  if (sandbox.status !== 'idle') return false;
  await client.suspendSandbox(wb.sandboxId);
  await meterWorkbenchSuspended({ workspaceId: wb.workspaceId, sandboxId: wb.sandboxId }, new Date());
  debugBus.recordEvent({
    service: 'workbench', action: 'agent_outage_suspend', ok: true, workspaceId: wb.workspaceId,
    summary: `Suspended ${wb.sandboxId} while chat ${chatId} waits for the model API`,
  });
  return true;
}
