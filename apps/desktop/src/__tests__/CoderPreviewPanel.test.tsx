import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Features, RepositoryPreviewResponse, Workbench, WorkbenchChat, WorkbenchEvent } from '@talyn/shared';
import { CoderPreviewPanel } from '../renderer/components/workbench/CoderPreviewPanel';
import { SessionPreviewChips } from '../renderer/components/workbench/SessionPreviewChips';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { syncCoderTurn } from '../renderer/lib/coderPreview';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';
import type { CoderPreviewState, CoderProblem } from '../workbenchBridgeTypes';
import { useCoderPreviewStatusStore } from '../renderer/stores/coderPreviewStatus';

const patch = jest.fn();
const previewGet = jest.fn();
const bridge = {
  check: jest.fn(), openSignIn: jest.fn(), signIn: jest.fn(), startWorkspace: jest.fn(),
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
  useCoderPreviewStatusStore.setState({ sessions: {} });
  for (const method of Object.values(bridge)) method.mockReset().mockResolvedValue(undefined);
  bridge.state.mockResolvedValue(null);
  patch.mockResolvedValue({ base: 'a'.repeat(40), patch: 'binary patch' });
  previewGet.mockResolvedValue(config);
  useWorkspaceStore.setState({ features: { workbenches: true } as Features });
});
afterEach(cleanup);

it('prepares, syncs, runs, and opens in order', async () => {
  render(<CoderPreviewPanel workbench={wb} config={config} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview in Coder' }));
  await waitFor(() => expect(bridge.open).toHaveBeenCalledWith(wb.id));
  expect(bridge.prepare).toHaveBeenCalledWith(expect.objectContaining({ sessionId: wb.id, repoName: 'org/repo', config }));
  expect(bridge.sync).toHaveBeenCalledWith({ sessionId: wb.id, base: 'a'.repeat(40), patch: 'binary patch' });
  // The checks run before the patch, which can wake a sleeping sandbox.
  expect(bridge.check.mock.invocationCallOrder[0]).toBeLessThan(patch.mock.invocationCallOrder[0]);
  expect(patch.mock.invocationCallOrder[0]).toBeLessThan(bridge.prepare.mock.invocationCallOrder[0]);
  expect(bridge.prepare.mock.invocationCallOrder[0]).toBeLessThan(bridge.sync.mock.invocationCallOrder[0]);
  expect(bridge.sync.mock.invocationCallOrder[0]).toBeLessThan(bridge.run.mock.invocationCallOrder[0]);
  expect(bridge.run.mock.invocationCallOrder[0]).toBeLessThan(bridge.open.mock.invocationCallOrder[0]);
  expect(screen.getByText('One preview per workspace: starting this stops the preview of another session.')).toBeInTheDocument();
});
it('shows the synced turn and runs the Stop and Remove actions', async () => {
  bridge.state.mockResolvedValue({ active: true, running: true, worktreeReady: true, syncedAt: 'now', turn: 4 });
  render(<CoderPreviewPanel workbench={wb} config={config} />);
  expect(await screen.findByText('Synced after turn 4')).toHaveAttribute('data-state', 'done');
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
  useWorkspaceStore.setState({ features: { workbenches: flag } as Features });
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
it('shows the Coder step in the header while the Run tab is closed', async () => {
  const item = { ...wb, id: 'header-starting' };
  render(<SessionPreviewChips workbench={item} ops={{ unavailable: null } as WorkbenchOps} />);
  await screen.findByRole('button', { name: 'Preview in Coder' });
  act(() => useCoderPreviewStatusStore.getState().update(item.id, { busy: true, step: 'workspace' }));
  expect(screen.getByRole('button', { name: 'Starting dev…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Starting dev…' }).querySelector('svg')).toHaveClass('animate-spin');
});
it('polls Coder steps while the Run tab is closed', async () => {
  const item = { ...wb, id: 'header-polling' };
  let finishPrepare!: (value: CoderPreviewState) => void;
  bridge.prepare.mockImplementation(() => new Promise((resolve) => { finishPrepare = resolve; }));
  render(<SessionPreviewChips workbench={item} ops={{ unavailable: null } as WorkbenchOps} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Preview in Coder' }));
  await waitFor(() => expect(bridge.prepare).toHaveBeenCalled());
  bridge.state.mockResolvedValue({ ...base, workspace: 'devbox-tom-eu', step: 'worktree' });
  expect(await screen.findByRole('button', { name: 'Preparing worktree…' }, { timeout: 2500 })).toBeDisabled();
  await act(async () => { finishPrepare({ ...base }); });
  await waitFor(() => expect(bridge.open).toHaveBeenCalledWith(item.id));
});
it('opens an active Coder preview from the header', async () => {
  const item = { ...wb, id: 'header-running' };
  bridge.state.mockResolvedValue({ ...base, active: true, running: true });
  render(<SessionPreviewChips workbench={item} ops={{ unavailable: null } as WorkbenchOps} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Coder preview' }));
  await waitFor(() => expect(bridge.open).toHaveBeenCalledWith(item.id));
});
it('opens the Run tab when the Coder preview fails', async () => {
  const item = { ...wb, id: 'header-failed' };
  bridge.state.mockResolvedValue(withProblem({ step: 'login', code: 'not_logged_in', message: 'Sign in to Coder' }));
  render(<SessionPreviewChips workbench={item} ops={{ unavailable: null } as WorkbenchOps} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Coder preview failed' }));
  expect(useWorkbenchStore.getState()).toMatchObject({ terminalOpen: true, terminalTab: 'run' });
  expect(bridge.open).not.toHaveBeenCalled();
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

let sessions = 0;
// A new session id per test: the lib keeps errors and running actions per session.
const session = () => ({ ...wb, id: `coder-session-${++sessions}` }) as Workbench;
const base = { sessionId: 'x', url: 'https://coder.example', cliReady: false, signedIn: false, workspaceRunning: false, worktreeReady: false, active: false, running: false };
const withProblem = (problem: CoderProblem, extra: Partial<CoderPreviewState> = {}): CoderPreviewState =>
  ({ ...base, ...extra, problem, error: problem.message });
const writeText = jest.fn();
beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

const notInstalled: CoderProblem = {
  step: 'cli', code: 'not_installed', message: 'Talyn cannot find the Coder CLI. Install it, then select Check again.',
  commands: [{ command: 'brew install coder/coder/coder' }], note: 'You can also use the official install script: curl -L https://coder.com/install.sh | sh',
};

it('checks the setup when the panel first opens', async () => {
  const item = session();
  render(<CoderPreviewPanel workbench={item} config={config} />);
  await waitFor(() => expect(bridge.check).toHaveBeenCalledWith({ sessionId: item.id, repoName: 'org/repo', config }));
  expect(bridge.prepare).not.toHaveBeenCalled();
});
it('shows a missing CLI with the install command and a copy button', async () => {
  const item = session();
  bridge.check.mockResolvedValue(withProblem(notInstalled));
  render(<CoderPreviewPanel workbench={item} config={config} />);
  bridge.state.mockResolvedValue(withProblem(notInstalled));
  fireEvent.click(screen.getByRole('button', { name: 'Preview in Coder' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Talyn cannot find the Coder CLI.');
  expect(alert).toHaveTextContent('curl -L https://coder.com/install.sh | sh');
  expect(screen.getByText('brew install coder/coder/coder').tagName).toBe('CODE');
  expect(screen.getByText('CLI installed')).toHaveAttribute('data-state', 'failed');
  fireEvent.click(screen.getByRole('button', { name: 'Copy brew install coder/coder/coder' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('brew install coder/coder/coder'));
  expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
  expect(patch).not.toHaveBeenCalled();
  expect(bridge.prepare).not.toHaveBeenCalled();
});
it.each<[string, CoderProblem, string]>([
  ['not signed in', { step: 'login', code: 'not_logged_in', message: 'The Coder CLI is not signed in to https://coder.example, or the sign-in expired.', commands: [{ command: 'coder login https://coder.example' }, { label: 'Or use hogli, from the PostHog repository:', command: 'hogli devbox:setup' }] }, 'coder login https://coder.example'],
  ['unreachable', { step: 'login', code: 'unreachable', message: 'Talyn cannot reach https://coder.example. Connect to that network, then select Check again.', detail: 'dial tcp: lookup coder.example: no such host' }, 'no such host'],
])('shows the %s problem and its fix', async (_name, problem, text) => {
  const item = session();
  bridge.state.mockResolvedValue(withProblem(problem, { cliReady: true }));
  render(<CoderPreviewPanel workbench={item} config={config} />);
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(problem.message);
  expect(alert).toHaveTextContent(text);
  expect(screen.getByText('Signed in')).toHaveAttribute('data-state', 'failed');
  expect(screen.getByText('CLI installed')).toHaveAttribute('data-state', 'done');
  for (const { command } of problem.commands ?? []) expect(screen.getByRole('button', { name: `Copy ${command}` })).toBeInTheDocument();
});
it('opens Coder sign-in and runs the checks after a token succeeds', async () => {
  const item = session();
  const problem: CoderProblem = { step: 'login', code: 'not_logged_in', message: 'Sign in.', commands: [
    { command: 'coder login https://coder.example' }, { command: 'hogli devbox:setup' },
  ] };
  bridge.state.mockResolvedValue(withProblem(problem, { cliReady: true }));
  render(<CoderPreviewPanel workbench={item} config={config} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Coder' }));
  await waitFor(() => expect(bridge.openSignIn).toHaveBeenCalledWith(item.id));
  const input = screen.getByLabelText('Paste the token from the page');
  expect(input).toHaveAttribute('type', 'password');
  fireEvent.change(input, { target: { value: 'sensitive-token' } });
  fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
  await waitFor(() => expect(bridge.signIn).toHaveBeenCalledWith(item.id, 'sensitive-token'));
  await waitFor(() => expect(bridge.check).toHaveBeenCalledWith({ sessionId: item.id, repoName: item.repoFullName, config }));
  await waitFor(() => expect(screen.getByLabelText('Paste the token from the page')).toHaveValue(''));
  expect(screen.getByRole('button', { name: 'Copy coder login https://coder.example' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Copy hogli devbox:setup' })).toBeInTheDocument();
});
it('keeps the token and shows a redacted sign-in error', async () => {
  const item = session();
  const problem: CoderProblem = { step: 'login', code: 'not_logged_in', message: 'Sign in.' };
  bridge.state.mockResolvedValue(withProblem(problem, { cliReady: true }));
  bridge.signIn.mockRejectedValue(new Error("Error invoking remote method 'workbench:coder-preview:sign-in': Error: bad [redacted]"));
  render(<CoderPreviewPanel workbench={item} config={config} />);
  const input = await screen.findByLabelText('Paste the token from the page');
  fireEvent.change(input, { target: { value: 'sensitive-token' } });
  fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('bad [redacted]'));
  expect(input).toHaveValue('sensitive-token');
  expect(bridge.check).not.toHaveBeenCalled();
});
it('offers to start a stopped workspace', async () => {
  const item = session();
  const problem: CoderProblem = { step: 'workspace', code: 'workspace_stopped', message: 'The workspace dev is stopped.', commands: [{ command: 'coder start dev' }], action: 'start_workspace' };
  bridge.state.mockResolvedValue(withProblem(problem, { cliReady: true, signedIn: true, workspace: 'dev' }));
  render(<CoderPreviewPanel workbench={item} config={config} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Start workspace' }));
  await waitFor(() => expect(bridge.startWorkspace).toHaveBeenCalledWith(item.id));
});
it('shows a spinner on the step that runs and its progress text', async () => {
  const item = session();
  let release!: (value: CoderPreviewState) => void;
  bridge.state.mockResolvedValue({ ...base, cliReady: true, step: 'login', stepDetail: 'Checking the sign-in to https://coder.example' });
  render(<CoderPreviewPanel workbench={item} config={config} />);
  bridge.check.mockReturnValue(new Promise((resolve) => { release = resolve; }));
  fireEvent.click(await screen.findByRole('button', { name: 'Check setup' }));
  await waitFor(() => expect(screen.getByText('Signed in')).toHaveAttribute('data-state', 'current'));
  expect(screen.getByLabelText('In progress')).toBeInTheDocument();
  expect(screen.getByText('Checking the sign-in to https://coder.example')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Preview in Coder' })).toBeDisabled();
  await act(async () => { release({ ...base }); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Preview in Coder' })).toBeEnabled());
});
it('runs the checks again on request', async () => {
  const item = session();
  bridge.state.mockResolvedValue(withProblem(notInstalled));
  render(<CoderPreviewPanel workbench={item} config={config} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
  await waitFor(() => expect(bridge.check).toHaveBeenCalledWith({ sessionId: item.id, repoName: 'org/repo', config }));
});
it.each<[string, () => void, string]>([
  ['the check throws', () => bridge.check.mockRejectedValue(new Error("Error invoking remote method 'workbench:coder-preview:check': Error: Invalid repository name.")), 'Invalid repository name.'],
  ['the patch cannot be read', () => patch.mockRejectedValue(new Error('The sandbox is not ready.')), 'The sandbox is not ready.'],
  ['prepare fails', () => bridge.prepare.mockRejectedValue(new Error("Error invoking remote method 'workbench:coder-preview:prepare': Error: Coder command failed (128): fatal: not a git repository")), 'Coder command failed (128): fatal: not a git repository'],
  ['the run fails', () => bridge.run.mockRejectedValue(new Error('Sync this preview before you run it.')), 'Sync this preview before you run it.'],
  ['open fails', () => bridge.open.mockRejectedValue(new Error('Local port 8010 is in use.')), 'Local port 8010 is in use.'],
])('never fails silently when %s', async (_name, fail, text) => {
  const item = session();
  bridge.state.mockResolvedValue({ ...base });
  fail();
  render(<CoderPreviewPanel workbench={item} config={config} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview in Coder' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(text);
  expect(alert).not.toHaveTextContent('Error invoking remote method');
  expect(screen.getByRole('button', { name: 'Preview in Coder' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
});
it('stops before the patch when a check finds a problem', async () => {
  const item = session();
  bridge.state.mockResolvedValue({ ...base });
  bridge.check.mockResolvedValue(withProblem({ step: 'login', code: 'not_logged_in', message: 'Sign in.' }));
  render(<CoderPreviewPanel workbench={item} config={config} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview in Coder' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Sign in.');
  expect(patch).not.toHaveBeenCalled();
});
it('continues past a stopped workspace, because prepare starts it', async () => {
  const item = session();
  bridge.state.mockResolvedValue({ ...base });
  bridge.check.mockResolvedValue(withProblem({ step: 'workspace', code: 'workspace_stopped', message: 'Stopped.', action: 'start_workspace' }));
  render(<CoderPreviewPanel workbench={item} config={config} />);
  fireEvent.click(screen.getByRole('button', { name: 'Preview in Coder' }));
  await waitFor(() => expect(bridge.open).toHaveBeenCalledWith(item.id));
});

it('shows a stopped workspace calmly, with Start now, and no error', async () => {
  const item = session();
  const stopped = { ...base, workspaceStopped: true, workspaceRunning: false, workspace: 'dev', stepDetail: 'dev is stopped. Preview in Coder starts it, usually in a minute or two.' };
  bridge.state.mockResolvedValue(stopped);
  bridge.check.mockResolvedValue(stopped);
  render(<CoderPreviewPanel workbench={item} config={config} />);
  const note = await screen.findByTestId('coder-workspace-stopped');
  expect(note).toHaveTextContent('Preview in Coder starts it');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(document.querySelector('[data-step="workspace"]')).toHaveAttribute('data-state', 'pending');
  expect(screen.getByText('Workspace stopped')).toBeInTheDocument();
  fireEvent.click(within(note).getByRole('button', { name: 'Start now' }));
  await waitFor(() => expect(bridge.startWorkspace).toHaveBeenCalled());
});
