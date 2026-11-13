/**
 * Window zoom, remembered across restarts.
 *
 * Electron forgets the zoom of a `file://` page when the app quits, so the
 * factor is saved in userData and applied again on each load.
 */
import { app, ipcMain, BrowserWindow } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ZOOM_CHANGED_CHANNEL,
  ZOOM_GET_CHANNEL,
  ZOOM_STEP_CHANNEL,
  isZoomStep,
  nextZoomFactor,
  parseZoomFactor,
  zoomAliasForInput,
  type ZoomStep,
} from './zoomSteps';

function zoomPath(): string {
  return path.join(app.getPath('userData'), 'zoom.json');
}

function readZoomFactor(): number {
  try {
    const raw = JSON.parse(readFileSync(zoomPath(), 'utf8')) as { factor?: unknown };
    return parseZoomFactor(raw.factor);
  } catch {
    return parseZoomFactor(undefined);
  }
}

function writeZoomFactor(factor: number): void {
  try {
    mkdirSync(path.dirname(zoomPath()), { recursive: true });
    writeFileSync(zoomPath(), JSON.stringify({ factor }), 'utf8');
  } catch {
    // The zoom still applies for this run.
  }
}

let current: number | null = null;

function zoomFactor(): number {
  if (current === null) current = readZoomFactor();
  return current;
}

export function stepWindowZoom(win: BrowserWindow, step: ZoomStep): number {
  const next = nextZoomFactor(zoomFactor(), step);
  current = next;
  writeZoomFactor(next);
  if (!win.isDestroyed()) {
    win.webContents.setZoomFactor(next);
    win.webContents.send(ZOOM_CHANGED_CHANNEL, next);
  }
  return next;
}

/** Apply the saved zoom on every load, and take the alias chords the menu cannot own. */
export function trackWindowZoom(win: BrowserWindow): void {
  const { webContents } = win;
  webContents.on('did-finish-load', () => {
    webContents.setZoomFactor(zoomFactor());
  });
  webContents.on('before-input-event', (event, input) => {
    const step = zoomAliasForInput(input, process.platform === 'darwin');
    if (!step) return;
    event.preventDefault();
    stepWindowZoom(win, step);
  });
}

export function registerZoomIpc(): void {
  ipcMain.handle(ZOOM_GET_CHANNEL, () => zoomFactor());
  ipcMain.handle(ZOOM_STEP_CHANNEL, (event, step: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !isZoomStep(step)) return zoomFactor();
    return stepWindowZoom(win, step);
  });
}
