/**
 * Auto-update wiring. Uses electron-updater against the GitHub Releases feed
 * configured in package.json `build.publish` (the public `owl-releases` repo).
 *
 * The main process drives the whole flow — checking, downloading, and applying
 * — and forwards normalized `UpdaterEvent`s to the renderer over the
 * `updater:event` channel so the sidebar's UpdateNotice can react. The renderer
 * triggers a manual check or the restart via the `updater:check` /
 * `updater:quit-and-install` invoke handlers.
 *
 * macOS note: Squirrel.Mac only applies updates from a signed + notarized
 * build. Until an Apple Developer ID cert is wired (see package.json
 * build.mac.notarize), this runs but never successfully installs on mac.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import type { UpdaterEvent } from './updaterEvents';

// Re-check this often while the app stays open, so long-running sessions
// still pick up releases without a restart.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h
// Small delay after window-ready so we don't compete with first paint.
const INITIAL_CHECK_DELAY_MS = 10 * 1000;

let checkTimer: ReturnType<typeof setInterval> | null = null;

export function initAutoUpdater(getWindow: () => BrowserWindow | null) {
  autoUpdater.logger = log;
  log.transports.file.level = 'info';
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const send = (event: UpdaterEvent) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('updater:event', event);
    }
  };

  autoUpdater.on('checking-for-update', () => send({ kind: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    send({ kind: 'available', version: info.version }),
  );
  autoUpdater.on('update-not-available', () => send({ kind: 'not-available' }));
  autoUpdater.on('download-progress', (progress) =>
    send({ kind: 'progress', percent: Math.round(progress.percent) }),
  );
  autoUpdater.on('update-downloaded', (info) =>
    send({ kind: 'downloaded', version: info.version }),
  );
  autoUpdater.on('error', (err) =>
    send({ kind: 'error', message: err?.message ?? String(err) }),
  );

  // Renderer-driven controls.
  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) return;
    await autoUpdater.checkForUpdates();
  });
  ipcMain.handle('updater:quit-and-install', () => {
    autoUpdater.quitAndInstall();
  });

  // electron-updater can't resolve an update from an unpackaged dev tree
  // unless a dev-app-update.yml is present; gate background checks on
  // isPackaged so dev runs stay quiet (manual check above also no-ops).
  if (!app.isPackaged) {
    log.info('[updater] skipping auto-check (app not packaged)');
    return;
  }

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => log.error('[updater]', err));
  }, INITIAL_CHECK_DELAY_MS);

  checkTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => log.error('[updater]', err));
  }, CHECK_INTERVAL_MS);

  app.on('before-quit', () => {
    if (checkTimer) clearInterval(checkTimer);
  });
}
