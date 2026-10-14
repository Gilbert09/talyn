/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';
import { DOCK_MIN_HEIGHT, readLayout } from '../renderer/lib/workbenchLayout';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { TerminalPanel } from '../renderer/components/workbench/terminal/TerminalPanel';

jest.mock('../renderer/stores/toast', () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock('../renderer/components/workbench/terminal/ShellTerminal', () => ({
  ShellTerminal: ({ active }: { active: boolean }) => <div data-testid="shell" data-active={String(active)} />,
}));
jest.mock('../renderer/components/workbench/terminal/useXterm', () => ({
  useXterm: () => ({ ref: { current: null }, term: null }),
}));

const WB = { id: 'wb1', runtime: 'sandbox', status: 'ready' } as Workbench;
const ops = { unavailable: null, runScript: jest.fn(), stopScript: jest.fn() } as unknown as WorkbenchOps;

beforeEach(() => {
  window.localStorage.clear();
  useWorkbenchStore.setState({ terminalOpen: false, terminalTab: 'terminal', terminalHeight: 260, rightPanelOpen: true });
});

afterEach(() => cleanup());

describe('terminal dock', () => {
  it('starts collapsed to a bar of tabs', () => {
    render(<TerminalPanel workbench={WB} ops={ops} />);
    const dock = screen.getByTestId('terminal-dock');
    expect(dock).toHaveAttribute('data-open', 'false');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Setup', 'Run', 'Terminal']);
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    expect(screen.queryByTestId('shell')).not.toBeInTheDocument();
  });

  it('a tab opens the dock on it; the same tab again collapses it', () => {
    render(<TerminalPanel workbench={WB} ops={ops} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Run' }));
    expect(useWorkbenchStore.getState()).toMatchObject({ terminalOpen: true, terminalTab: 'run' });
    expect(screen.getByTestId('terminal-dock')).toHaveStyle({ height: '260px' });
    expect(screen.getByText(/No run output yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Run' }));
    expect(useWorkbenchStore.getState().terminalOpen).toBe(false);
  });

  it('⌘J (the store toggle) opens the shell, which then survives a collapse', () => {
    render(<TerminalPanel workbench={WB} ops={ops} />);
    act(() => useWorkbenchStore.getState().toggleTerminal());
    expect(screen.getByTestId('shell')).toHaveAttribute('data-active', 'true');
    act(() => useWorkbenchStore.getState().toggleTerminal());
    expect(screen.getByTestId('shell')).toHaveAttribute('data-active', 'false');
  });

  it('drags taller from its top edge, never under the minimum, and remembers the height', () => {
    useWorkbenchStore.setState({ terminalOpen: true });
    render(<TerminalPanel workbench={WB} ops={ops} />);
    const handle = screen.getByRole('separator', { name: 'Resize the terminal' });
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientY: 500 }));
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 400 }));
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(useWorkbenchStore.getState().terminalHeight).toBe(360);
    expect(readLayout().dockHeight).toBe(360);
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientY: 100 }));
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 900 }));
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(useWorkbenchStore.getState().terminalHeight).toBe(DOCK_MIN_HEIGHT);
  });
});
