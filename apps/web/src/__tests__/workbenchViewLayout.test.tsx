import '@testing-library/jest-dom/vitest';
import { vi, beforeEach, afterEach, it, expect } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import { WorkbenchView } from '../components/workbench/WorkbenchView';
import { useWorkbenchStore } from '../stores/workbenches';
import { loadWorkbench } from '../lib/workbenchData';
import { wakeWorkbench } from '../lib/wakeWorkbench';

vi.mock('../lib/workbenchData', () => ({ loadWorkbench: vi.fn(), ensureChatHistory: vi.fn(), loadOlderEvents: vi.fn() }));
vi.mock('../lib/wakeWorkbench', () => ({ wakeWorkbench: vi.fn() }));
vi.mock('../components/workbench/workbenchSelectors', () => ({
  useWorkbenchOps: () => ({ runtime: 'sandbox', unavailable: null }),
  useSelectedChat: () => null,
  useWorkbenchPr: () => null,
  useThreadChildren: () => [],
}));
vi.mock('../components/workbench/Composer', () => ({ Composer: () => <div data-testid="composer" /> }));
vi.mock('../components/workbench/FilesTab', () => ({ FilesTab: () => <div /> }));
vi.mock('../components/workbench/ChangesTab', () => ({ ChangesTab: () => <div /> }));
vi.mock('../components/workbench/PullRequestTab', () => ({ PullRequestTab: () => <div /> }));
vi.mock('../components/workbench/SessionPreviewLinks', () => ({ SessionPreviewLinks: () => null }));
vi.mock('../components/workbench/WorkPanel', () => ({ WorkPanel: () => <div data-testid="work-panel" /> }));

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
  expect(vi.mocked(loadWorkbench).mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining(['wb1', 'wb2']));
  expect(wakeWorkbench).not.toHaveBeenCalled();
});

it('places the header above both columns and keeps the panel controls working', () => {
  const { container } = render(<WorkbenchView workbench={WB} />);
  const view = container.querySelector('[data-attr="workbench-view"]')!;
  const header = container.querySelector('[data-attr="workbench-header"]')!;
  const columns = container.querySelector('[data-attr="workbench-columns"]')!;
  expect(view.firstElementChild).toBe(header);
  expect(view.lastElementChild).toBe(columns);
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
