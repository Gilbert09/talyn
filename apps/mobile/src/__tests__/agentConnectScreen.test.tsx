import type { FleetAccountsResponse } from '@talyn/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';

import { ConnectAgentPanel } from '../features/agents/connect/ConnectAgentSheet';
import { fixture } from './workflowFixtures';

const mockLifecycle = fixture().lifecycle;
const mockLoad = jest.fn(async (_entity: string) => undefined);
const mockStart = jest.fn();
const mockComplete = jest.fn();
const mockList = jest.fn();
const mockAdd = jest.fn();
const mockRename = jest.fn();
jest.mock('@talyn/client/native', () => ({
  ...jest.requireActual('@talyn/client/native'),
  cloudProviders: {
    startClaudeSignIn: (...args: unknown[]) => mockStart(...args),
    completeClaudeSignIn: (...args: unknown[]) => mockComplete(...args),
    fleetAccounts: {
      list: (...args: unknown[]) => mockList(...args),
      add: (...args: unknown[]) => mockAdd(...args),
      rename: (...args: unknown[]) => mockRename(...args),
    },
  },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: { load: mockLoad }, lifecycle: mockLifecycle }),
  useWorkspace: () => ({ status: 'ready', selected: 'one' }),
}));
jest.mock('../workflow/hooks', () => ({
  useResource: () => ({ status: 'ready', data: [{ type: 'selfhosted', connectedAgents: [], reauthAgents: [] }], refresh: jest.fn() }),
}));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'dismiss' })) }));
jest.mock('expo-clipboard', () => ({
  hasStringAsync: jest.fn(async () => true), getStringAsync: jest.fn(async () => ''), setStringAsync: jest.fn(async () => true),
}));

const CODE = `AbCdEf0123456789_-xyz#${'a'.repeat(32)}`;
const accounts = (list: FleetAccountsResponse['accounts'] = []): FleetAccountsResponse => ({ accounts: list, switchAtPercent: 90, active: { claude: null, codex: null } });
const clipboard = Clipboard as jest.Mocked<typeof Clipboard>;
const browser = WebBrowser as jest.Mocked<typeof WebBrowser>;

beforeEach(() => {
  mockList.mockResolvedValue(accounts());
  mockStart.mockResolvedValue({ url: 'https://claude.com/cai/oauth/authorize?x=1' });
  mockComplete.mockResolvedValue({ connected: true });
  clipboard.hasStringAsync.mockResolvedValue(true);
  clipboard.getStringAsync.mockResolvedValue('');
});

async function startSignIn() {
  await screen.findByText('Sign in with Claude');
  await act(async () => { fireEvent.press(screen.getByLabelText('Sign in with Claude')); });
  await screen.findByLabelText('Code from Anthropic');
}

describe('Claude sign-in', () => {
  it('opens Anthropic, fills a copied code and finishes the sign-in', async () => {
    clipboard.getStringAsync.mockResolvedValue(`  ${CODE}\n`);
    const onConnected = jest.fn();
    await render(<ConnectAgentPanel agent="claude" onConnected={onConnected} />);
    await startSignIn();
    expect(mockStart).toHaveBeenCalledWith('one', { newAccount: true });
    expect(browser.openBrowserAsync).toHaveBeenCalledWith('https://claude.com/cai/oauth/authorize?x=1');
    await waitFor(() => expect(screen.getByLabelText('Code from Anthropic').props.value).toBe(CODE));
    await act(async () => { fireEvent.press(screen.getByLabelText('Finish sign-in')); });
    expect(mockComplete).toHaveBeenCalledWith('one', CODE, { newAccount: true });
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(mockLoad.mock.calls.map(([entity]) => entity)).toEqual(expect.arrayContaining(['providers', 'readiness']));
  });

  it('leaves the field empty when the clipboard holds something else', async () => {
    clipboard.getStringAsync.mockResolvedValue('my bank password');
    await render(<ConnectAgentPanel agent="claude" onConnected={jest.fn()} />);
    await startSignIn();
    await waitFor(() => expect(clipboard.getStringAsync).toHaveBeenCalled());
    expect(screen.getByLabelText('Code from Anthropic').props.value).toBe('');
    expect(screen.getByLabelText('Finish sign-in').props.accessibilityState.disabled).toBe(true);
  });

  it('pastes on request and shows the server’s refusal as it is', async () => {
    mockComplete.mockRejectedValue(Object.assign(new Error('This Claude account has no subscription that can run a model.'), { status: 400 }));
    const onConnected = jest.fn();
    await render(<ConnectAgentPanel agent="claude" onConnected={onConnected} />);
    clipboard.hasStringAsync.mockResolvedValue(false);
    await startSignIn();
    clipboard.getStringAsync.mockResolvedValue('typed-code#state');
    await act(async () => { fireEvent.press(screen.getByLabelText('Paste')); });
    expect(screen.getByLabelText('Code from Anthropic').props.value).toBe('typed-code#state');
    await act(async () => { fireEvent.press(screen.getByLabelText('Finish sign-in')); });
    expect(await screen.findByText('This Claude account has no subscription that can run a model.')).toBeTruthy();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('reconnects the account whose sign-in expired', async () => {
    mockList.mockResolvedValue(accounts([{ id: 'acc-1', agent: 'claude', kind: 'claude_oauth', label: 'Work', priority: 0, needsReauth: true,
      held: null, usage: null, over: false }]));
    await render(<ConnectAgentPanel agent="claude" onConnected={jest.fn()} />);
    expect(await screen.findByText(/Anthropic no longer accepts the saved sign-in/)).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Sign in to Claude again')); });
    expect(mockStart).toHaveBeenCalledWith('one', { accountId: 'acc-1' });
  });

  it('uses the single sign-in on an older backend', async () => {
    mockList.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    await render(<ConnectAgentPanel agent="claude" onConnected={jest.fn()} />);
    await startSignIn();
    expect(mockStart).toHaveBeenCalledWith('one', undefined);
  });

  it('checks an API key before it sends it', async () => {
    mockAdd.mockResolvedValue({});
    const onConnected = jest.fn();
    await render(<ConnectAgentPanel agent="claude" onConnected={onConnected} />);
    await screen.findByText('Sign in with Claude');
    await act(async () => { fireEvent.press(screen.getByLabelText('Use an API key instead')); });
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Anthropic API key'), 'sk-proj-wrong'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Add key')); });
    expect(screen.getByText(/does not look like a Claude credential/)).toBeTruthy();
    expect(mockAdd).not.toHaveBeenCalled();
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Anthropic API key'), ' sk-ant-api03-good '); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Add key')); });
    expect(mockAdd).toHaveBeenCalledWith('one', 'claude', 'anthropic_key', 'sk-ant-api03-good');
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
  });
});

describe('naming a new account', () => {
  const added = (label: string) => ({ id: 'new', agent: 'claude' as const, kind: 'claude_oauth' as const, label, priority: 1,
    needsReauth: false, held: null, usage: null, over: false });

  async function connectBySignIn(onConnected: jest.Mock) {
    mockComplete.mockResolvedValue({ connected: true, accountId: 'new' });
    await render(<ConnectAgentPanel agent="claude" onConnected={onConnected} />);
    await startSignIn();
    mockList.mockResolvedValue(accounts([added('Claude 2')]));
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Code from Anthropic'), CODE); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Finish sign-in')); });
    return screen.findByLabelText('Account name');
  }

  it('asks for a name after the sign-in, prefilled with the server’s name, and saves a new one', async () => {
    const onConnected = jest.fn();
    const onAdded = jest.fn();
    mockComplete.mockResolvedValue({ connected: true, accountId: 'new' });
    await render(<ConnectAgentPanel agent="claude" onConnected={onConnected} onAdded={onAdded} />);
    await startSignIn();
    mockList.mockResolvedValue(accounts([added('Claude 2')]));
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Code from Anthropic'), CODE); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Finish sign-in')); });
    const field = await screen.findByLabelText('Account name');
    expect(field.props.value).toBe('Claude 2');
    expect(field.props.autoFocus).toBe(true);
    expect(screen.getByText('Connected. Give this account a name, or keep this one.')).toBeTruthy();
    expect(onAdded).toHaveBeenCalledTimes(1);
    expect(onConnected).not.toHaveBeenCalled();
    mockRename.mockResolvedValue(undefined);
    await act(async () => { fireEvent.changeText(field, '  Work  '); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Save')); });
    expect(mockRename).toHaveBeenCalledWith('new', 'Work');
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Skip', async () => { fireEvent.press(screen.getByLabelText('Skip')); }],
    ['Save with the same name', async () => { fireEvent.press(screen.getByLabelText('Save')); }],
  ])('keeps the server’s name on %s', async (_name, press) => {
    const onConnected = jest.fn();
    await connectBySignIn(onConnected);
    await act(press);
    expect(mockRename).not.toHaveBeenCalled();
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty name and shows a failed rename', async () => {
    const onConnected = jest.fn();
    const field = await connectBySignIn(onConnected);
    await act(async () => { fireEvent.changeText(field, '   '); });
    expect(screen.getByLabelText('Save').props.accessibilityState.disabled).toBe(true);
    await act(async () => { fireEvent(field, 'submitEditing'); });
    expect(screen.getByText('Enter an account name.')).toBeTruthy();
    mockRename.mockRejectedValue(new Error('An account needs a name.'));
    await act(async () => { fireEvent.changeText(field, 'Work'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Save')); });
    expect(await screen.findByText('An account needs a name.')).toBeTruthy();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('asks for a name after an API key', async () => {
    mockAdd.mockResolvedValue({ ...added('Claude'), kind: 'anthropic_key' });
    await render(<ConnectAgentPanel agent="claude" onConnected={jest.fn()} />);
    await screen.findByText('Sign in with Claude');
    await act(async () => { fireEvent.press(screen.getByLabelText('Use an API key instead')); });
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Anthropic API key'), 'sk-ant-api03-good'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Add key')); });
    expect((await screen.findByLabelText('Account name')).props.value).toBe('Claude');
  });

  it('asks for no name after a reconnect', async () => {
    mockList.mockResolvedValue(accounts([{ ...added('Work'), id: 'acc-1', needsReauth: true }]));
    mockComplete.mockResolvedValue({ connected: true, accountId: 'acc-1' });
    const onConnected = jest.fn();
    await render(<ConnectAgentPanel agent="claude" onConnected={onConnected} />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Sign in to Claude again')); });
    await act(async () => { fireEvent.changeText(await screen.findByLabelText('Code from Anthropic'), CODE); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Finish sign-in')); });
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText('Account name')).toBeNull();
  });
});

describe('Codex', () => {
  it('sends the ChatGPT sign-in to a computer and offers an API key', async () => {
    await render(<ConnectAgentPanel agent="codex" onConnected={jest.fn()} />);
    expect(await screen.findByText('Finish on your computer')).toBeTruthy();
    expect(screen.getByText('Run codex login in a terminal.')).toBeTruthy();
    expect(screen.getByLabelText('OpenAI API key')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Copy the link https://app.talyn.dev/settings/integrations')); });
    expect(clipboard.setStringAsync).toHaveBeenCalledWith('https://app.talyn.dev/settings/integrations');
  });

  it('asks which agent when none is given', async () => {
    await render(<ConnectAgentPanel onConnected={jest.fn()} />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Codex: Not connected')); });
    expect(await screen.findByText('Finish on your computer')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Choose a different agent')); });
    expect(screen.getByLabelText('Claude: Not connected')).toBeTruthy();
  });
});
