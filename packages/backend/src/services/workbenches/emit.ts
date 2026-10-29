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

/**
 * Things that follow a session's state without being a WebSocket client: the
 * Slack status reactions. A listener is called after the broadcast and must
 * not throw or block; a throw is caught and logged.
 */
export interface WorkbenchEmitListener {
  workbench?: (workbench: Workbench) => void;
  chat?: (workspaceId: string, chat: WorkbenchChat) => void;
}

const listeners = new Set<WorkbenchEmitListener>();

/** Register a listener. Returns the function that removes it. */
export function onWorkbenchEmit(listener: WorkbenchEmitListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(call: (l: WorkbenchEmitListener) => void): void {
  for (const l of listeners) {
    try {
      call(l);
    } catch (err) {
      console.warn('[workbench] an emit listener failed:', err);
    }
  }
}

export async function emitWorkbenchUpdated(workbench: Workbench): Promise<void> {
  send(workbench.workspaceId, 'workbench:updated', { workbench });
  notify((l) => l.workbench?.(workbench));
  // Link, archive, restore and status changes all pass here, and each can change
  // which session a pull request shows.
  if (workbench.pullRequestId) await emitPrSession(workbench.workspaceId, workbench.pullRequestId);
}

export function emitWorkbenchDeleted(workspaceId: string, id: string): void {
  send(workspaceId, 'workbench:deleted', { id });
}

export function emitWorkbenchChat(workspaceId: string, chat: WorkbenchChat): void {
  send(workspaceId, 'workbench:chat', { chat });
  notify((l) => l.chat?.(workspaceId, chat));
}

export function emitWorkbenchEvents(workspaceId: string, chatId: string, events: WorkbenchEvent[]): void {
  if (events.length === 0) return;
  send(workspaceId, 'workbench:event', { chatId, events });
}

export function emitWorkbenchScript(workspaceId: string, frame: WorkbenchScriptFrame): void {
  send(workspaceId, 'workbench:script', frame);
}
