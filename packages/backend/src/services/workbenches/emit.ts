import type { Workbench, WorkbenchChat, WorkbenchEvent, WorkbenchScriptFrame, WorkbenchWsPayloads } from '@talyn/shared';
import { broadcastToWorkspace } from '../websocket.js';
import { emitPrSession } from './prSessions.js';

/**
 * The five workbench WebSocket events, delivered to the workspace's
 * subscribers the way task events are. Payload shapes are `WorkbenchWsPayloads`
 * in `@talyn/shared`, so the client and this file cannot disagree.
 */
function send<K extends keyof WorkbenchWsPayloads>(workspaceId: string, type: K, payload: WorkbenchWsPayloads[K]): void {
  broadcastToWorkspace(workspaceId, { type, payload, timestamp: new Date().toISOString() });
}

export async function emitWorkbenchUpdated(workbench: Workbench): Promise<void> {
  send(workbench.workspaceId, 'workbench:updated', { workbench });
  // Link, archive, restore and status changes all pass here, and each can change
  // which session a pull request shows.
  if (workbench.pullRequestId) await emitPrSession(workbench.workspaceId, workbench.pullRequestId);
}

export function emitWorkbenchDeleted(workspaceId: string, id: string): void {
  send(workspaceId, 'workbench:deleted', { id });
}

export function emitWorkbenchChat(workspaceId: string, chat: WorkbenchChat): void {
  send(workspaceId, 'workbench:chat', { chat });
}

export function emitWorkbenchEvents(workspaceId: string, chatId: string, events: WorkbenchEvent[]): void {
  if (events.length === 0) return;
  send(workspaceId, 'workbench:event', { chatId, events });
}

export function emitWorkbenchScript(workspaceId: string, frame: WorkbenchScriptFrame): void {
  send(workspaceId, 'workbench:script', frame);
}
