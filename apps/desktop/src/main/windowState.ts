/**
 * Window size and position, remembered across restarts.
 *
 * Persisted in userData rather than renderer storage for the same reason the
 * update channel is: the MAIN process needs it at `new BrowserWindow(...)`
 * time, which is before a renderer exists to ask.
 *
 * The restart that prompted this is the one nobody chooses — an update
 * installs itself and the app comes back as a 1024x728 rectangle in the middle
 * of the screen, losing whatever the window was.
 */
import { app, screen, type BrowserWindow, type Rectangle } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface WindowState {
  bounds?: Rectangle;
  /** Restored maximized. Tracked separately because the BOUNDS we store are
   *  the un-maximized ones — see {@link captureState}. */
  maximized?: boolean;
  fullScreen?: boolean;
}

/** The size a first run gets, and the fall-back for an unusable saved state. */
export const DEFAULT_BOUNDS = { width: 1024, height: 728 } as const;

function statePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

/**
 * The saved state, or `{}` on a first run, an unreadable file, or one written
 * by a future version in a shape this build does not understand.
 *
 * Every field is validated rather than trusted. This file is small enough to
 * be corrupted by a power cut mid-write, and the failure it would otherwise
 * cause — a window sized NaN, or positioned at a coordinate no display covers
 * — is one the user cannot get out of without finding this file themselves.
 */
export function readWindowState(): WindowState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as WindowState;
    const state: WindowState = {};
    if (isUsableBounds(raw.bounds)) state.bounds = raw.bounds;
    if (raw.maximized === true) state.maximized = true;
    if (raw.fullScreen === true) state.fullScreen = true;
    return state;
  } catch {
    return {};
  }
}

function writeWindowState(state: WindowState): void {
  try {
    mkdirSync(path.dirname(statePath()), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(state), 'utf8');
  } catch {
    // Losing the window size is not worth a crash, or a dialog, or a log line
    // on every resize of a machine with a full disk.
  }
}

function isUsableBounds(bounds: Rectangle | undefined): bounds is Rectangle {
  if (!bounds) return false;
  const { x, y, width, height } = bounds;
  return (
    [x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    width > 0 &&
    height > 0
  );
}

/**
 * Whether a saved rectangle still lands somewhere the user can reach it.
 *
 * The case this exists for: the window was last closed on an external monitor
 * that is now unplugged, or the display arrangement changed. Restoring those
 * coordinates puts the window off-screen, where it is invisible, unfocusable
 * and — because it never appears — indistinguishable from the app failing to
 * start.
 *
 * Intersection rather than containment: a window deliberately hanging off the
 * edge of a display is a normal thing to have done, and forcing it fully
 * on-screen would move a window the user had put where they wanted it. What
 * matters is that enough of it overlaps a display to be grabbed.
 */
export function isOnSomeDisplay(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    );
  });
}

/**
 * The `BrowserWindow` options that restore the last session, or the defaults.
 *
 * A saved size is honoured even when the position is not: a smaller display
 * than last time is a reason to move the window, not to forget how big the
 * user likes it. Position is dropped by omitting x/y, which is what makes
 * Electron centre the window — the one placement guaranteed to be reachable.
 */
export function restoredWindowOptions(state: WindowState): {
  width: number;
  height: number;
  x?: number;
  y?: number;
  fullscreen?: boolean;
} {
  const bounds = state.bounds;
  if (!bounds) return { ...DEFAULT_BOUNDS };
  const size = { width: bounds.width, height: bounds.height };
  return {
    ...size,
    ...(isOnSomeDisplay(bounds) ? { x: bounds.x, y: bounds.y } : {}),
    ...(state.fullScreen ? { fullscreen: true } : {}),
  };
}

/**
 * Read the live window's state, ready to persist.
 *
 * `getNormalBounds`, never `getBounds`: while a window is maximized or full
 * screen the latter reports the screen, so saving it would make un-maximizing
 * a no-op forever after — the window would "restore" to exactly the size it
 * was maximized to. The normal bounds are what the user had before they
 * maximized, which is what they get back.
 */
export function captureState(window: BrowserWindow): WindowState {
  return {
    bounds: window.getNormalBounds(),
    ...(window.isMaximized() ? { maximized: true } : {}),
    ...(window.isFullScreen() ? { fullScreen: true } : {}),
  };
}

/**
 * How long after the last resize/move event to write.
 *
 * Dragging a window edge emits these continuously, so they are coalesced.
 * The value only decides how much of a drag a hard kill could lose, and a
 * quarter second is below the pause between "stopped dragging" and "did
 * something else" — not a threshold anything depends on.
 */
const WRITE_DEBOUNCE_MS = 250;

/**
 * Keep `window`'s state on disk for the next launch.
 *
 * Saves on the events that change it, and once more on `close` — which is the
 * one that catches an update installing itself, since `quitAndInstall` closes
 * the window rather than killing the process.
 */
export function trackWindowState(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;

  const save = (): void => {
    if (window.isDestroyed()) return;
    writeWindowState(captureState(window));
  };

  const scheduleSave = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, WRITE_DEBOUNCE_MS);
  };

  window.on('resize', scheduleSave);
  window.on('move', scheduleSave);
  window.on('maximize', scheduleSave);
  window.on('unmaximize', scheduleSave);
  // Not debounced: the window is about to stop existing, and a pending timer
  // would fire against a destroyed one.
  window.on('close', () => {
    if (timer) clearTimeout(timer);
    save();
  });
  // Entering full screen is the one transition worth writing immediately —
  // macOS animates it, and the resize events it emits along the way describe
  // frames of the animation rather than a size anybody chose.
  window.on('enter-full-screen', save);
  window.on('leave-full-screen', save);
}
