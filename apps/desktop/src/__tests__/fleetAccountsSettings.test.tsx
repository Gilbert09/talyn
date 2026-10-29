import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { FleetAccountView, Workspace } from '@talyn/shared';
import { ApiError } from '../renderer/lib/api';
import { FleetAccountsList, formatResetAt } from '../renderer/components/settings/FleetAccountsList';
import { FleetSwitchThresholdRow } from '../renderer/components/settings/sections/AgentsSettings';

const list = jest.fn();
const add = jest.fn();
const rename = jest.fn();
const reorder = jest.fn();
const remove = jest.fn();
const refreshUsage = jest.fn();
const update = jest.fn();
const startClaudeSignIn = jest.fn();
const completeClaudeSignIn = jest.fn();
const saveConfig = jest.fn();
const openExternal = jest.fn();
const codexSignIn = jest.fn();

jest.mock('../renderer/lib/openExternal', () => ({ openExternal: (...args: unknown[]) => openExternal(...args) }));

jest.mock('../renderer/lib/api', () => ({
  ApiError: class extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
  },
  api: {
    cloudProviders: {
      startClaudeSignIn: (...args: unknown[]) => startClaudeSignIn(...args),
      completeClaudeSignIn: (...args: unknown[]) => completeClaudeSignIn(...args),
      saveConfig: (...args: unknown[]) => saveConfig(...args),
      fleetAccounts: {
        list: (...args: unknown[]) => list(...args),
        add: (...args: unknown[]) => add(...args),
        rename: (...args: unknown[]) => rename(...args),
        reorder: (...args: unknown[]) => reorder(...args),
        remove: (...args: unknown[]) => remove(...args),
        refreshUsage: (...args: unknown[]) => refreshUsage(...args),
      },
    },
    workspaces: { update: (...args: unknown[]) => update(...args) },
  },
}));

const setWorkspaces = jest.fn();
let workspaces: Workspace[] = [];
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) => selector({
    currentWorkspaceId: 'ws1', workspaces, setWorkspaces,
  }),
}));

const onChanged = jest.fn().mockResolvedValue(undefined);
const account = (id: string, overrides: Partial<FleetAccountView> = {}): FleetAccountView => ({
  id, agent: 'claude', kind: 'claude_oauth', label: `Claude ${id}`, priority: Number(id),
  needsReauth: false, held: null, usage: null, over: false, ...overrides,
});

function renderList(accounts: FleetAccountView[], switchAtPercent = 95) {
  return render(<FleetAccountsList agent="claude" workspaceId="ws1" accounts={accounts}
    activeId={accounts[0]?.id ?? null} switchAtPercent={switchAtPercent} onChanged={onChanged} />);
}

beforeEach(() => {
  workspaces = [{ id: 'ws1', settings: {} } as Workspace];
  add.mockResolvedValue({});
  rename.mockResolvedValue(undefined);
  reorder.mockResolvedValue([]);
  remove.mockResolvedValue(undefined);
  refreshUsage.mockResolvedValue(null);
  update.mockResolvedValue({});
  startClaudeSignIn.mockResolvedValue({ url: 'https://example.com/sign-in' });
  completeClaudeSignIn.mockResolvedValue(undefined);
  saveConfig.mockResolvedValue(undefined);
  openExternal.mockResolvedValue(undefined);
  codexSignIn.mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh' });
  Object.defineProperty(window, 'electron', { configurable: true, value: { codex: { signIn: codexSignIn } } });
});

afterEach(() => { cleanup(); jest.clearAllMocks(); });

it.each([
  ['claude_oauth', 'Claude subscription'],
  ['anthropic_key', 'API key'],
  ['codex_oauth', 'ChatGPT subscription'],
] as const)('shows %s as %s', (kind, plainKind) => {
  const agent = kind === 'codex_oauth' ? 'codex' : 'claude';
  render(<FleetAccountsList agent={agent} workspaceId="ws1" accounts={[account('1', { kind, agent })]}
    activeId="1" switchAtPercent={95} onChanged={onChanged} />);
  expect(screen.getByText('Claude 1')).toBeInTheDocument();
  expect(screen.getByText(plainKind)).toBeInTheDocument();
  expect(screen.getByText('Active')).toBeInTheDocument();
});

it('shows account status and API key usage text', () => {
  renderList([
    account('1', { needsReauth: true }),
    account('2', { kind: 'anthropic_key', held: { until: new Date(Date.now() + 60 * 60_000).toISOString() } }),
    account('3', { over: true }),
  ]);
  expect(screen.getByText('Reconnect needed')).toBeInTheDocument();
  expect(screen.getByText(/Limit reached, resets/)).toBeInTheDocument();
  expect(screen.getByText('Over 95%')).toBeInTheDocument();
  expect(screen.getByText(/No usage data for API keys/)).toBeInTheDocument();
});

it('shows a single kind label only when it differs from the account name', () => {
  renderList([account('1', { label: 'cLaUdE SuBsCrIpTiOn' })]);
  expect(screen.getAllByText(/claude subscription/i)).toHaveLength(1);
});

it('shows Limit reached when the switch threshold is 100%', () => {
  renderList([account('1', { over: true })], 100);
  expect(screen.getByText('Limit reached')).toBeInTheDocument();
  expect(screen.queryByText('Over 100%')).not.toBeInTheDocument();
});

it('shows the weekly summary and reveals every window for one card', () => {
  const usage = { fetchedAt: new Date().toISOString(), windows: [
    { key: 'session', label: '5-hour', usedPercent: 90, resetsAt: null },
    { key: 'weekly_scoped:fable', label: 'Weekly (Fable)', usedPercent: 99, resetsAt: null },
    { key: 'weekly_all', label: 'Weekly', usedPercent: 85, resetsAt: null },
  ] };
  renderList([account('1', { usage }), account('2', { usage })]);
  const first = screen.getByTestId('fleet-account-1');
  const second = screen.getByTestId('fleet-account-2');
  expect(within(first).getByText(/Weekly 85%/)).toBeInTheDocument();
  expect(within(first).queryByRole('progressbar')).not.toBeInTheDocument();
  expect(within(first).queryByText('Weekly (Fable)')).not.toBeInTheDocument();
  const toggle = within(first).getByRole('button', { name: 'Usage' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(within(first).getByText('5-hour')).toBeInTheDocument();
  expect(within(first).getByText('Weekly (Fable)')).toBeInTheDocument();
  expect(within(first).getAllByRole('progressbar')).toHaveLength(3);
  expect(within(second).queryByRole('progressbar')).not.toBeInTheDocument();
  fireEvent.click(toggle);
  expect(within(first).queryByRole('progressbar')).not.toBeInTheDocument();
});

it('uses the highest window when no all-model weekly window exists', () => {
  renderList([account('1', { usage: { fetchedAt: new Date().toISOString(), windows: [
    { key: 'session', label: '5-hour', usedPercent: 35, resetsAt: null },
    { key: 'weekly_scoped:fable', label: 'Weekly (Fable)', usedPercent: 80, resetsAt: null },
  ] } })]);
  expect(screen.getByText(/Weekly \(Fable\) 80%/)).toBeInTheDocument();
});

it.each([
  [new Date(2026, 9, 23, 20), 'today'],
  [new Date(2026, 9, 24, 20, 30), 'tomorrow'],
  [new Date(2026, 9, 26, 20), 'weekday'],
  [new Date(2026, 9, 31, 20, 30), 'date'],
] as const)('formats reset time for %s as %s', (reset, dayLabel) => {
  const now = new Date(2026, 9, 23, 12);
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(reset);
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(reset);
  const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(reset);
  const suffix = dayLabel === 'weekday' ? weekday : dayLabel === 'date' ? `${weekday} ${date}` : dayLabel;
  const day = dayLabel === 'today' || dayLabel === 'tomorrow' ? dayLabel : suffix;
  expect(formatResetAt(reset.toISOString(), now)).toBe(`resets ${day} at ${time}`);
});

it.each([
  [84, 'bg-primary'], [85, 'bg-warning'], [94, 'bg-warning'], [95, 'bg-destructive'],
])('uses %s%% bar color %s at a 95%% threshold', (percent, color) => {
  renderList([account('1', { usage: { fetchedAt: new Date().toISOString(), windows: [
    { key: 'week', label: 'Weekly', usedPercent: percent, resetsAt: null },
  ] } })]);
  fireEvent.click(screen.getByRole('button', { name: 'Usage' }));
  expect(screen.getByRole('progressbar', { name: 'Weekly usage' }).firstElementChild).toHaveClass(color);
});

it('reorders with the complete account id list', async () => {
  renderList([account('1'), account('2'), account('3')]);
  expect(screen.getByRole('button', { name: 'Move Claude 1 up' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Move Claude 3 down' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Move Claude 2 up' }));
  await waitFor(() => expect(reorder).toHaveBeenCalledWith('ws1', 'claude', ['2', '1', '3']));
});

it('requires an inline confirmation before removal', async () => {
  renderList([account('1')]);
  fireEvent.click(screen.getByRole('button', { name: 'Remove Claude 1' }));
  expect(remove).not.toHaveBeenCalled();
  const row = screen.getByTestId('fleet-account-1');
  expect(within(row).getByText('Remove Claude 1?')).toBeInTheDocument();
  fireEvent.click(within(row).getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith('1'));
});

it('renames on Enter and cancels on Escape', async () => {
  renderList([account('1')]);
  fireEvent.click(screen.getByRole('button', { name: 'Claude 1' }));
  const input = screen.getByLabelText('Name for Claude 1');
  fireEvent.change(input, { target: { value: 'Primary' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(rename).toHaveBeenCalledWith('1', 'Primary'));
  fireEvent.click(screen.getByRole('button', { name: 'Claude 1' }));
  fireEvent.keyDown(screen.getByLabelText('Name for Claude 1'), { key: 'Escape' });
  expect(rename).toHaveBeenCalledTimes(1);
});

it('adds a labeled API key', async () => {
  renderList([account('1')]);
  fireEvent.click(screen.getByRole('button', { name: 'Add another Claude account' }));
  expect(screen.getByLabelText('Account name')).toHaveValue('Claude 2');
  fireEvent.click(screen.getByRole('button', { name: 'Paste an API key' }));
  fireEvent.change(screen.getByLabelText('Claude API key'), { target: { value: 'fake-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
  await waitFor(() => expect(add).toHaveBeenCalledWith('ws1', 'claude', 'anthropic_key', 'fake-key', 'Claude 2'));
});

it('starts Claude sign-in after one click and shows the code step', async () => {
  renderList([account('1')]);
  fireEvent.click(screen.getByRole('button', { name: 'Add another Claude account' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(startClaudeSignIn).toHaveBeenCalledWith('ws1', { label: 'Claude 2' }));
  await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://example.com/sign-in'));
  expect(await screen.findByLabelText('Code from Anthropic')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sign in with Claude' })).not.toBeInTheDocument();
});

it('starts Codex sign-in after one click', async () => {
  render(<FleetAccountsList agent="codex" workspaceId="ws1" accounts={[]} activeId={null}
    switchAtPercent={95} onChanged={onChanged} />);
  expect(screen.getByText('Not connected')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Connect Codex' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(codexSignIn).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(saveConfig).toHaveBeenCalledWith('selfhosted', 'ws1', {
    codexAccessToken: 'access', codexRefreshToken: 'refresh',
  }, { codexLabel: 'Codex 1' }));
  expect(screen.queryByRole('button', { name: 'Sign in with ChatGPT' })).not.toBeInTheDocument();
});

it('keeps Claude sign-in errors visible and permits another attempt', async () => {
  startClaudeSignIn.mockRejectedValueOnce(new Error('Sign-in failed'));
  renderList([]);
  fireEvent.click(screen.getByRole('button', { name: 'Connect Claude' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in failed');
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByLabelText('Code from Anthropic')).toBeInTheDocument();
});

it('keeps per-account Claude reconnect working', async () => {
  renderList([account('1', { needsReauth: true })]);
  fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
  await waitFor(() => expect(startClaudeSignIn).toHaveBeenCalledWith('ws1', { accountId: '1' }));
  expect(await screen.findByLabelText('Code for Claude 1')).toBeInTheDocument();
});

it('shows the kill switch message when a second account is refused', async () => {
  add.mockRejectedValue(new ApiError('Multiple accounts are disabled', 403, 'multi_account_disabled'));
  renderList([account('1')]);
  fireEvent.click(screen.getByRole('button', { name: 'Add another Claude account' }));
  fireEvent.click(screen.getByRole('button', { name: 'Paste an API key' }));
  fireEvent.change(screen.getByLabelText('Claude API key'), { target: { value: 'fake-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Adding more accounts is turned off for this workspace.');
});

it.each(['49', '101', '75.5', ''])('rejects invalid threshold %s', (value) => {
  render(<FleetSwitchThresholdRow />);
  const input = screen.getByLabelText('Switch accounts at');
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number from 50 to 100.');
  expect(update).not.toHaveBeenCalled();
});

it('saves a valid threshold and updates the workspace store', async () => {
  render(<FleetSwitchThresholdRow />);
  const input = screen.getByLabelText('Switch accounts at');
  fireEvent.change(input, { target: { value: '95' } });
  fireEvent.blur(input);
  await waitFor(() => expect(update).toHaveBeenCalledWith('ws1', { settings: { fleetSwitchAtPercent: 95 } }));
  expect(setWorkspaces).toHaveBeenCalled();
});

it('shows the server error when it refuses a threshold', async () => {
  update.mockRejectedValue(new ApiError('Threshold refused', 400));
  render(<FleetSwitchThresholdRow />);
  const input = screen.getByLabelText('Switch accounts at');
  fireEvent.change(input, { target: { value: '95' } });
  fireEvent.blur(input);
  expect(await screen.findByRole('alert')).toHaveTextContent('Threshold refused');
});
