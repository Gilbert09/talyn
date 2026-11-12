import { ipcMain, powerMonitor, type BrowserWindow } from 'electron';
import { DESK_PRESENCE_CHANGED_CHANNEL, DESK_PRESENCE_CHANNEL, type DeskState } from './deskPresenceChannels';

/**
 * Desk presence for the renderer: is the person using this computer?
 *
 * The answer is SYSTEM input (keyboard or pointer anywhere, not only in Talyn)
 * within the last three minutes, with the screen unlocked and the machine
 * awake. The renderer sends it to the backend, which skips a mobile push while
 * it holds. Only `active` or `away` leaves this module: no idle time, no app
 * or window names.
 */
export const DESK_IDLE_SECONDS = 180;

type IdleState = 'active' | 'idle' | 'locked' | 'unknown';

/** Pure decision, exported so it can be tested without Electron. */
export function deskStateFrom(input: {
  idleState: IdleState;
  /** Read only when the idle state is unknown. */
  idleSeconds: () => number;
  locked: boolean;
  suspended: boolean;
}): DeskState {
  if (input.locked || input.suspended) return 'away';
  if (input.idleState === 'active') return 'active';
  if (input.idleState !== 'unknown') return 'away';
  // Some Linux sessions cannot report an idle state; the idle time may still work.
  return input.idleSeconds() < DESK_IDLE_SECONDS ? 'active' : 'away';
}

export function registerDeskPresence(getWindow: () => BrowserWindow | null): void {
  let locked = false;
  let suspended = false;

  const read = (): DeskState => {
    try {
      return deskStateFrom({
        idleState: powerMonitor.getSystemIdleState(DESK_IDLE_SECONDS),
        idleSeconds: () => powerMonitor.getSystemIdleTime(),
        locked,
        suspended,
      });
    } catch {
      // No signal means no claim to be at the desk, so the phone still gets the alert.
      return 'away';
    }
  };

  ipcMain.handle(DESK_PRESENCE_CHANNEL, (event): DeskState => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) return 'away';
    return read();
  });

  const changed = () => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(DESK_PRESENCE_CHANGED_CHANNEL);
  };
  powerMonitor.on('lock-screen', () => { locked = true; changed(); });
  powerMonitor.on('unlock-screen', () => { locked = false; changed(); });
  powerMonitor.on('suspend', () => { suspended = true; changed(); });
  powerMonitor.on('resume', () => { suspended = false; changed(); });
}
