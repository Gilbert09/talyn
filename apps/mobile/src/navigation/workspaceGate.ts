import type { WorkspaceSnapshot } from '../workspaces/controller';

export type WorkspaceGate = 'wait' | 'choose' | 'ready';

/**
 * What a screen that needs a workspace should do. On a cold start the saved
 * choice is still loading, so the screen waits instead of sending the person
 * to the chooser. Only a finished load without a choice goes there.
 */
export function workspaceGate(snapshot: Pick<WorkspaceSnapshot, 'status' | 'selected'>): WorkspaceGate {
  if (snapshot.selected) return 'ready';
  return snapshot.status === 'idle' || snapshot.status === 'loading' ? 'wait' : 'choose';
}
