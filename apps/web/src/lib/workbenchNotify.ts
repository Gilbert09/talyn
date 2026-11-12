import { notificationText, type Workbench, type WorkbenchChat, type WorkbenchEvent } from '@talyn/shared';
import { setChatFinishedListener, useWorkbenchStore } from '../stores/workbenches';
import { toast } from '../stores/toast';
import { navigateToWorkbench } from './workbenchNavigation';
import { readSessionDefaults } from './sessionDefaults';

/**
 * "Your agent finished" — a browser notification when a chat stops running
 * (done, an error, or waiting for input) while the tab is not focused. The
 * store marks the chat unread on its own; this adds the notification, and its
 * click brings the tab forward on that workbench and chat.
 */

// The alert text is shared with the other front ends and the mobile push worker.
export { notificationSummary, notificationText } from '@talyn/shared';

/**
 * A toast when a sandbox Create PR turn could not open its PR. The thread says
 * so too; the toast is for a person looking elsewhere. A local session (made in
 * the desktop app) toasts on its own computer, so it is skipped here.
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

/** What a notification click does: raise the tab, then open the workbench route and the chat. */
export function openFromNotification(chat: Pick<WorkbenchChat, 'id' | 'workbenchId'>): void {
  try {
    window.focus();
  } catch {
    // Some browsers refuse focus from a notification click: the route still changes.
  }
  navigateToWorkbench(chat.workbenchId);
  const store = useWorkbenchStore.getState();
  store.selectChat(chat.workbenchId, chat.id);
  store.markRead(chat.id);
}

function notifyChatFinished(chat: WorkbenchChat, workbench: Workbench | undefined): void {
  if (!readSessionDefaults().notifyOnFinish) return;
  if (typeof document !== 'undefined' && document.hasFocus()) return;
  if (typeof Notification === 'undefined') return;
  const events = useWorkbenchStore.getState().chatEvents[chat.id]?.events ?? [];
  const { title, body } = notificationText(chat, workbench, events);
  const fire = () => {
    try {
      const n = new Notification(title, { body, silent: false });
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
