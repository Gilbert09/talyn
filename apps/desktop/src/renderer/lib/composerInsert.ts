import type { WorkbenchChat } from '@talyn/shared';
import { composerDraftKey, useWorkbenchStore } from '../stores/workbenches';
import { FOCUS_COMPOSER_EVENT } from './shortcuts';

/**
 * Put text into the open chat's composer draft, after what is already there,
 * and give the composer focus. Nothing is sent: the person reads it, edits
 * it and presses Enter. Used by the Pull request tab's "Add to chat" and the
 * Changes tab's comment bar.
 */
export function insertIntoComposer(workbenchId: string, chat: Pick<WorkbenchChat, 'id'> | null, text: string): void {
  useWorkbenchStore.getState().appendDraft(composerDraftKey(workbenchId, chat), text);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT));
}
