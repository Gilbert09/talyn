import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Remembering the window across restarts.
 *
 * The restart that prompted this is the one nobody chooses — an update
 * installs itself and the app comes back a default rectangle. Most of what
 * follows is about the ways a REMEMBERED window can be worse than a forgotten
 * one: restored off-screen where it cannot be grabbed, restored at the size it
 * was maximized to so un-maximizing does nothing, or restored from a file a
 * power cut truncated.
 */

let userDataDir: string;
let displays: Array<{ workArea: { x: number; y: number; width: number; height: number } }>;

jest.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  screen: { getAllDisplays: () => displays },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const windowState = require('../main/windowState') as typeof import('../main/windowState');
const { readWindowState, restoredWindowOptions, isOnSomeDisplay, captureState, DEFAULT_BOUNDS } =
  windowState;

/** One 1920x1080 display at the origin, which is every test's baseline. */
const PRIMARY = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };

function writeState(raw: unknown): void {
  fs.writeFileSync(path.join(userDataDir, 'window-state.json'), JSON.stringify(raw), 'utf8');
}

function writeRaw(text: string): void {
  fs.writeFileSync(path.join(userDataDir, 'window-state.json'), text, 'utf8');
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talyn-winstate-'));
  displays = [PRIMARY];
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('readWindowState', () => {
  it('round-trips a saved window', () => {
    writeState({ bounds: { x: 100, y: 80, width: 1400, height: 900 }, maximized: true });
    expect(readWindowState()).toEqual({
      bounds: { x: 100, y: 80, width: 1400, height: 900 },
      maximized: true,
    });
  });

  it.each([
    ['a first run, with no file at all', null],
    ['a file a power cut truncated', '{"bounds":{"x":1'],
    ['a file that is not JSON', 'not json'],
  ])('answers empty for %s', (_label, text) => {
    if (text !== null) writeRaw(text);
    expect(readWindowState()).toEqual({});
  });

  it.each([
    ['a NaN dimension', { x: 0, y: 0, width: NaN, height: 900 }],
    ['a zero width', { x: 0, y: 0, width: 0, height: 900 }],
    ['a negative height', { x: 0, y: 0, width: 1400, height: -900 }],
    ['a string where a number belongs', { x: '0', y: 0, width: 1400, height: 900 }],
    ['missing coordinates', { width: 1400, height: 900 }],
  ])('drops bounds with %s rather than restoring them', (_label, bounds) => {
    writeState({ bounds });
    expect(readWindowState().bounds).toBeUndefined();
  });

  it('treats a non-boolean maximized flag as not maximized', () => {
    writeState({ bounds: { x: 0, y: 0, width: 800, height: 600 }, maximized: 'yes' });
    expect(readWindowState().maximized).toBeUndefined();
  });
});

describe('isOnSomeDisplay', () => {
  it('accepts a window fully inside the work area', () => {
    expect(isOnSomeDisplay({ x: 100, y: 100, width: 800, height: 600 })).toBe(true);
  });

  it('accepts a window hanging off an edge — that is a placement, not a fault', () => {
    expect(isOnSomeDisplay({ x: -200, y: 40, width: 800, height: 600 })).toBe(true);
    expect(isOnSomeDisplay({ x: 1800, y: 40, width: 800, height: 600 })).toBe(true);
  });

  it('rejects a window on a display that is no longer connected', () => {
    // Saved on a second monitor to the right; that monitor is now unplugged.
    expect(isOnSomeDisplay({ x: 2400, y: 100, width: 800, height: 600 })).toBe(false);
  });

  it('accepts it again once that display is back', () => {
    displays = [PRIMARY, { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }];
    expect(isOnSomeDisplay({ x: 2400, y: 100, width: 800, height: 600 })).toBe(true);
  });

  it('handles a display arranged above or to the left (negative origin)', () => {
    displays = [{ workArea: { x: -1920, y: -200, width: 1920, height: 1080 } }];
    expect(isOnSomeDisplay({ x: -1000, y: 0, width: 800, height: 600 })).toBe(true);
    expect(isOnSomeDisplay({ x: 400, y: 0, width: 800, height: 600 })).toBe(false);
  });
});

describe('restoredWindowOptions', () => {
  it('uses the default size on a first run', () => {
    expect(restoredWindowOptions({})).toEqual({ ...DEFAULT_BOUNDS });
  });

  it('restores size and position when the position is still reachable', () => {
    expect(
      restoredWindowOptions({ bounds: { x: 120, y: 60, width: 1400, height: 900 } }),
    ).toEqual({ x: 120, y: 60, width: 1400, height: 900 });
  });

  it('keeps the SIZE but drops the position when the display has gone', () => {
    const options = restoredWindowOptions({
      bounds: { x: 2400, y: 100, width: 1400, height: 900 },
    });
    // A smaller display than last time is a reason to move the window, not to
    // forget how big the user likes it. Omitting x/y is what makes Electron
    // centre it — the one placement guaranteed to be reachable.
    expect(options).toEqual({ width: 1400, height: 900 });
    expect(options.x).toBeUndefined();
    expect(options.y).toBeUndefined();
  });

  it('asks for full screen in the constructor, not after showing', () => {
    expect(
      restoredWindowOptions({ bounds: { x: 0, y: 0, width: 1400, height: 900 }, fullScreen: true }),
    ).toMatchObject({ fullscreen: true });
  });

  it('does not set fullscreen when it was not saved', () => {
    expect(
      restoredWindowOptions({ bounds: { x: 0, y: 0, width: 1400, height: 900 } }),
    ).not.toHaveProperty('fullscreen');
  });
});

describe('captureState', () => {
  const fakeWindow = (over: {
    normal?: { x: number; y: number; width: number; height: number };
    maximized?: boolean;
    fullScreen?: boolean;
  }) =>
    ({
      getNormalBounds: () => over.normal ?? { x: 10, y: 20, width: 800, height: 600 },
      isMaximized: () => over.maximized ?? false,
      isFullScreen: () => over.fullScreen ?? false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  it('stores the NORMAL bounds of a maximized window, not the screen', () => {
    // getBounds() on a maximized window reports the screen. Saving that would
    // make un-maximizing a no-op forever after — the window would "restore" to
    // exactly the size it was maximized to.
    const state = captureState(
      fakeWindow({ normal: { x: 10, y: 20, width: 800, height: 600 }, maximized: true }),
    );
    expect(state.bounds).toEqual({ x: 10, y: 20, width: 800, height: 600 });
    expect(state.maximized).toBe(true);
  });

  it('records a plain window with no flags', () => {
    expect(captureState(fakeWindow({}))).toEqual({
      bounds: { x: 10, y: 20, width: 800, height: 600 },
    });
  });

  it('records full screen', () => {
    expect(captureState(fakeWindow({ fullScreen: true })).fullScreen).toBe(true);
  });

  it('survives a full round trip through disk', () => {
    const captured = captureState(
      fakeWindow({ normal: { x: 300, y: 150, width: 1600, height: 1000 }, maximized: true }),
    );
    writeState(captured);
    expect(readWindowState()).toEqual(captured);
    expect(restoredWindowOptions(readWindowState())).toEqual({
      x: 300,
      y: 150,
      width: 1600,
      height: 1000,
    });
  });
});
