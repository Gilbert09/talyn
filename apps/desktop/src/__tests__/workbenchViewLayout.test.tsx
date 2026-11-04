import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import { WorkbenchView } from '../renderer/components/workbench/WorkbenchView';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { loadWorkbench } from '../renderer/lib/workbenchData';
import { wakeWorkbench } from '../renderer/lib/wakeWorkbench';

jest.mock('../renderer/lib/workbenchData', () => ({ loadWorkbench: jest.fn(), ensureChatHistory: jest.fn(), loadOlderEvents: jest.fn() }));
jest.mock('../renderer/lib/wakeWorkbench', () => ({ wakeWorkbench: jest.fn() }));
jest.mock('../renderer/components/workbench/workbenchSelectors', () => ({
  useWorkbenchOps: () => ({ runtime: 'sandbox', unavailable: null }),
  useSelectedChat: () => null,
  useWorkbenchPr: () => null,
  useThreadChildren: () => [],
}));
jest.mock('../renderer/components/workbench/new/useRepoPaths', () => ({ useRepoPaths: () => ({ paths: {}, ready: true }) }));
jest.mock('../renderer/lib/workbenchBridge', () => ({ getDeviceId: () => 'this-mac', getWorkbenchBridge: () => null }));
jest.mock('../renderer/components/workbench/Composer', () => ({ Composer: () => <div data-testid="composer" /> }));
jest.mock('../renderer/components/workbench/FilesTab', () => ({ FilesTab: () => <div /> }));
jest.mock('../renderer/components/workbench/ChangesTab', () => ({ ChangesTab: () => <div /> }));
jest.mock('../renderer/components/workbench/PullRequestTab', () => ({ PullRequestTab: () => <div /> }));
jest.mock('../renderer/components/workbench/terminal/TerminalPanel', () => ({ TerminalPanel: () => <div /> }));
jest.mock('../renderer/components/workbench/SessionPreviewChips', () => ({ SessionPreviewChips: () => null }));
jest.mock('../renderer/components/workbench/WorkPanel', () => ({ WorkPanel: () => <div data-testid="work-panel" /> }));

const WB = {
  id: 'wb1', workspaceId: 'ws1', repositoryId: 'r1', repoFullName: 'acme/app',
  name: 'lisbon', branch: 'lisbon', baseBranch: 'main', runtime: 'sandbox',
  agent: 'claude', sandboxState: 'running', status: 'ready', settings: {},
  pullRequestId: null, archivedAt: null,
} as Workbench;

beforeEach(() => useWorkbenchStore.setState({ rightPanelOpen: true, rightPanelWidth: 340, sideTab: 'files', terminalOpen: false }));
afterEach(cleanup);

it('opening a session, or switching to another, reads it and never wakes its sandbox', () => {
  const { rerender } = render(<WorkbenchView workbench={WB} />);
  rerender(<WorkbenchView workbench={{ ...WB, id: 'wb2' }} />);
  expect(jest.mocked(loadWorkbench).mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining(['wb1', 'wb2']));
  expect(wakeWorkbench).not.toHaveBeenCalled();
});

it('places the header above both columns and keeps the panel controls working', () => {
  const { container } = render(<WorkbenchView workbench={WB} />);
  const view = container.querySelector('[data-attr="workbench-view"]')!;
  const header = container.querySelector('[data-attr="workbench-header"]')!;
  const columns = container.querySelector('[data-attr="workbench-columns"]')!;
  expect(view.firstElementChild).toBe(header);
  expect(view.lastElementChild).toBe(columns);
  expect(header).toHaveClass('app-region-drag');
  expect(screen.getByRole('button', { name: 'Toggle the right panel' }).parentElement).toHaveClass('app-region-no-drag');
  expect(screen.getByTestId('git-panel').parentElement).toBe(columns);
  expect(header).not.toContainElement(screen.getByTestId('git-panel'));
  expect(screen.getByRole('tablist', { name: 'Chats' })).toHaveClass('h-9');
  expect(screen.getByRole('tablist', { name: 'Session panels' })).toHaveClass('h-9');

  fireEvent(screen.getByRole('separator', { name: 'Resize the right panel' }), new MouseEvent('pointerdown', { bubbles: true, clientX: 1000 }));
  act(() => {
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 900 }));
    window.dispatchEvent(new MouseEvent('pointerup'));
  });
  expect(screen.getByTestId('git-panel')).toHaveStyle({ width: '440px' });

  fireEvent.click(screen.getByRole('button', { name: 'Toggle the right panel' }));
  expect(screen.queryByTestId('git-panel')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Toggle the right panel' }));
  expect(screen.getByTestId('git-panel')).toHaveStyle({ width: '440px' });
});

it('places a thread header above its work panel', () => {
  const { container } = render(<WorkbenchView workbench={{ ...WB, kind: 'thread' }} />);
  expect(container.querySelector('[data-attr="workbench-view"]')?.firstElementChild)
    .toBe(container.querySelector('[data-attr="workbench-header"]'));
  expect(screen.getByTestId('work-panel').parentElement)
    .toBe(container.querySelector('[data-attr="workbench-columns"]'));
});
