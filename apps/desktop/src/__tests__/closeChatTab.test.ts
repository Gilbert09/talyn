/**
 * @jest-environment jsdom
 */
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { closeChatTab } from '../renderer/components/workbench/ChatTabs';
import { useWorkbenchStore, visibleChats } from '../renderer/stores/workbenches';

const mockCloseChat = jest.fn();
const mockCancel = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: { workbenches: { closeChat: (...args: unknown[]) => mockCloseChat(...args) } },
}));
jest.mock('../renderer/lib/workbenchOps', () => ({ opsFor: () => ({ cancel: (...args: unknown[]) => mockCancel(...args) }) }));
jest.mock('../renderer/stores/toast', () => ({ toast: { error: jest.fn() } }));

function chat(id: string, status: WorkbenchChat['status'] = 'idle'): WorkbenchChat {
  return { id, workbenchId: 'wb1', title: 'Chat', status, createdAt: `2026-10-13T00:00:0${id === 'a' ? 1 : 2}Z` } as WorkbenchChat;
}

function workbench(runtime: Workbench['runtime']): Workbench {
  return { id: 'wb1', runtime } as Workbench;
}

describe('closeChatTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useWorkbenchStore.setState({ hiddenChatIds: {} });
    useWorkbenchStore.getState().setChats('wb1', [chat('a'), chat('b')]);
  });

  it('closes the chat on the backend, so a reload does not bring it back', async () => {
    mockCloseChat.mockResolvedValue(undefined);
    await closeChatTab(workbench('sandbox'), chat('b'));
    expect(mockCloseChat).toHaveBeenCalledWith('b');
    expect(mockCancel).not.toHaveBeenCalled();
    expect(visibleChats(useWorkbenchStore.getState(), 'wb1').map((c) => c.id)).toEqual(['a']);
  });

  it('stops a running local turn first', async () => {
    mockCloseChat.mockResolvedValue(undefined);
    await closeChatTab(workbench('local'), chat('b', 'running'));
    expect(mockCancel).toHaveBeenCalledWith('b');
    expect(mockCloseChat).toHaveBeenCalledWith('b');
  });

  it('shows the tab again when the close fails', async () => {
    mockCloseChat.mockRejectedValue(new Error('Down'));
    await closeChatTab(workbench('sandbox'), chat('b'));
    expect(visibleChats(useWorkbenchStore.getState(), 'wb1').map((c) => c.id)).toEqual(['a', 'b']);
  });
});
