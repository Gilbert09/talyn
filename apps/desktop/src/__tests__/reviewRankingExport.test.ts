/** @jest-environment node */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { registerReviewRankingExport, type ReviewRankingExportResult } from '../main/reviewRankingExport';

jest.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  dialog: { showSaveDialog: jest.fn() },
  ipcMain: { handle: jest.fn() },
}));

const data = JSON.stringify({ schema_version: 1, events: [], archive_available: true, archive: null });
const webContents = { mainFrame: {} };
const window = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
const event = { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent;
let directory: string;
let destination: string;
let invoke: (source: IpcMainInvokeEvent, payload: unknown) => Promise<ReviewRankingExportResult>;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-ranking-export-'));
  destination = path.join(directory, 'ranking.json');
  jest.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: destination });
  registerReviewRankingExport(() => window);
  invoke = jest.mocked(ipcMain.handle).mock.calls.at(-1)![1];
});

afterEach(async () => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it.each([false, true])('saves complete JSON when an export already exists: %s', async (exists) => {
  if (exists) await fs.writeFile(destination, 'earlier export');
  expect(await invoke(event, data)).toEqual({ status: 'saved' });
  expect(await fs.readFile(destination, 'utf8')).toBe(data);
  expect(await fs.readdir(directory)).toEqual(['ranking.json']);
  if (process.platform !== 'win32') expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
  expect(dialog.showSaveDialog).toHaveBeenCalledWith(window, expect.objectContaining({
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: expect.arrayContaining(['showOverwriteConfirmation']),
  }));
});

it.each([{ canceled: true, filePath: '' }, { canceled: false, filePath: '' }])(
  'does not write when the dialog has no accepted destination: %j', async (result) => {
    jest.mocked(dialog.showSaveDialog).mockResolvedValue(result);
    expect(await invoke(event, data)).toEqual({ status: 'canceled' });
    expect(await fs.readdir(directory)).toEqual([]);
  },
);

it.each([null, 1, '', '{', '{}', '[]', '{"schema_version":2,"events":[]}',
  '{"schema_version":1,"events":[],"archive_available":true,"archive":[]}'])(
  'rejects invalid input before showing a dialog: %j', async (payload) => {
  expect(await invoke(event, payload)).toMatchObject({ status: 'error' });
  expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  expect(await fs.readdir(directory)).toEqual([]);
  },
);

it('refuses an oversized export before parsing it', async () => {
  jest.spyOn(Buffer, 'byteLength').mockReturnValue(256 * 1024 * 1024 + 1);
  expect(await invoke(event, data)).toMatchObject({ status: 'error' });
  expect(dialog.showSaveDialog).not.toHaveBeenCalled();
});

it.each([
  { sender: {}, senderFrame: webContents.mainFrame },
  { sender: webContents, senderFrame: {} },
])('refuses another window or a child frame', async (source) => {
  expect(await invoke(source as IpcMainInvokeEvent, data)).toMatchObject({ status: 'error' });
  expect(dialog.showSaveDialog).not.toHaveBeenCalled();
});

it.each([null, { ...window, isDestroyed: () => true }])('refuses an absent or closed main window', async (source) => {
  registerReviewRankingExport(() => source as BrowserWindow | null);
  invoke = jest.mocked(ipcMain.handle).mock.calls.at(-1)![1];
  expect(await invoke(event, data)).toMatchObject({ status: 'error' });
  expect(dialog.showSaveDialog).not.toHaveBeenCalled();
});

it.each(['writeFile', 'rename'] as const)('preserves the earlier export when %s fails', async (operation) => {
  await fs.writeFile(destination, 'earlier export');
  jest.spyOn(fs, operation).mockRejectedValueOnce(new Error('disk failure'));
  expect(await invoke(event, data)).toMatchObject({ status: 'error' });
  expect(await fs.readFile(destination, 'utf8')).toBe('earlier export');
  expect(await fs.readdir(directory)).toEqual(['ranking.json']);
  expect(await invoke(event, data)).toEqual({ status: 'saved' });
});

it('reports a dialog failure and permits a later attempt', async () => {
  jest.mocked(dialog.showSaveDialog).mockRejectedValueOnce(new Error('dialog failure'));
  expect(await invoke(event, data)).toMatchObject({ status: 'error' });
  expect(await invoke(event, data)).toEqual({ status: 'saved' });
});

it('allows only one pending export', async () => {
  let cancel!: (value: { canceled: boolean; filePath: string }) => void;
  jest.mocked(dialog.showSaveDialog).mockReturnValueOnce(new Promise((resolve) => { cancel = resolve; }));
  const pending = invoke(event, data);
  expect(await invoke(event, data)).toMatchObject({ status: 'error' });
  expect(dialog.showSaveDialog).toHaveBeenCalledTimes(1);
  cancel({ canceled: true, filePath: '' });
  expect(await pending).toEqual({ status: 'canceled' });
  expect(await invoke(event, data)).toEqual({ status: 'saved' });
});
