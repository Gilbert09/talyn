import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { app, dialog, ipcMain, type BrowserWindow } from 'electron';

export type ReviewRankingExportResult =
  | { status: 'saved' | 'canceled' }
  | { status: 'error'; message: string };

const MAX_EXPORT_BYTES = 256 * 1024 * 1024;

function validExport(data: unknown): data is string {
  if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_EXPORT_BYTES) return false;
  try {
    const value = JSON.parse(data);
    return value?.schema_version === 1 && Array.isArray(value.events)
      && typeof value.archive_available === 'boolean'
      && (value.archive === null || (typeof value.archive === 'object' && !Array.isArray(value.archive)));
  } catch {
    return false;
  }
}

export function registerReviewRankingExport(getWindow: () => BrowserWindow | null): void {
  let saving = false;
  ipcMain.handle('review-ranking:export', async (event, data: unknown): Promise<ReviewRankingExportResult> => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) {
      return { status: 'error', message: 'Export is only available from the main window.' };
    }
    if (saving) return { status: 'error', message: 'An export is already in progress.' };
    if (!validExport(data)) return { status: 'error', message: 'The ranking export is invalid or too large.' };

    saving = true;
    let temporaryPath: string | undefined;
    try {
      const result = await dialog.showSaveDialog(window, {
        title: 'Export ranking data',
        defaultPath: path.join(app.getPath('downloads'), 'talyn-review-ranking.json'),
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (result.canceled || !result.filePath) return { status: 'canceled' };

      // Write beside the destination. A failed write must preserve an earlier export.
      temporaryPath = path.join(path.dirname(result.filePath), `.talyn-ranking-${randomUUID()}.tmp`);
      await fs.writeFile(temporaryPath, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await fs.rename(temporaryPath, result.filePath);
      return { status: 'saved' };
    } catch {
      return { status: 'error', message: 'Could not save ranking data. Check the folder and try again.' };
    } finally {
      if (temporaryPath) await fs.rm(temporaryPath, { force: true }).catch(() => {});
      saving = false;
    }
  });
}
