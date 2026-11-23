import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import { WorkbenchView } from '../renderer/components/workbench/WorkbenchView';
import { useWorkbenchStore } from '../renderer/stores/workbenches';

const mockPickFolder = jest.fn();
const mockTakeOver = jest.fn();
let mockPaths: Record<string, string> = {};

jest.mock('../renderer/components/workbench/new/useRepoPaths', () => ({
  useRepoPaths: () => ({ paths: mockPaths, ready: true, pickFolder: mockPickFolder }),
}));
jest.mock('../renderer/lib/localTakeover', () => ({
  checkoutFor: (paths: Record<string, string>, repo: string) => paths[repo] ?? null,
  takeOverLocalWorkbench: (...args: unknown[]) => mockTakeOver(...args),
}));
jest.mock('../renderer/lib/workbenchBridge', () => ({ getDeviceId: () => 'this-mac' }));
jest.mock('../renderer/lib/workbenchData', () => ({ loadWorkbench: jest.fn(async () => null), ensureChatHistory: jest.fn(), loadOlderEvents: jest.fn() }));
jest.mock('../renderer/lib/wakeWorkbench', () => ({ wakeWorkbench: jest.fn() }));
jest.mock('../renderer/components/workbench/workbenchSelectors', () => ({
  useWorkbenchOps: () => ({ runtime: 'local', unavailable: "This session's branch is only on the computer that made it. Push it from there, or start a new session." }),
  useSelectedChat: () => null,
  useWorkbenchPr: () => null,
  useThreadChildren: () => [],
}));
jest.mock('../renderer/components/workbench/WorkbenchHeader', () => ({ WorkbenchHeader: () => null }));
jest.mock('../renderer/components/workbench/GitPanel', () => ({ GitPanel: () => <div>Pull request and changes</div> }));

const wb = {
  id: 'session-1', name: 'lisbon', repoFullName: 'owner/repo', runtime: 'local',
  status: 'ready', sandboxState: 'none', deviceId: 'other-mac', localPath: '/other/mac/path',
} as Workbench;

beforeEach(() => {
  jest.clearAllMocks();
  mockPaths = {};
  useWorkbenchStore.setState({ rightPanelOpen: true });
});
afterEach(cleanup);

test('shows the folder picker and disables the composer without a checkout', async () => {
  mockPickFolder.mockResolvedValue({ path: '/this/mac/checkout', repoFullName: 'owner/repo' });
  mockTakeOver.mockResolvedValue({ ...wb, deviceId: 'this-mac' });
  render(<WorkbenchView workbench={wb} />);
  expect(screen.getByText('Choose the folder of your owner/repo checkout to continue this session here.')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message the agent' })).toHaveAttribute('placeholder',
    'Choose the folder of your owner/repo checkout to continue this session here.');
  expect(screen.getByRole('textbox', { name: 'Message the agent' })).toBeDisabled();
  expect(screen.getByText('Pull request and changes')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
  await waitFor(() => expect(mockPickFolder).toHaveBeenCalledWith('owner/repo'));
  await waitFor(() => expect(mockTakeOver).toHaveBeenCalledWith(wb, '/this/mac/checkout'));
});

test('explains that a branch only on the other computer cannot continue', () => {
  mockPaths = { 'owner/repo': '/this/mac/checkout' };
  render(<WorkbenchView workbench={wb} />);
  expect(screen.getByText("This session's branch is only on the computer that made it. Push it from there, or start a new session.")).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Message the agent' })).toHaveAttribute('placeholder',
    "This session's branch is only on the computer that made it. Push it from there, or start a new session.");
  expect(screen.getByRole('textbox', { name: 'Message the agent' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Choose folder' })).not.toBeInTheDocument();
});
