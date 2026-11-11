import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { api } from '../../lib/api';
import { captureWorkbenchFailure } from '../../lib/workbenchAnalytics';
import { toast } from '../../stores/toast';
import { useWorkbenchStore } from '../../stores/workbenches';
import { maybeHandleBillingLimit } from '../../stores/billing';

/** Make the session's chat when it has none, and open it. Used by the composer's first send and the session actions. */
export async function createSessionChat(workbench: Workbench): Promise<WorkbenchChat | null> {
  try {
    const chat = await api.workbenches.createChat(workbench.id, {});
    const store = useWorkbenchStore.getState();
    store.upsertChat(chat);
    store.setChatEventsState(chat.id, { loaded: true });
    store.selectChat(workbench.id, chat.id);
    return chat;
  } catch (err) {
    captureWorkbenchFailure('create_chat', err, workbench.id);
    if (maybeHandleBillingLimit(err, 'session_new_chat')) return null;
    toast.error('Could not open a new chat', err instanceof Error ? err.message : undefined);
    return null;
  }
}
