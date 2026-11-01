import type { Workbench } from '@talyn/shared';
import { waitFor } from '@testing-library/react';
import { loadWorkbenches } from '../renderer/lib/workbenchData';
import { markDialogArchive, reconcileLocalArchive } from '../renderer/lib/localArchive';
import { useWorkbenchStore } from '../renderer/stores/workbenches';

const mockList = jest.fn();
const mockProcess = jest.fn();

jest.mock('../renderer/lib/api', () => ({ api: { workbenches: { list: (...args: unknown[]) => mockList(...args) } } }));
jest.mock('../renderer/lib/workbenchBridge', () => ({
  getWorkbenchBridge: () => ({ processArchivedWorktree: (...args: unknown[]) => mockProcess(...args) }),
  getDeviceId: () => 'device-1',
}));

const archived = (id: string): Workbench => ({
  id, workspaceId: 'ws', runtime: 'local', deviceId: 'device-1', localPath: '/managed/repo/session',
  status: 'archived', archivedAt: '2026-11-01T00:00:00Z',
} as Workbench);

beforeEach(() => {
  jest.clearAllMocks();
  useWorkbenchStore.setState({ workspaceId: 'ws', workbenches: {}, listLoaded: false });
});

it('handles an archive found in the list after app restart', async () => {
  const wb = archived('closed-session');
  const keptWorktree = { reason: 'uncommitted', files: 1, path: wb.localPath, names: ['draft.txt'] };
  mockList.mockResolvedValue([wb]);
  mockProcess.mockResolvedValue({ keptWorktree });

  await loadWorkbenches('ws');
  expect(mockProcess).toHaveBeenCalledWith({ path: wb.localPath, workbenchId: wb.id });
  await waitFor(() => expect(useWorkbenchStore.getState().workbenches[wb.id].keptWorktree).toEqual(keptWorktree));
});

it('does not handle the app dialog archive or another device', async () => {
  const wb = archived('dialog-session');
  markDialogArchive(wb.id, true);
  await reconcileLocalArchive(wb);
  markDialogArchive(wb.id, false);
  await reconcileLocalArchive({ ...wb, id: 'remote-session', deviceId: 'device-2' });
  expect(mockProcess).not.toHaveBeenCalled();
});
