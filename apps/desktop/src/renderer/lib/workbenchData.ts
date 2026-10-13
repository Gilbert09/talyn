import type { Workbench, WorkbenchChat, WorkbenchEvent } from '@talyn/shared';
import { api } from './api';
import { useWorkbenchStore } from '../stores/workbenches';

/**
 * Fetching workbench data into the store. The WS handlers in `useApi.ts` keep
 * it current afterwards; these are the first loads and the catch-ups.
 */

/** A page this size keeps one request well under a second for a long chat. */
export const EVENTS_PAGE_SIZE = 500;

/** Archived ones too, so the sidebar's Archived section can offer a restore. */
export async function loadWorkbenches(workspaceId: string): Promise<void> {
  const store = useWorkbenchStore.getState();
  store.setWorkspace(workspaceId);
  try {
    const list = await api.workbenches.list(workspaceId, { includeArchived: true });
    useWorkbenchStore.getState().setWorkbenches(workspaceId, list);
    for (const wb of list) absorbEmbeddedChats(wb);
  } catch (err) {
    useWorkbenchStore.getState().setListError(err instanceof Error ? err.message : 'Could not load workbenches.');
  }
}

/**
 * The contract has no "list chats" route; a backend that embeds `chats` on the
 * workbench response is read here, and `workbench:chat` broadcasts fill in the
 * rest.
 */
function absorbEmbeddedChats(wb: Workbench): void {
  const chats = (wb as Workbench & { chats?: WorkbenchChat[] }).chats;
  if (Array.isArray(chats)) useWorkbenchStore.getState().setChats(wb.id, chats);
}

/** Refresh one workbench (and its chats, when the response carries them). */
export async function loadWorkbench(id: string): Promise<Workbench | null> {
  try {
    const wb = await api.workbenches.get(id);
    useWorkbenchStore.getState().upsertWorkbench(wb);
    absorbEmbeddedChats(wb);
    return wb;
  } catch {
    return null;
  }
}

const inflightHistory = new Map<string, Promise<void>>();

/**
 * Page a chat's stored events into the store, oldest first, until a short
 * page says there is no more. Concurrent callers share one load.
 *
 * `force` re-reads from the last seq held — the reconnect catch-up, which
 * fetches only what was broadcast while the socket was down.
 */
export function ensureChatHistory(chatId: string, opts: { force?: boolean } = {}): Promise<void> {
  const state = useWorkbenchStore.getState().chatEvents[chatId];
  if (state?.loaded && !opts.force) return Promise.resolve();
  const running = inflightHistory.get(chatId);
  if (running) return running;
  const load = (async () => {
    const store = useWorkbenchStore.getState();
    store.setChatEventsState(chatId, { loading: true, error: null });
    try {
      let after = opts.force ? lastHeldSeq(chatId) : 0;
      for (;;) {
        const page: { events: WorkbenchEvent[]; cursor: number } = await api.workbenches.events(chatId, {
          after,
          limit: EVENTS_PAGE_SIZE,
        });
        useWorkbenchStore.getState().appendEvents(chatId, page.events);
        if (page.events.length < EVENTS_PAGE_SIZE || page.cursor <= after) break;
        after = page.cursor;
      }
      useWorkbenchStore.getState().setChatEventsState(chatId, { loaded: true, loading: false });
    } catch (err) {
      useWorkbenchStore
        .getState()
        .setChatEventsState(chatId, { loading: false, error: err instanceof Error ? err.message : 'Could not load the chat.' });
    } finally {
      inflightHistory.delete(chatId);
    }
  })();
  inflightHistory.set(chatId, load);
  return load;
}

function lastHeldSeq(chatId: string): number {
  const events = useWorkbenchStore.getState().chatEvents[chatId]?.events ?? [];
  return events.length ? events[events.length - 1].seq : 0;
}

/** After a reconnect: re-list, and catch up every chat whose history was open. */
export async function reconcileWorkbenches(workspaceId: string): Promise<void> {
  await loadWorkbenches(workspaceId);
  const { chatEvents } = useWorkbenchStore.getState();
  for (const [chatId, state] of Object.entries(chatEvents)) {
    if (state.loaded) void ensureChatHistory(chatId, { force: true });
  }
}
