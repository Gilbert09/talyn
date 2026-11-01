import { beforeEach, expect, it, vi } from 'vitest';
import type { WorkbenchRow } from '../services/workbenches/store.js';

const mocks = vi.hoisted(() => ({
  updateWorkbench: vi.fn(), listChats: vi.fn(), appendEvents: vi.fn(), emitWorkbenchEvents: vi.fn(),
}));

vi.mock('../services/workbenches/store.js', () => ({
  updateWorkbench: mocks.updateWorkbench, listChats: mocks.listChats, appendEvents: mocks.appendEvents,
}));
vi.mock('../services/workbenches/emit.js', () => ({ emitWorkbenchEvents: mocks.emitWorkbenchEvents }));

const { claimLocalWorkbench, LOCAL_MOVE_NOTE } = await import('../services/workbenches/localTakeover.js');
const row = { id: 'session-1', deviceId: 'other-mac', localPath: '/other/mac/path' } as WorkbenchRow;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateWorkbench.mockImplementation(async (_id, patch) => ({ ...row, ...patch }));
  mocks.listChats.mockResolvedValue([
    { id: 'chat-1', workspaceId: 'ws', turnCount: 2, closedAt: null },
    { id: 'chat-2', workspaceId: 'ws', turnCount: 1, closedAt: new Date() },
  ]);
  mocks.appendEvents.mockResolvedValue([{ seq: 1 }]);
});

it('claims the session and adds the move note to each open chat', async () => {
  expect(await claimLocalWorkbench(row, 'this-mac', '/managed/repo/lisbon')).toMatchObject({
    deviceId: 'this-mac', localPath: '/managed/repo/lisbon',
  });
  expect(mocks.updateWorkbench).toHaveBeenCalledWith('session-1', {
    deviceId: 'this-mac', localPath: '/managed/repo/lisbon',
  });
  expect(mocks.appendEvents).toHaveBeenCalledWith('chat-1', [{ turn: 2, event: {
    type: 'system', subtype: 'local_session_moved', text: LOCAL_MOVE_NOTE,
  } }]);
  expect(mocks.appendEvents).toHaveBeenCalledTimes(1);
  expect(mocks.emitWorkbenchEvents).toHaveBeenCalledWith('ws', 'chat-1', [{ seq: 1 }]);
});

it('does not add a duplicate note when the same computer claims again', async () => {
  await claimLocalWorkbench({ ...row, deviceId: 'this-mac', localPath: '/managed/repo/lisbon' }, 'this-mac', '/managed/repo/lisbon');
  expect(mocks.appendEvents).not.toHaveBeenCalled();
});
