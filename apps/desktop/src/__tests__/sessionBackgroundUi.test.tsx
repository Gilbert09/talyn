import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { GitPanel } from '../renderer/components/workbench/GitPanel';
import { Composer } from '../renderer/components/workbench/Composer';
import { sandboxOps } from '../renderer/lib/workbenchOps';
import { api } from '../renderer/lib/api';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/components/workbench/ChangesTab', () => ({ ChangesTab: () => <div>Changes content</div> }));
jest.mock('../renderer/components/workbench/FilesTab', () => ({ FilesTab: () => <div>Files content</div> }));
jest.mock('../renderer/components/workbench/PullRequestTab', () => ({ PullRequestTab: () => <div>PR content</div> }));
jest.mock('../renderer/components/workbench/SandboxStatusPanel', () => ({ SandboxTab: () => null, sandboxStatusNeedsAttention: () => null, useSandboxStatus: () => ({ status: null }) }));
jest.mock('../renderer/components/workbench/terminal/TerminalPanel', () => ({ TerminalPanel: () => null }));

const workbench = {
  id: 'wb-1', workspaceId: 'ws-1', repositoryId: 'r-1', repoFullName: 'acme/app', name: 'Test',
  branch: 'test', baseBranch: 'main', runtime: 'sandbox', status: 'ready', sandboxId: 'box-1',
  sandboxState: 'running', agent: 'claude', settings: {}, diffStat: null, archivedAt: null,
  pullRequestId: null, createdAt: '2026-11-08T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z',
} as Workbench;
const chat = { id: 'chat-1', workbenchId: 'wb-1', status: 'idle', queuedMessages: [] } as unknown as WorkbenchChat;
const ops = sandboxOps(workbench);

beforeEach(() => {
  useWorkbenchStore.setState({ sideTab: 'background', rightPanelWidth: 340, chats: {}, drafts: {}, outgoingMessages: {}, extraWorkbenchIds: {} });
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); jest.clearAllMocks(); });

it('shows the tab and wake-later button', () => {
  render(<GitPanel workbench={workbench} chat={chat} ops={ops} pr={null} />);
  expect(screen.getByRole('tab', { name: /Background/ })).toHaveAttribute('aria-selected', 'true');
  cleanup();
  render(<Composer workbench={workbench} chat={chat} ops={ops} todos={null} contextUsage={null} slashCommands={null} />);
  expect(screen.getByRole('button', { name: 'Wake me later' })).toBeInTheDocument();
});

it('requires a time and reason before it schedules a wake-up', async () => {
  const schedule = jest.spyOn(api.workbenches, 'scheduleWakeup').mockResolvedValue({} as never);
  render(<Composer workbench={workbench} chat={chat} ops={ops} todos={null} contextUsage={null} slashCommands={null} />);
  fireEvent.click(screen.getByRole('button', { name: 'Wake me later' }));
  const save = screen.getByRole('button', { name: 'Schedule' });
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '10 min' }));
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Wake-up reason' }), { target: { value: 'Check the build' } });
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await waitFor(() => expect(schedule).toHaveBeenCalledWith('wb-1', { chatId: 'chat-1', delaySeconds: 600, reason: 'Check the build' }));
});
