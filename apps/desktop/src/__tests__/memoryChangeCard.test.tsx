import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentEvent, MemoryEntry } from '@talyn/shared';
import { AgentBlocks } from '../renderer/components/terminal/AgentConversation';

const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockForget = jest.fn();
const mockRestore = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: {
    workbenches: {
      memory: {
        get: (...args: unknown[]) => mockGet(...args),
        update: (...args: unknown[]) => mockUpdate(...args),
        forget: (...args: unknown[]) => mockForget(...args),
        restore: (...args: unknown[]) => mockRestore(...args),
      },
    },
  },
}));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock('../renderer/stores/navigation', () => ({
  useNavigationStore: { getState: () => ({ navigate: jest.fn() }) },
}));
const mockState = {
  repositories: [{ id: 'r1', workspaceId: 'ws1', owner: 'acme', repo: 'app', fullName: 'acme/app' }],
};
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) => selector(mockState),
}));

/** The `talyn_memory` event a session's memory write appends to its chat. */
const memoryEvent = (action: 'created' | 'updated' | 'forgotten'): AgentEvent =>
  ({
    seq: 7,
    type: 'talyn_memory',
    action,
    memoryId: 'm1',
    name: 'Build command',
    memoryType: 'project',
    scope: 'repository',
  }) as unknown as AgentEvent;

const live: MemoryEntry = {
  id: 'm1',
  workspaceId: 'ws1',
  scope: 'repository',
  repositoryId: 'r1',
  threadId: null,
  type: 'project',
  name: 'Build command',
  description: 'How to build the app.',
  body: 'Run make build.',
  bytes: 15,
  source: { kind: 'session', workbenchId: 'wb1' },
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
  forgottenAt: null,
};

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

const card = () => screen.getByTestId('memory-change');
const button = (name: string) => within(card()).getByRole('button', { name }) as HTMLButtonElement;

describe('talyn_memory card', () => {
  it('says what the session saved, with the type and the repository', async () => {
    mockGet.mockResolvedValue(live);
    render(<AgentBlocks events={[memoryEvent('created')]} />);
    expect(within(card()).getByText('Saved to memory')).toBeTruthy();
    expect(within(card()).getByText('Build command')).toBeTruthy();
    expect(within(card()).getByText('Project')).toBeTruthy();
    await waitFor(() => expect(within(card()).getByText('acme/app')).toBeTruthy());
    expect(button('Edit').disabled).toBe(false);
    expect(mockGet).toHaveBeenCalledWith('m1');
  });

  it('shows the memory text on View, and hides it again', async () => {
    mockGet.mockResolvedValue(live);
    render(<AgentBlocks events={[memoryEvent('created')]} />);
    await waitFor(() => expect(button('View').disabled).toBe(false));
    expect(screen.queryByTestId('memory-body')).toBeNull();
    fireEvent.click(button('View'));
    const body = screen.getByTestId('memory-body');
    expect(within(body).getByText('Run make build.')).toBeTruthy();
    expect(within(body).getByText('How to build the app.')).toBeTruthy();
    fireEvent.click(button('Hide'));
    expect(screen.queryByTestId('memory-body')).toBeNull();
  });

  it('tells the memory panel that memory changed when the card appears', async () => {
    mockGet.mockResolvedValue(live);
    const heard = jest.fn();
    window.addEventListener('talyn-memory-changed', heard);
    render(<AgentBlocks events={[memoryEvent('created')]} />);
    expect(heard).toHaveBeenCalled();
    window.removeEventListener('talyn-memory-changed', heard);
  });

  it('edits the entry in the same editor', async () => {
    mockGet.mockResolvedValue(live);
    mockUpdate.mockImplementation(async (_id: string, patch: Partial<MemoryEntry>) => ({ ...live, ...patch }));
    render(<AgentBlocks events={[memoryEvent('updated')]} />);
    expect(within(card()).getByText('Updated memory')).toBeTruthy();
    await waitFor(() => expect(button('Edit').disabled).toBe(false));
    fireEvent.click(button('Edit'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Memory name' }), { target: { value: 'Build steps' } });
    fireEvent.click(button('Save'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('m1', { name: 'Build steps' }));
    await waitFor(() => expect(within(card()).getByText('Build steps')).toBeTruthy());
  });

  it('forgets the entry, then restores it', async () => {
    mockGet.mockResolvedValue(live);
    mockForget.mockResolvedValue({ ...live, forgottenAt: '2026-10-31T00:00:00.000Z' });
    mockRestore.mockResolvedValue(live);
    render(<AgentBlocks events={[memoryEvent('created')]} />);
    await waitFor(() => expect(button('Forget').disabled).toBe(false));
    fireEvent.click(button('Forget'));
    await waitFor(() => expect(button('Restore')).toBeTruthy());
    expect(mockForget).toHaveBeenCalledWith('m1');
    fireEvent.click(button('Restore'));
    await waitFor(() => expect(button('Forget')).toBeTruthy());
    expect(mockRestore).toHaveBeenCalledWith('m1');
  });

  it('offers Restore for a forget event', async () => {
    mockGet.mockResolvedValue({ ...live, forgottenAt: '2026-10-31T00:00:00.000Z' });
    render(<AgentBlocks events={[memoryEvent('forgotten')]} />);
    expect(within(card()).getByText('Forgot a memory')).toBeTruthy();
    await waitFor(() => expect(button('Restore').disabled).toBe(false));
  });

  it('keeps the name from the event when the entry no longer exists', async () => {
    mockGet.mockRejectedValue(Object.assign(new Error('Memory entry not found'), { status: 404 }));
    render(<AgentBlocks events={[memoryEvent('created')]} />);
    await waitFor(() => expect(within(card()).getByText('No longer in memory')).toBeTruthy());
    expect(within(card()).getByText('Build command')).toBeTruthy();
    expect(within(card()).getByText('Repository')).toBeTruthy();
    expect(button('Edit').disabled).toBe(true);
    expect(button('Forget').disabled).toBe(true);
  });
});
