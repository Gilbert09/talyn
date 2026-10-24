/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Features, Workbench } from '@talyn/shared';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';
import { DOCK_MIN_HEIGHT, readLayout } from '../renderer/lib/workbenchLayout';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { TerminalPanel } from '../renderer/components/workbench/terminal/TerminalPanel';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { toast } from '../renderer/stores/toast';

const previewGet = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: { repositories: { preview: { get: (...args: unknown[]) => previewGet(...args) } } },
}));

jest.mock('../renderer/stores/toast', () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock('../renderer/components/workbench/terminal/ShellTerminal', () => ({
  ShellTerminal: ({ active }: { active: boolean }) => <div data-testid="shell" data-active={String(active)} />,
}));
jest.mock('../renderer/components/workbench/terminal/useXterm', () => ({
  useXterm: () => ({ ref: { current: null }, term: null }),
}));

const WB = { id: 'wb1', repositoryId: 'repo1', runtime: 'sandbox', status: 'ready' } as Workbench;
const configured = {
  source: 'talyn', setup: { command: 'npm ci' }, run: [{ name: 'run', command: 'npm run dev', default: true }],
  errors: [], filesToCopy: [], runMode: 'concurrent',
};
const readConfig = jest.fn();
const saveDetectedConfig = jest.fn();
const ops = {
  unavailable: null, runScript: jest.fn(), stopScript: jest.fn(), config: readConfig, saveDetectedConfig,
} as unknown as WorkbenchOps;

async function renderDock() {
  await act(async () => { render(<TerminalPanel workbench={WB} ops={ops} />); });
}

beforeEach(() => {
  jest.clearAllMocks();
  useWorkspaceStore.setState({ features: null });
  previewGet.mockReset().mockResolvedValue({ target: 'sandbox', ports: [{ port: 5173, label: 'App' }, { port: 8010 }] });
  readConfig.mockReset().mockResolvedValue(configured);
  saveDetectedConfig.mockReset().mockResolvedValue(undefined);
  window.localStorage.clear();
  useWorkbenchStore.setState({ terminalOpen: false, terminalTab: 'terminal', terminalHeight: 260, rightPanelOpen: true });
});

afterEach(() => cleanup());

describe('terminal dock', () => {
  it('starts collapsed to a bar of tabs', async () => {
    await renderDock();
    const dock = screen.getByTestId('terminal-dock');
    expect(dock).toHaveAttribute('data-open', 'false');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Setup', 'Run', 'Terminal']);
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    expect(screen.queryByTestId('shell')).not.toBeInTheDocument();
  });

  it('a tab opens the dock on it; the same tab again collapses it', async () => {
    await renderDock();
    fireEvent.click(screen.getByRole('tab', { name: 'Run' }));
    expect(useWorkbenchStore.getState()).toMatchObject({ terminalOpen: true, terminalTab: 'run' });
    expect(screen.getByTestId('terminal-dock')).toHaveStyle({ height: '260px' });
    expect(screen.getByText(/No run output yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Run' }));
    expect(useWorkbenchStore.getState().terminalOpen).toBe(false);
  });

  it('⌘J (the store toggle) opens the shell, which then survives a collapse', async () => {
    await renderDock();
    act(() => useWorkbenchStore.getState().toggleTerminal());
    expect(screen.getByTestId('shell')).toHaveAttribute('data-active', 'true');
    act(() => useWorkbenchStore.getState().toggleTerminal());
    expect(screen.getByTestId('shell')).toHaveAttribute('data-active', 'false');
  });

  it('drags taller from its top edge, never under the minimum, and remembers the height', async () => {
    useWorkbenchStore.setState({ terminalOpen: true });
    await renderDock();
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

  it.each([
    [{ command: 'npm ci' }, 'The setup script has not run yet.'],
    [undefined, 'This repository has no setup script.'],
  ])('shows the setup state for %j', async (setup, message) => {
    readConfig.mockResolvedValue({ ...configured, setup });
    useWorkbenchStore.setState({ terminalOpen: true, terminalTab: 'setup' });
    await renderDock();
    expect(screen.getByText(message as string)).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it.each(['setup', 'run', 'terminal'] as const)('shows only Terminal with no config or detection from %s', async (tab) => {
    readConfig.mockResolvedValue({ ...configured, source: 'none', setup: undefined, run: [], detected: {} });
    useWorkbenchStore.setState({ terminalOpen: true, terminalTab: tab });
    await renderDock();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Terminal']);
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    expect(useWorkbenchStore.getState().terminalTab).toBe('terminal');
    expect(screen.getByTestId('shell')).toHaveAttribute('data-active', 'true');
  });

  const detection = {
    setup: { command: 'npm ci', reason: 'from package-lock.json' },
    run: { command: 'npm run dev', reason: 'from the dev script in package.json' },
  };

  it.each(['setup', 'run'] as const)('offers to save detected %s commands without running them', async (tab) => {
    readConfig.mockResolvedValueOnce({ ...configured, source: 'none', setup: undefined, run: [], detected: detection });
    useWorkbenchStore.setState({ terminalOpen: true, terminalTab: tab });
    await renderDock();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByText(detection[tab].command)).toBeInTheDocument();
    expect(screen.getByText(`(${detection[tab].reason})`)).toBeInTheDocument();
    expect(screen.getByText('Talyn does not run detected commands until you save them.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save to .talyn/settings.toml' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
      'Config saved', "The file is now in this session's changes. You can commit it.",
    ));
    expect(saveDetectedConfig).toHaveBeenCalledWith();
    expect(readConfig).toHaveBeenCalledTimes(2);
    expect(ops.runScript).not.toHaveBeenCalled();
    expect(screen.queryByText('Detected:')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
  });

  it('shows a save error and keeps the detected commands', async () => {
    readConfig.mockResolvedValue({ ...configured, source: 'none', detected: detection });
    saveDetectedConfig.mockRejectedValue(new Error('A repository config file already exists.'));
    useWorkbenchStore.setState({ terminalOpen: true, terminalTab: 'setup' });
    await renderDock();
    fireEvent.click(screen.getByRole('button', { name: 'Save to .talyn/settings.toml' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'Could not save the repository config', 'A repository config file already exists.',
    ));
    expect(screen.getByText('npm ci')).toBeInTheDocument();
    expect(readConfig).toHaveBeenCalledTimes(1);
    expect(ops.runScript).not.toHaveBeenCalled();
  });
});


it('shows each preview port and label in the Run tab', async () => {
  useWorkspaceStore.setState({ features: { workbenches: true } as Features });
  useWorkbenchStore.setState({ terminalOpen: true, terminalTab: 'run' });
  await renderDock();
  expect(await screen.findByRole('button', { name: 'Open localhost:5173 (App)' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open localhost:8010' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Setup' }));
  expect(screen.queryByRole('button', { name: /Open localhost/ })).not.toBeInTheDocument();
});

it.each(['flag-off', 'coder', 'off', 'local'])('hides preview chips for %s', async (mode) => {
  useWorkspaceStore.setState({ features: { workbenches: mode !== 'flag-off' } as Features });
  previewGet.mockResolvedValue({ target: mode === 'coder' ? 'coder' : mode === 'off' ? 'off' : 'sandbox', ports: [{ port: 8010 }] });
  useWorkbenchStore.setState({ terminalOpen: true, terminalTab: 'run' });
  await act(async () => { render(<TerminalPanel workbench={{ ...WB, runtime: mode === 'local' ? 'local' : 'sandbox' }} ops={ops} />); });
  expect(screen.queryByRole('button', { name: /Open localhost/ })).not.toBeInTheDocument();
});


it('keeps the Run tab for Coder when the repository has no sandbox scripts', async () => {
  useWorkspaceStore.setState({ features: { workbenches: true } as Features });
  previewGet.mockResolvedValue({ target: 'coder', ports: [{ port: 8010 }], coder: { url: 'https://coder.example' } });
  readConfig.mockResolvedValue({ source: 'none', run: [], errors: [], filesToCopy: [], runMode: 'concurrent' });
  useWorkbenchStore.setState({ terminalOpen: true, terminalTab: 'run' });
  await renderDock();
  expect(screen.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('region', { name: 'Coder preview' })).toBeInTheDocument();
});
