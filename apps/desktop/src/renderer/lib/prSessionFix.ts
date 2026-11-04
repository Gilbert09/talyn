import type { WorkbenchChat } from '@talyn/shared';
import { api, ApiError, type PRRow } from './api';
import { trackEvent } from './analytics';
import { captureWorkbenchFailure } from './workbenchAnalytics';
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

/**
 * What to send the session, by the PR's real state. Conflicts first (a fix
 * reruns the checks anyway), then failing CI, then open review comments. With
 * both CI and threads open, the checks go first: the backend adds the thread
 * count to that prompt, so the next press is the review-comments one. Anything
 * else stays a checks fix, as before.
 */
export function sessionFixAction(row: PRRow): 'resolve_conflicts' | 'fix_checks' | 'address_review' {
  const s = row.summary;
  if (s.blockingReason === 'merge_conflicts' || s.mergeable === 'CONFLICTING') return 'resolve_conflicts';
  if (s.blockingReason === 'checks_failed' || s.ciStatus === 'failing_required') return 'fix_checks';
  if (
    (s.unresolvedReviewThreads ?? 0) > 0 ||
    s.blockingReason === 'changes_requested' ||
    s.reviewDecision === 'CHANGES_REQUESTED'
  ) {
    return 'address_review';
  }
  return 'fix_checks';
}

export async function sendPrFixToSession(row: PRRow, session: PrSessionRef): Promise<void> {
  try {
    await sendPrFixToSessionInternal(row, session);
  } catch (error) {
    captureWorkbenchFailure('send_fix', error, session.id);
    throw error;
  }
}

async function sendPrFixToSessionInternal(row: PRRow, session: PrSessionRef): Promise<void> {
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
  const action = sessionFixAction(row);
  await ops.runAction(action, chat);
  trackEvent('session_fix_sent', { workbench_id: session.id, action });

  toast.success('Sent to the session', `${row.owner}/${row.repo}#${row.number}`, {
    label: 'Open',
    onClick: () => useNavigationStore.getState().navigate({ view: 'workbench', id: session.id }),
  });
}
