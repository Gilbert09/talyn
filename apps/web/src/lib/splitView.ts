import type { DragEvent } from 'react';
import { useNavigationStore } from '../stores/navigation';
import { useSplitViewStore } from '../stores/splitView';

/** Put a session in split view and show split view. */
export function openInSplitView(workbenchId: string, source: string): void {
  useSplitViewStore.getState().addPane(workbenchId, source);
  useNavigationStore.getState().navigate({ view: 'split' });
}

/** The drag data type for a session row or a split view pane. */
export const SESSION_DRAG_TYPE = 'application/x-talyn-session';

// The session being dragged in this window. A drop target cannot read the drag data until the drop.
let dragging: string | null = null;

/** Props that make an element drag its session into split view. */
export function sessionDragProps(workbenchId: string, enabled = true) {
  if (!enabled) return {};
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      dragging = workbenchId;
      event.dataTransfer.setData(SESSION_DRAG_TYPE, workbenchId);
      event.dataTransfer.setData('text/plain', workbenchId);
      event.dataTransfer.effectAllowed = 'copyMove';
    },
    onDragEnd: () => {
      dragging = null;
    },
  };
}

/** The session dragged in this window right now, if any. */
export function draggingSession(): string | null {
  return dragging;
}

/** True when a drag carries a session. The id itself can be read only on drop. */
export function carriesSession(event: { dataTransfer: DataTransfer | null }): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes(SESSION_DRAG_TYPE);
}

/** The session a drop carries, or null. */
export function droppedSession(event: { dataTransfer: DataTransfer | null }): string | null {
  return event.dataTransfer?.getData(SESSION_DRAG_TYPE) || null;
}
