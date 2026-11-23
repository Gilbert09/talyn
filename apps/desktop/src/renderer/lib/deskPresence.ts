import { startDeskPresenceHeartbeat, type DeskActivitySource } from '@talyn/client';
import type { DeskPresenceState } from '@talyn/shared';
import { wsClient } from './api';

/**
 * Tell the backend while the person is using this computer, so it skips the
 * phone push the desktop notification already covers. The main process reads
 * system idle and screen lock (`main/deskPresence.ts`); this sends `active`
 * every 30 seconds while that holds and one `away` when it stops.
 */
export interface DeskPresenceBridge {
  getState(): Promise<DeskPresenceState>;
  onChange(callback: () => void): () => void;
}

export interface DeskPresenceClient {
  setDeskPresence(state: DeskPresenceState): void;
}

export function installDeskPresence(
  bridge: DeskPresenceBridge | undefined = window.electron?.deskPresence,
  client: DeskPresenceClient = wsClient,
): () => void {
  // An older preload has no bridge; then the backend never hears `active` and the phone gets every push.
  if (!bridge) return () => undefined;
  const source: DeskActivitySource = {
    read: () => bridge.getState(),
    subscribe: (onChange) => bridge.onChange(onChange),
  };
  return startDeskPresenceHeartbeat(source, (state) => client.setDeskPresence(state));
}
