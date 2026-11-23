import { DESK_PRESENCE_IDLE_MS, type DeskPresenceState } from '@talyn/shared';
import { startDeskPresenceHeartbeat, wsClient, type DeskActivitySource } from './api';

/**
 * Tell the backend while the person is using Talyn in this tab, so it skips the
 * phone push. Active means the tab is visible and had pointer or keyboard input
 * in the last three minutes. No Idle Detection API and no permission prompt: a
 * browser only sees input in its own page, so input in another app reads as
 * idle here, and the phone gets the alert.
 */
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

export function browserDeskActivity(
  doc: Document = document,
  now: () => number = () => Date.now(),
  idleMs: number = DESK_PRESENCE_IDLE_MS,
): DeskActivitySource {
  // Opening or showing the tab counts as input.
  let lastInput = now();
  const read = (): DeskPresenceState =>
    doc.visibilityState === 'visible' && now() - lastInput < idleMs ? 'active' : 'away';
  return {
    read,
    subscribe(onChange) {
      const onInput = () => {
        const wasActive = read() === 'active';
        lastInput = now();
        // Only the first input after idle can change the state; the rest are free.
        if (!wasActive) onChange();
      };
      const onVisibility = () => {
        if (doc.visibilityState === 'visible') lastInput = now();
        onChange();
      };
      for (const type of INPUT_EVENTS) doc.addEventListener(type, onInput, { passive: true, capture: true });
      doc.addEventListener('visibilitychange', onVisibility);
      return () => {
        for (const type of INPUT_EVENTS) doc.removeEventListener(type, onInput, { capture: true });
        doc.removeEventListener('visibilitychange', onVisibility);
      };
    },
  };
}

export interface DeskPresenceClient {
  setDeskPresence(state: DeskPresenceState): void;
}

export function installDeskPresence(
  source: DeskActivitySource = browserDeskActivity(),
  client: DeskPresenceClient = wsClient,
): () => void {
  return startDeskPresenceHeartbeat(source, (state) => client.setDeskPresence(state));
}
