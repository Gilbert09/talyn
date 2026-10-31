import type { Workbench, WorkbenchAgent } from '@talyn/shared';
import { api } from './api';
import { useNavigationStore } from '../stores/navigation';
import { useWorkbenchStore } from '../stores/workbenches';

export interface NewThreadSpec {
  workspaceId: string;
  /** A display title. Empty: Talyn names the thread from the first message. */
  name: string;
  /** The first message. */
  prompt: string;
  agent: WorkbenchAgent;
  model?: string;
  internetAccess?: boolean;
}

function absorb(wb: Workbench): void {
  const store = useWorkbenchStore.getState();
  store.upsertWorkbench(wb);
  if (Array.isArray(wb.chats)) store.setChats(wb.id, wb.chats);
}

/**
 * Create a thread, give it the person's name, and open it. The first message
 * waits on the thread's chat until its sandbox is ready.
 */
export async function createThread(spec: NewThreadSpec): Promise<Workbench> {
  const prompt = spec.prompt.trim();
  let thread = await api.workbenches.create({
    workspaceId: spec.workspaceId,
    kind: 'thread',
    runtime: 'sandbox',
    agent: spec.agent,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.internetAccess !== undefined ? { internetAccess: spec.internetAccess } : {}),
    ...(prompt ? { prompt } : {}),
  });
  absorb(thread);
  const title = spec.name.trim();
  if (title) {
    // The thread exists already: a failed rename keeps Talyn's name, it does not fail the create.
    thread = await api.workbenches.update(thread.id, { title }).catch(() => thread);
    absorb(thread);
  }
  useNavigationStore.getState().navigate({ view: 'workbench', id: thread.id });
  return thread;
}

/**
 * Continue a session as a thread. The session joins the new thread, and the
 * thread starts with a recap of the session's chat. Opens the thread.
 */
export async function continueAsThread(session: Workbench): Promise<Workbench> {
  const thread = await api.workbenches.continueAsThread(session.id);
  absorb(thread);
  // The broadcast brings the linked session too; this shows the link at once.
  const current = useWorkbenchStore.getState().workbenches[session.id] ?? session;
  useWorkbenchStore.getState().upsertWorkbench({ ...current, threadId: thread.id });
  useNavigationStore.getState().navigate({ view: 'workbench', id: thread.id });
  return thread;
}
