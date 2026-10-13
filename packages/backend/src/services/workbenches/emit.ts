import type { Workbench, WorkbenchChat, WorkbenchEvent, WorkbenchScriptFrame, WorkbenchWsPayloads } from '@talyn/shared';
import { broadcastToWorkspace } from '../websocket.js';

/**
 * The five workbench WebSocket events, delivered to the workspace's
 * subscribers the way task events are. Payload shapes are `WorkbenchWsPayloads`
 * in `@talyn/shared`, so the client and this file cannot disagree.
 */
function send<K extends keyof WorkbenchWsPayloads>(workspaceId: string, type: K, payload: WorkbenchWsPayloads[K]): void {
  broadcastToWorkspace(workspaceId, { type, payload, timestamp: new Date().toISOString() });
}

export function emitWorkbenchUpdated(workbench: Workbench): void {
  send(workbench.workspaceId, 'workbench:updated', { workbench });
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
