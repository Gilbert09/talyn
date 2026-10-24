import type { WorkbenchChat } from '@talyn/shared';
import { api, ApiError, type PRRow } from './api';
import { opsFor } from './workbenchOps';
import { loadWorkbench } from './workbenchData';
import { useWorkbenchStore, visibleChats } from '../stores/workbenches';
import { useNavigationStore } from '../stores/navigation';
import { toast } from '../stores/toast';

/**
 * A PR's Fix when a live session works that PR. The fix goes into the
 * session's chat, so two agents never push to one branch. The user stays where
 * they are; the toast offers the way in.
 */

export interface PrSessionRef {
  id: string;
  name: string;
}

/** The session named by a 409 `pr_has_session`, or null for any other error. */
export function sessionFromConflict(err: unknown): PrSessionRef | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'pr_has_session') return null;
  const id = err.details?.workbenchId;
  const name = err.details?.name;
  if (typeof id !== 'string') return null;
  return { id, name: typeof name === 'string' ? name : 'session' };
}

/** Conflicts get their own prompt; everything else is a checks fix. */
export function sessionFixAction(row: PRRow): 'resolve_conflicts' | 'fix_checks' {
  return row.summary.blockingReason === 'merge_conflicts' || row.summary.mergeable === 'CONFLICTING'
    ? 'resolve_conflicts'
    : 'fix_checks';
}

export async function sendPrFixToSession(row: PRRow, session: PrSessionRef): Promise<void> {
  const workbench =
    useWorkbenchStore.getState().workbenches[session.id] ?? (await loadWorkbench(session.id));
  if (!workbench) throw new Error(`Could not open the session "${session.name}".`);
  const ops = opsFor(workbench);
  if (ops.unavailable) throw new Error(ops.unavailable);

  const store = useWorkbenchStore.getState();
  const chats = visibleChats(store, workbench.id);
  let chat: WorkbenchChat | null =
    chats.find((c) => c.id === store.selectedChatByWorkbench[workbench.id]) ?? chats[chats.length - 1] ?? null;
  // A sandbox session picks its latest chat on the server. A local one needs a
  // chat here, because this machine runs its turns.
  if (!chat && workbench.runtime === 'local') {
    chat = await api.workbenches.createChat(workbench.id);
    useWorkbenchStore.getState().upsertChat(chat);
  }
  await ops.runAction(sessionFixAction(row), chat);

  toast.success(`Sent to session ${session.name}`, `${row.owner}/${row.repo}#${row.number}`, {
    label: 'Open',
    onClick: () => useNavigationStore.getState().navigate({ view: 'workbench', id: session.id }),
  });
}
