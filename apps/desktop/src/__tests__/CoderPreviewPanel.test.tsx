import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Features, RepositoryPreviewResponse, Workbench, WorkbenchChat, WorkbenchEvent } from '@talyn/shared';
import { CoderPreviewPanel } from '../renderer/components/workbench/CoderPreviewPanel';
import { SessionPreviewChips } from '../renderer/components/workbench/SessionPreviewChips';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { syncCoderTurn } from '../renderer/lib/coderPreview';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';

const patch = jest.fn();
const previewGet = jest.fn();
const bridge = {
  prepare: jest.fn(), sync: jest.fn(), run: jest.fn(), open: jest.fn(), stop: jest.fn(), remove: jest.fn(), state: jest.fn(),
};
jest.mock('../renderer/lib/api', () => ({ api: {
  workbenches: { patch: (...args: unknown[]) => patch(...args) },
  repositories: { preview: { get: (...args: unknown[]) => previewGet(...args) } },
} }));
jest.mock('../renderer/lib/workbenchBridge', () => ({ getWorkbenchBridge: () => ({ coderPreview: bridge }) }));
jest.mock('../renderer/stores/toast', () => ({ toast: { error: jest.fn() } }));
const wb = { id: 'panel-session', repositoryId: 'repo', repoFullName: 'org/repo', runtime: 'sandbox', status: 'ready' } as Workbench;
const config: RepositoryPreviewResponse = { target: 'coder', ports: [{ port: 8010 }], coder: { url: 'https://coder.example', workspace: 'dev' }, reasons: ['coder_url in hogli.yaml'], source: 'detected', user: {}, detected: null };

beforeEach(() => {
  jest.clearAllMocks();
  for (const method of Object.values(bridge)) method.mockReset().mockResolvedValue(undefined);
  bridge.state.mockResolvedValue(null);
  patch.mockResolvedValue({ base: 'a'.repeat(40), patch: 'binary patch' });
  previewGet.mockResolvedValue(config);
  useWorkspaceStore.setState({ features: { sessionPreviews: true } as Features });
});
afterEach(cleanup);

it('prepares, syncs, runs, and opens in order', async () => {
  render(<CoderPreviewPanel workbench={wb} config={config} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview in Coder' }));
  await waitFor(() => expect(bridge.open).toHaveBeenCalledWith(wb.id));
  expect(bridge.prepare).toHaveBeenCalledWith(expect.objectContaining({ sessionId: wb.id, repoName: 'org/repo', config }));
  expect(bridge.sync).toHaveBeenCalledWith({ sessionId: wb.id, base: 'a'.repeat(40), patch: 'binary patch' });
  expect(bridge.prepare.mock.invocationCallOrder[0]).toBeLessThan(bridge.sync.mock.invocationCallOrder[0]);
  expect(bridge.sync.mock.invocationCallOrder[0]).toBeLessThan(bridge.run.mock.invocationCallOrder[0]);
  expect(bridge.run.mock.invocationCallOrder[0]).toBeLessThan(bridge.open.mock.invocationCallOrder[0]);
  expect(screen.getByText('One preview per workspace: starting this stops the preview of another session.')).toBeInTheDocument();
});
it('shows the synced turn and runs the Stop and Remove actions', async () => {
  bridge.state.mockResolvedValue({ active: true, running: true, worktreeReady: true, syncedAt: 'now', turn: 4 });
  render(<CoderPreviewPanel workbench={wb} config={config} />);
  expect(await screen.findByText('✓ Synced after turn 4')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
  await waitFor(() => expect(bridge.sync).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await waitFor(() => expect(bridge.stop).toHaveBeenCalledWith(wb.id));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(bridge.remove).toHaveBeenCalledWith(wb.id));
});
it('shows the exact repair command', async () => {
  bridge.prepare.mockRejectedValue(new Error('Run: coder login https://coder.example'));
  render(<CoderPreviewPanel workbench={wb} config={config} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview in Coder' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('coder login https://coder.example');
  expect(bridge.run).not.toHaveBeenCalled();
});
it.each([false, undefined])('hides the panel when the flag is %s', (flag) => {
  useWorkspaceStore.setState({ features: { sessionPreviews: flag } as Features });
  render(<CoderPreviewPanel workbench={wb} config={config} />);
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
  expect(bridge.state).not.toHaveBeenCalled();
});
it.each([{ runtime: 'local' }, { status: 'archived' }, { archivedAt: 'today' }])('hides the panel for %j', (changes) => {
  render(<CoderPreviewPanel workbench={{ ...wb, ...changes } as Workbench} config={config} />);
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
});
it('shows a compact header chip and opens the Run tab', async () => {
  render(<SessionPreviewChips workbench={wb} ops={{ unavailable: null } as WorkbenchOps} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Preview in Coder' }));
  await waitFor(() => expect(bridge.open).toHaveBeenCalled());
  expect(useWorkbenchStore.getState()).toMatchObject({ terminalOpen: true, terminalTab: 'run' });
});
it('syncs a background turn once without a mounted panel', async () => {
  bridge.state.mockResolvedValue({ active: true });
  useWorkbenchStore.setState({ chats: { [wb.id]: [{ id: 'background', workbenchId: wb.id } as WorkbenchChat] } });
  const events = [{ turn: 8, event: { type: 'result' } }] as WorkbenchEvent[];
  await act(async () => { syncCoderTurn('background', events); syncCoderTurn('background', events); });
  await waitFor(() => expect(bridge.sync).toHaveBeenCalledTimes(1));
  expect(bridge.sync).toHaveBeenCalledWith(expect.objectContaining({ sessionId: wb.id, turn: 8 }));
});
it('does not sync stopped previews', async () => {
  bridge.state.mockResolvedValue({ active: false });
  useWorkbenchStore.setState({ chats: { [wb.id]: [{ id: 'stopped', workbenchId: wb.id } as WorkbenchChat] } });
  await act(async () => { syncCoderTurn('stopped', [{ turn: 1, event: { type: 'result' } }] as WorkbenchEvent[]); });
  expect(patch).not.toHaveBeenCalled();
});
