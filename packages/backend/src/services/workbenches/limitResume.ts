import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FleetAgent } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { workbenchChats, workspaces } from '../../db/schema.js';
import { fleetAgentStatus } from '../selfHosted/credentials.js';
import { setFleetAccountExhausted } from '../selfHosted/accounts.js';
import {
  agentLabel, exhaustedAgentFrom, heldBackAgents, noteExhaustedAgent,
  probeAfter, rateLimitedAgentFrom, resetInstantFrom,
} from '../selfHosted/exhaustedQuota.js';
import { deferralRetryAt } from '../billing/boxDeferral.js';
import { existingBoxRefusal } from './boxGate.js';
import { sandboxAgents } from './credentialPolicy.js';
import { emitWorkbenchChat, emitWorkbenchEvents } from './emit.js';
import { switchChatAgent } from './sessionOps.js';
import { workbenchFleetAccountId } from './sandboxRuntime.js';
import { appendEvents, CHAT_COLUMNS, getChat, getWorkbench, rowToChat, type ChatRow } from './store.js';
import { sendMessage } from './turns.js';
import { turnPayerFor } from '../teams/payer.js';

export function chatLimitAgent(chat: Pick<ChatRow, 'agent'>, text: string): FleetAgent | null {
  const agent = exhaustedAgentFrom(text) ?? rateLimitedAgentFrom(text);
  return agent === chat.agent ? agent : null;
}

export function limitRetryDelay(count: number): number {
  return [5, 15, 30, 60][Math.min(Math.max(count - 1, 0), 3)] * 60_000;
}

export function limitResumeMessage(reason: string): string {
  return `Continue from where you stopped. The last turn ended with an error: ${reason.trim().slice(0, 300)}.`;
}

export async function cancelLimitResume(chatId: string): Promise<void> {
  const [row] = await getDbClient().update(workbenchChats).set({
    statusMessage: sql`CASE WHEN ${workbenchChats.resumeAt} IS NOT NULL THEN ${workbenchChats.resumeReason} ELSE ${workbenchChats.statusMessage} END`,
    resumeAt: null, resumeReason: '', resumeVersion: sql`${workbenchChats.resumeVersion} + 1`,
  }).where(eq(workbenchChats.id, chatId)).returning(CHAT_COLUMNS);
  if (row) emitWorkbenchChat(row.workspaceId, rowToChat(row));
}

async function enabled(workspaceId: string): Promise<boolean> {
  const [row] = await getDbClient().select({ settings: workspaces.settings }).from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return Boolean(row) && (row.settings as { autoResumeOnLimit?: boolean } | null)?.autoResumeOnLimit !== false;
}

/**
 * Record a new refusal once. A sweep only reads the existing holds.
 *
 * A teammate's turn (Teams and Spaces) hit the teammate's limit: the holds,
 * the account choice and the box gate all use the payer's workspace, and the
 * resumed turn runs as that teammate again. The chat's payer columns name the
 * payer of the turn that stopped, since no turn has started after it.
 */
export async function handleChatLimit(chat: ChatRow, text: string, retry = false): Promise<void> {
  const agent = retry && (exhaustedAgentFrom(text) || rateLimitedAgentFrom(text))
    ? chat.agent as FleetAgent : chatLimitAgent(chat, text);
  const payer = chat.payerUserId && chat.payerWorkspaceId
    ? { userId: chat.payerUserId, workspaceId: chat.payerWorkspaceId }
    : null;
  const workspaceId = payer?.workspaceId ?? chat.workspaceId;
  if (!agent || !(await enabled(workspaceId))) return;
  const wb = await getWorkbench(chat.workbenchId);
  if (!wb || wb.archivedAt || wb.archivePendingAt || wb.runtime !== 'sandbox' || chat.closedAt) return;
  const db = getDbClient();
  const now = new Date();
  let current = chat;
  if (!retry) {
    const [claimed] = await db.update(workbenchChats).set({
      resumeReason: text, limitCount: sql`${workbenchChats.limitCount} + 1`,
      // Persist the retry before external calls, so a restart cannot lose it.
      resumeAt: new Date(now.getTime() + limitRetryDelay(chat.limitCount + 1)),
    }).where(and(eq(workbenchChats.id, chat.id), eq(workbenchChats.status, 'error'),
      eq(workbenchChats.turnCount, chat.turnCount), eq(workbenchChats.resumeVersion, chat.resumeVersion),
      isNull(workbenchChats.resumeAt), sql`jsonb_array_length(${workbenchChats.queuedMessages}) = 0`)).returning(CHAT_COLUMNS);
    if (!claimed) return;
    current = claimed;
    const accountId = workbenchFleetAccountId(wb, agent, payer?.userId);
    if (exhaustedAgentFrom(text)) {
      await noteExhaustedAgent(workspaceId, agent, text, accountId);
    } else {
      const resetsAt = resetInstantFrom(text, now);
      await setFleetAccountExhausted(accountId ? { accountId } : { workspaceId, agent }, {
        at: now.toISOString(), kind: 'rate_limit', detail: text.slice(0, 500), ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  const [status, holds] = await Promise.all([fleetAgentStatus(workspaceId), heldBackAgents(workspaceId, now)]);
  const possible = sandboxAgents(wb).filter((a) => status.connectedAgents.includes(a) && !status.reauthAgents.includes(a));
  const other = agent === 'claude' ? 'codex' : 'claude';
  const candidates: FleetAgent[] = retry ? [agent, other] : [other];
  const chosen = candidates.find((a) => possible.includes(a) && !holds[a]);
  const refusal = chosen && wb.status === 'ready' ? await existingBoxRefusal(wb, true, payer) : null;
  if (chosen && wb.status === 'ready' && !refusal) {
    const fresh = await getChat(chat.id);
    if (!fresh || fresh.resumeVersion !== current.resumeVersion || fresh.status !== 'error' || fresh.queuedMessages.length) return;
    if (chosen !== agent) {
      await switchChatAgent(fresh, wb, chosen, null, { resumeVersion: current.resumeVersion });
      const events = await appendEvents(chat.id, [{ turn: chat.turnCount, event: {
        type: 'system', subtype: 'agent_limit_switch',
        text: `${agentLabel(agent)} reached its usage limit. Continuing with ${agentLabel(chosen)}.`,
      } }]);
      emitWorkbenchEvents(chat.workspaceId, chat.id, events);
    }
    // Talyn messages use the unattended box gate at turn start.
    await sendMessage(chat.id, { text: limitResumeMessage(text) }, {
      origin: 'talyn',
      resumeVersion: current.resumeVersion,
      ...(payer ? { payer: await turnPayerFor(payer.userId, payer.workspaceId) } : {}),
    });
    return;
  }
  const resets = possible.map((a) => holds[a]?.resetsAt).filter((at): at is string => Boolean(at))
    .map(Date.parse).filter((at) => at > now.getTime());
  const ownReset = !retry ? resetInstantFrom(text, now) : null;
  if (ownReset && possible.includes(agent) && Date.parse(ownReset) > now.getTime()) resets.push(Date.parse(ownReset));
  const delay = exhaustedAgentFrom(text)
    ? 5 * 60 * 60_000
    : limitRetryDelay(Math.max(current.limitCount, 1));
  const probes = possible.map((a) => holds[a]).filter((hold) => hold !== undefined)
    .map((hold) => probeAfter(hold)).filter((at) => at > now.getTime());
  const at = refusal ? deferralRetryAt(refusal, now.getTime()) : new Date(resets.length ? Math.min(...resets) :
    Math.max(now.getTime() + delay, probes.length ? Math.min(...probes) : 0));
  const [waiting] = await db.update(workbenchChats).set({
    resumeAt: at, resumeReason: text,
    statusMessage: refusal?.message ?? `Waiting for usage. Resumes at ${at!.toISOString().slice(11, 16)} UTC.`,
  }).where(and(eq(workbenchChats.id, chat.id), eq(workbenchChats.status, 'error'),
    eq(workbenchChats.resumeVersion, current.resumeVersion))).returning(CHAT_COLUMNS);
  if (waiting) emitWorkbenchChat(chat.workspaceId, rowToChat(waiting));
}
