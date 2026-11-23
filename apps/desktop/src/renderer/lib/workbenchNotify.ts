import { notificationText, type Workbench, type WorkbenchChat, type WorkbenchEvent } from '@talyn/shared';
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

// The alert text is shared with the other front ends and the mobile push worker.
export { notificationSummary, notificationText } from '@talyn/shared';

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

/** Fires an OS notification, asking for permission once. Skipped while the window has focus. */
export function showNativeNotification(title: string, body: string, onClick?: () => void): void {
  if (typeof document !== 'undefined' && document.hasFocus()) return;
  if (typeof Notification === 'undefined') return;
  const fire = () => {
    try {
      const n = new Notification(title, { body, silent: false });
      n.onclick = () => {
        try {
          onClick?.();
        } catch {
          // ignore
        }
      };
    } catch {
      // Permission denied or a renderer quirk: the in-app signal still shows.
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

function notifyChatFinished(chat: WorkbenchChat, workbench: Workbench | undefined): void {
  if (!readSessionDefaults().notifyOnFinish) return;
  const events = useWorkbenchStore.getState().chatEvents[chat.id]?.events ?? [];
  const { title, body } = notificationText(chat, workbench, events);
  showNativeNotification(title, body, () => openFromNotification(chat));
}

export function installWorkbenchNotifications(): () => void {
  setChatFinishedListener(notifyChatFinished);
  return () => setChatFinishedListener(null);
}
