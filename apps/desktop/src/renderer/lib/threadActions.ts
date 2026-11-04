import type { Workbench } from '@talyn/shared';
import { api } from './api';
import { trackEvent } from './analytics';
import { useNavigationStore } from '../stores/navigation';
import { useWorkbenchStore } from '../stores/workbenches';

function absorb(wb: Workbench): void {
  const store = useWorkbenchStore.getState();
  store.upsertWorkbench(wb);
  if (Array.isArray(wb.chats)) store.setChats(wb.id, wb.chats);
}

/**
 * Continue a session as a thread. The session joins the new thread, and the
 * thread starts with a recap of the session's chat. Opens the thread.
 */
export async function continueAsThread(session: Workbench): Promise<Workbench> {
  const thread = await api.workbenches.continueAsThread(session.id);
  trackEvent('session_created', { kind: 'thread', runtime: thread.runtime, repository_id: thread.repositoryId, size: thread.settings.sandboxSize ?? thread.settings.boxSize ?? 'default' });
  absorb(thread);
  // The broadcast brings the linked session too; this shows the link at once.
  const current = useWorkbenchStore.getState().workbenches[session.id] ?? session;
  useWorkbenchStore.getState().upsertWorkbench({ ...current, threadId: thread.id });
  useNavigationStore.getState().navigate({ view: 'workbench', id: thread.id });
  return thread;
}
