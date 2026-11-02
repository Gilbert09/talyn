import type { MergeQueueReviewWaitEvent } from '@talyn/shared';
import { openExternal } from './openExternal';
import { toast } from '../stores/toast';

export function notifyMergeQueueReviewWait(p: MergeQueueReviewWaitEvent, enabled: boolean): void {
  if (!enabled) return;

  const message = `#${p.number} is still waiting for a review`;
  toast.info(message, undefined, { label: 'Open PR', onClick: () => { void openExternal(p.url); } });
  if (typeof Notification === 'undefined') return;

  const fire = () => {
    try {
      const notification = new Notification('Talyn — merge queue', { body: message });
      notification.onclick = () => {
        window.focus();
        void openExternal(p.url);
      };
    } catch {
      // The in-app reminder is already visible.
    }
  };
  if (Notification.permission === 'granted') fire();
  else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((permission) => {
      if (permission === 'granted') fire();
    }).catch(() => {});
  }
}
