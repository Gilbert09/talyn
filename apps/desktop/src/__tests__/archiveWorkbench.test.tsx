import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LocalWorktreeStatus, Workbench } from '@talyn/shared';
import {
  ArchiveWorkbenchDialog,
  archiveWorkbench,
  archiveWorkbenches,
  restoreWorkbench,
} from '../renderer/components/workbench/archiveWorkbench';
import { api } from '../renderer/lib/api';
import { toast } from '../renderer/stores/toast';

const bridge = {
  inspectWorktree: jest.fn<Promise<LocalWorktreeStatus>, [string]>(),
  removeWorktree: jest.fn(async (_input: { path: string; workbenchId: string; force?: boolean }) => {}),
  restoreWorktree: jest.fn(),
  takeOverWorktree: jest.fn(),
  repoPaths: { get: jest.fn(async () => ({})), detect: jest.fn(async () => ({})) },
  stopWorkbench: jest.fn(async () => {}),
  preview: { stop: jest.fn(async () => {}) },
};

jest.mock('../renderer/lib/workbenchBridge', () => ({
  ...jest.requireActual('../renderer/lib/workbenchBridge'),
  getWorkbenchBridge: () => bridge,
  getDeviceId: () => 'dev1',
}));
jest.mock('../renderer/lib/api', () => ({
  api: { workbenches: { archive: jest.fn(), archiveMany: jest.fn(), restore: jest.fn(), update: jest.fn() } },
}));
jest.mock('../renderer/lib/coderPreview', () => ({ stopCoderPreview: jest.fn() }));
jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const WB = {
  id: 'wb1',
  workspaceId: 'ws1',
  name: 'lisbon',
  title: null,
  branch: 'tom/lisbon',
  baseBranch: 'main',
  runtime: 'local',
  deviceId: 'dev1',
  localPath: '/Users/tom/talyn/workbenches/app-1/lisbon',
  status: 'ready',
  archivedAt: null,
} as unknown as Workbench;

const status = (over: Partial<LocalWorktreeStatus> = {}): LocalWorktreeStatus => ({
  managed: true,
  exists: true,
  branch: 'tom/lisbon',
  uncommitted: [],
  uncommittedCount: 0,
  unpushed: 0,
  ...over,
});

const archive = api.workbenches.archive as jest.Mock;
const archiveMany = api.workbenches.archiveMany as jest.Mock;
const restore = api.workbenches.restore as jest.Mock;
const update = api.workbenches.update as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  archive.mockResolvedValue({ ...WB, status: 'archived', archivedAt: '2026-11-01T00:00:00Z' });
  restore.mockResolvedValue(WB);
  update.mockResolvedValue(WB);
  bridge.repoPaths.get.mockResolvedValue({});
  bridge.repoPaths.detect.mockResolvedValue({});
});
afterEach(cleanup);

function renderDialog(workbench: Partial<Workbench> = {}) {
  const onConfirm = jest.fn();
  render(
    <ArchiveWorkbenchDialog
      workbench={{ ...WB, ...workbench }}
      open
      busy={false}
      onConfirm={onConfirm}
      onCancel={jest.fn()}
    />
  );
  return { onConfirm };
}

describe('ArchiveWorkbenchDialog', () => {
  it('warns that uncommitted changes are lost, names them, and confirms with discardChanges', async () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'];
    bridge.inspectWorktree.mockResolvedValue(status({ uncommitted: files, uncommittedCount: 9, unpushed: 2 }));
    const { onConfirm } = renderDialog();

    expect(await screen.findByText(/Its 9 uncommitted changes will be lost/)).toBeInTheDocument();
    for (const file of files.slice(0, 5)) expect(screen.getByText(file)).toBeInTheDocument();
    expect(screen.queryByText('f.ts')).not.toBeInTheDocument();
    expect(screen.getByText('and 4 more')).toBeInTheDocument();
    expect(screen.getByText(/2 commits are not pushed. They stay on the local branch tom\/lisbon/)).toBeInTheDocument();
    expect(bridge.inspectWorktree).toHaveBeenCalledWith(WB.localPath);

    fireEvent.click(screen.getByRole('button', { name: 'Archive and lose changes' }));
    expect(onConfirm).toHaveBeenCalledWith({ discardChanges: true });
  });

  it('says the folder is deleted for a clean worktree, and confirms without discardChanges', async () => {
    bridge.inspectWorktree.mockResolvedValue(status({ unpushed: 1 }));
    const { onConfirm } = renderDialog();

    expect(await screen.findByText(/deletes the worktree folder .* from this computer/)).toBeInTheDocument();
    expect(screen.getByText(/1 commit is not pushed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(onConfirm).toHaveBeenCalledWith({ discardChanges: false });
  });

  it('keeps Archive off while it checks the worktree', async () => {
    bridge.inspectWorktree.mockReturnValue(new Promise(() => {}));
    renderDialog();
    expect(await screen.findByText('Checking the worktree for changes…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
  });

  it('never discards changes when the check failed', async () => {
    bridge.inspectWorktree.mockRejectedValue(new Error('git failed'));
    const { onConfirm } = renderDialog();
    expect(await screen.findByText(/could not check the folder for changes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(onConfirm).toHaveBeenCalledWith({ discardChanges: false });
  });

  it.each([
    ['a sandbox session', { runtime: 'sandbox' as const, localPath: null }],
    ['a local session on another computer', { deviceId: 'dev2' }],
  ])('does not check %s', async (_name, over) => {
    renderDialog(over);
    expect(screen.getByRole('button', { name: 'Archive' })).toBeEnabled();
    expect(bridge.inspectWorktree).not.toHaveBeenCalled();
    expect(screen.queryByText(/worktree folder/)).not.toBeInTheDocument();
  });
});

describe('archiveWorkbench', () => {
  it.each([
    [{ discardChanges: true }, true],
    [{}, false],
  ])('archives first, then removes the worktree with the session id (%p)', async (opts, force) => {
    expect(await archiveWorkbench('wb1', false, opts)).toBe(true);
    expect(archive).toHaveBeenCalledWith('wb1');
    expect(bridge.stopWorkbench).toHaveBeenCalledWith('wb1');
    expect(bridge.removeWorktree).toHaveBeenCalledWith({ path: WB.localPath, workbenchId: 'wb1', force });
    expect(archive.mock.invocationCallOrder[0]).toBeLessThan(bridge.removeWorktree.mock.invocationCallOrder[0]);
  });

  it('leaves the worktree of a session on another computer alone', async () => {
    archive.mockResolvedValue({ ...WB, deviceId: 'dev2', archivedAt: '2026-11-01T00:00:00Z' });
    await archiveWorkbench('wb1', false);
    expect(bridge.removeWorktree).not.toHaveBeenCalled();
  });

  it('removes nothing when the archive itself failed', async () => {
    archive.mockRejectedValue(new Error('offline'));
    expect(await archiveWorkbench('wb1', false, { discardChanges: true })).toBe(false);
    expect(bridge.removeWorktree).not.toHaveBeenCalled();
  });

  it('says where the folder stays when git refuses to remove it', async () => {
    bridge.removeWorktree.mockRejectedValueOnce(
      new Error("Error invoking remote method 'workbench:remove-worktree': Error: The worktree has uncommitted changes, so Talyn kept it.")
    );
    expect(await archiveWorkbench('wb1', false)).toBe(true);
    expect(toast.error).toHaveBeenCalledWith(
      'Could not delete the worktree',
      `The worktree has uncommitted changes, so Talyn kept it. The session is archived. Its folder stays at ${WB.localPath}.`
    );
  });
});

describe('archiveWorkbenches', () => {
  const archivedRow = (id: string, over: Partial<Workbench> = {}) =>
    ({ ...WB, id, localPath: `/wt/${id}`, status: 'archived', archivedAt: '2026-11-01T00:00:00Z', ...over }) as Workbench;

  it('archives every session in one request, then cleans up each one here', async () => {
    archiveMany.mockResolvedValue({
      archived: [archivedRow('wb1'), archivedRow('wb2'), archivedRow('wb3', { runtime: 'sandbox', localPath: null })],
      failed: [],
    });
    expect(await archiveWorkbenches(['wb1', 'wb2', 'wb3'], null)).toBe(3);
    expect(archiveMany).toHaveBeenCalledTimes(1);
    expect(archiveMany).toHaveBeenCalledWith(['wb1', 'wb2', 'wb3']);
    expect(archive).not.toHaveBeenCalled();
    expect(bridge.removeWorktree.mock.calls.map(([input]) => input).sort((a, b) => a.workbenchId.localeCompare(b.workbenchId))).toEqual([
      { path: '/wt/wb1', workbenchId: 'wb1', force: false },
      { path: '/wt/wb2', workbenchId: 'wb2', force: false },
    ]);
    expect(bridge.preview.stop).toHaveBeenCalledTimes(3);
    expect(toast.success).toHaveBeenCalledWith('Archived 3 sessions');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('archives the others and says which failed when the server refuses some ids', async () => {
    archiveMany.mockResolvedValue({
      archived: [archivedRow('wb1')],
      failed: [{ id: 'wb2', error: 'Session not found' }],
    });
    expect(await archiveWorkbenches(['wb1', 'wb2'], null)).toBe(1);
    expect(bridge.removeWorktree).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Archived 1 session');
    expect(toast.error).toHaveBeenCalledWith('Could not archive 1 session', 'Session not found');
  });

  it('says which sessions stayed because they work now, apart from real failures', async () => {
    archiveMany.mockResolvedValue({
      archived: [archivedRow('wb1')],
      failed: [
        { id: 'wb2', error: 'The session has a running background job.', busy: true },
        { id: 'wb3', error: 'Session not found' },
      ],
    });
    expect(await archiveWorkbenches(['wb1', 'wb2', 'wb3'], null)).toBe(1);
    expect(toast.info).toHaveBeenCalledWith('Kept 1 session that works now', 'The session has a running background job.');
    expect(toast.error).toHaveBeenCalledWith('Could not archive 1 session', 'Session not found');
  });

  it('shows no error when every refused session works now', async () => {
    archiveMany.mockResolvedValue({
      archived: [],
      failed: [
        { id: 'wb1', error: 'The session works now.', busy: true },
        { id: 'wb2', error: 'The session has a scheduled wake-up.', busy: true },
      ],
    });
    expect(await archiveWorkbenches(['wb1', 'wb2'], null)).toBe(0);
    expect(toast.info).toHaveBeenCalledWith('Kept 2 sessions that work now', 'The session works now.');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('removes nothing when the request failed', async () => {
    archiveMany.mockRejectedValue(new Error('offline'));
    expect(await archiveWorkbenches(['wb1', 'wb2'], null)).toBe(0);
    expect(bridge.removeWorktree).not.toHaveBeenCalled();
    expect(bridge.stopWorkbench).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Could not archive the sessions', 'offline');
  });

  it('sends nothing for an empty list', async () => {
    expect(await archiveWorkbenches([], null)).toBe(0);
    expect(archiveMany).not.toHaveBeenCalled();
  });
});

describe('restoreWorkbench', () => {
  const archived = { ...WB, status: 'archived', archivedAt: '2026-11-01T00:00:00Z' } as Workbench;

  it('makes the worktree again from the branch, then restores the row', async () => {
    bridge.restoreWorktree.mockResolvedValue({ ok: true, branch: 'tom/lisbon' });
    expect(await restoreWorkbench(archived)).toEqual(WB);
    expect(bridge.restoreWorktree).toHaveBeenCalledWith({ path: WB.localPath, workbenchId: 'wb1', branch: 'tom/lisbon' });
    expect(bridge.restoreWorktree.mock.invocationCallOrder[0]).toBeLessThan(restore.mock.invocationCallOrder[0]);
  });

  it('says clearly that the branch was deleted, and keeps the session archived', async () => {
    const message = 'The branch tom/lisbon was deleted from /repo, so Talyn cannot make the worktree again. The session stays in History.';
    bridge.restoreWorktree.mockResolvedValue({ ok: false, reason: 'branch_missing', message });
    expect(await restoreWorkbench(archived)).toBeNull();
    expect(restore).not.toHaveBeenCalled();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not restore the session', message));
  });

  it('restores read-only when this computer has no checkout', async () => {
    const foreign = { ...archived, deviceId: 'dev2', status: 'ready', archivedAt: null } as Workbench;
    restore.mockResolvedValueOnce(foreign);
    expect(await restoreWorkbench({ ...archived, deviceId: 'dev2' })).toEqual(foreign);
    expect(bridge.restoreWorktree).not.toHaveBeenCalled();
    expect(bridge.takeOverWorktree).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledWith('wb1');
  });

  it('takes over a remote branch before restoring the session', async () => {
    bridge.repoPaths.get.mockResolvedValue({ 'owner/repo': '/checkout' });
    bridge.takeOverWorktree.mockResolvedValue({ ok: true, branch: 'tom/lisbon', path: '/managed/repo/lisbon' });
    await restoreWorkbench({ ...archived, repoFullName: 'owner/repo', deviceId: 'dev2' });
    expect(bridge.takeOverWorktree).toHaveBeenCalledWith({
      repoPath: '/checkout', repoFullName: 'owner/repo', workbenchId: 'wb1', name: 'lisbon',
      branch: 'tom/lisbon', baseBranch: 'main',
    });
    expect(update).toHaveBeenCalledWith('wb1', { deviceId: 'dev1', localPath: '/managed/repo/lisbon' });
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(restore.mock.invocationCallOrder[0]);
  });

  it('restores read-only when the branch is absent from the remote', async () => {
    bridge.repoPaths.get.mockResolvedValue({ 'owner/repo': '/checkout' });
    bridge.takeOverWorktree.mockResolvedValue({ ok: false, reason: 'branch_missing', message: 'Not on remote' });
    const foreign = { ...archived, deviceId: 'dev2', status: 'ready', archivedAt: null } as Workbench;
    restore.mockResolvedValueOnce(foreign);
    expect(await restoreWorkbench({ ...archived, repoFullName: 'owner/repo', deviceId: 'dev2' })).toEqual(foreign);
    expect(update).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledWith('wb1');
  });

  it('restores a sandbox session through the backend only', async () => {
    await restoreWorkbench({ ...archived, runtime: 'sandbox', localPath: null });
    expect(bridge.restoreWorktree).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledWith('wb1');
  });
});
