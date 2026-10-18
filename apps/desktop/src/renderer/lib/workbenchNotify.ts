import type { Workbench, WorkbenchChat, WorkbenchEvent } from '@talyn/shared';
import { setChatFinishedListener, useWorkbenchStore } from '../stores/workbenches';
import { toast } from '../stores/toast';
import { useNavigationStore } from '../stores/navigation';
import { readSessionDefaults } from './sessionDefaults';

/**
 * "Your agent finished" — an OS notification when a chat stops running (done,
 * an error, or waiting for input) while the window is not focused. The store
 * marks the chat unread on its own; this adds the notification, and its click
 * brings the window forward on that workbench and chat.
 */

export function notificationText(
  chat: Pick<WorkbenchChat, 'status' | 'title'>,
  workbench: Pick<Workbench, 'name'> | undefined
): { title: string; body: string } {
  const name = workbench?.name ?? 'Session';
  const chatTitle = chat.title || 'The chat';
  if (chat.status === 'error') return { title: `${name}: stopped with an error`, body: `${chatTitle} needs a look.` };
  if (chat.status === 'awaiting_input') return { title: `${name}: needs your input`, body: `${chatTitle} is waiting for an answer.` };
  return { title: `${name}: done`, body: `${chatTitle} is waiting for you.` };
}

/**
 * A toast when a sandbox Create PR turn could not open its PR. The thread says
 * so too; the toast is for a person looking elsewhere. A local session toasts
 * from its own controller, and its events come back over the socket as well.
 */
export function toastPullRequestFailures(chatId: string, events: WorkbenchEvent[]): void {
  const failed = events.filter((e) => e.event.type === 'talyn_pr' && (e.event as { ok?: unknown }).ok !== true);
  if (failed.length === 0) return;
  const { chats, workbenches } = useWorkbenchStore.getState();
  const chat = Object.values(chats)
    .flat()
    .find((c) => c.id === chatId);
  if (!chat || workbenches[chat.workbenchId]?.runtime !== 'sandbox') return;
  for (const e of failed) {
    const message = (e.event as { message?: unknown }).message;
    toast.error('Could not open the pull request', typeof message === 'string' ? message : undefined);
  }
}

/** What a notification click does: raise the window, then open the workbench route and the chat. */
export function openFromNotification(chat: Pick<WorkbenchChat, 'id' | 'workbenchId'>): void {
  try {
    const focus = window.electron?.focusWindow;
    if (typeof focus === 'function') void focus().catch(() => window.focus());
    else window.focus();
  } catch {
    // A preload from an older build: the route still changes.
  }
  useNavigationStore.getState().navigate({ view: 'workbench', id: chat.workbenchId });
  const store = useWorkbenchStore.getState();
  store.selectChat(chat.workbenchId, chat.id);
  store.markRead(chat.id);
}

function notifyChatFinished(chat: WorkbenchChat, workbench: Workbench | undefined): void {
  if (!readSessionDefaults().notifyOnFinish) return;
  if (typeof document !== 'undefined' && document.hasFocus()) return;
  if (typeof Notification === 'undefined') return;
  const { title, body } = notificationText(chat, workbench);
  const fire = () => {
    try {
      const n = new Notification(`Talyn — ${title}`, { body, silent: false });
      n.onclick = () => {
        try {
          openFromNotification(chat);
        } catch {
          // ignore
        }
      };
    } catch {
      // Permission denied or a renderer quirk: the unread dot still shows.
    }
  };
  if (Notification.permission === 'granted') fire();
  else if (Notification.permission !== 'denied') {
    Notification.requestPermission()
      .then((perm) => {
        if (perm === 'granted') fire();
      })
      .catch(() => {});
  }
}

export function installWorkbenchNotifications(): () => void {
  setChatFinishedListener(notifyChatFinished);
  return () => setChatFinishedListener(null);
}
