import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';

/**
 * How a non-UI module (a notification click, a toast button) opens a session.
 *
 * The desktop calls its navigation store directly. On the web that store is
 * built by the shell, so the shell installs the real route change here with
 * `setWorkbenchNavigator`. Until it does, the fallback selects the session and
 * shows the sessions panel.
 */

export type WorkbenchNavigator = (workbenchId: string) => void;

let navigator: WorkbenchNavigator | null = null;

export function setWorkbenchNavigator(next: WorkbenchNavigator | null): void {
  navigator = next;
}

export function navigateToWorkbench(workbenchId: string): void {
  if (navigator) {
    navigator(workbenchId);
    return;
  }
  useWorkbenchStore.getState().selectWorkbench(workbenchId);
  useWorkspaceStore.getState().setActivePanel('workbenches');
}
