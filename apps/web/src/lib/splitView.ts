import { useNavigationStore } from '../stores/navigation';
import { useSplitViewStore } from '../stores/splitView';

/** Put a session in split view and show split view. */
export function openInSplitView(workbenchId: string, source: string): void {
  useSplitViewStore.getState().addPane(workbenchId, source);
  useNavigationStore.getState().navigate({ view: 'split' });
}
