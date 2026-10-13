import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { setChatFinishedListener, useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';

/**
 * "Your agent finished" — an OS notification when a chat goes from running to
 * idle (or error) while the window is not focused. The store marks the chat
 * unread on its own; this only adds the notification and its click-through.
 */
function notifyChatFinished(chat: WorkbenchChat, workbench: Workbench | undefined): void {
  if (typeof document !== 'undefined' && document.hasFocus()) return;
  if (typeof Notification === 'undefined') return;
  const title = workbench ? `${workbench.name} — ${chat.status === 'error' ? 'stopped with an error' : 'done'}` : 'Agent done';
  const body = chat.status === 'error' ? `${chat.title} needs a look.` : `${chat.title} is waiting for you.`;
  const fire = () => {
    try {
      const n = new Notification(`Talyn — ${title}`, { body, silent: false });
      n.onclick = () => {
        try {
          window.focus();
          useWorkspaceStore.getState().setActivePanel('workbenches');
          const store = useWorkbenchStore.getState();
          store.selectWorkbench(chat.workbenchId);
          store.selectChat(chat.workbenchId, chat.id);
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
