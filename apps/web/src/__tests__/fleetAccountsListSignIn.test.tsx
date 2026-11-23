import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { FleetAccountView } from '@talyn/shared';

const mocks = vi.hoisted(() => ({
  startClaudeSignIn: vi.fn(),
  completeClaudeSignIn: vi.fn(),
  saveConfig: vi.fn(),
  add: vi.fn(),
  rename: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  prepareSignInWindow: vi.fn(),
  onChanged: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  ApiError: class extends Error {},
  api: {
    cloudProviders: {
      startClaudeSignIn: mocks.startClaudeSignIn,
      completeClaudeSignIn: mocks.completeClaudeSignIn,
      saveConfig: mocks.saveConfig,
      fleetAccounts: { add: mocks.add, rename: mocks.rename },
    },
  },
}));
vi.mock('../lib/openExternal', () => ({
  openExternal: vi.fn(),
  prepareSignInWindow: mocks.prepareSignInWindow,
}));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));

const { trackEvent } = await import('../lib/analytics');
const { ApiError } = await import('../lib/api');
const { FleetAccountsList, FleetAccountRow } = await import('../components/settings/FleetAccountsList');

const URL_ = 'https://claude.ai/oauth/authorize?x=1';

function renderList(agent: 'claude' | 'codex') {
  return render(
    <FleetAccountsList agent={agent} workspaceId="ws1" accounts={[]} activeId={null} switchAtPercent={95} onChanged={mocks.onChanged} />
  );
}

function startAdding(agent: 'claude' | 'codex') {
  renderList(agent);
  fireEvent.click(screen.getByRole('button', { name: `Connect ${agent === 'claude' ? 'Claude' : 'Codex'}` }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepareSignInWindow.mockReturnValue({ open: mocks.open, close: mocks.close });
  mocks.onChanged.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('Claude sign-in in the accounts list', () => {
  it('reserves the tab before the API call and loads the URL in it', async () => {
    let reservedFirst = false;
    mocks.startClaudeSignIn.mockImplementation(async () => {
      reservedFirst = mocks.prepareSignInWindow.mock.calls.length === 1;
      return { url: URL_ };
    });
    mocks.open.mockResolvedValue(true);
    startAdding('claude');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByLabelText('Code from Anthropic');
    expect(reservedFirst).toBe(true);
    expect(mocks.open).toHaveBeenCalledWith(URL_);
    expect(screen.queryByRole('link', { name: 'Open the Claude sign-in page' })).toBeNull();
    expect(trackEvent).toHaveBeenCalledWith('cloud_provider_signin_started', {
      provider: 'selfhosted', agent: 'claude', method: 'claude_oauth',
    });
  });

  it('shows a fallback link when the tab is blocked', async () => {
    mocks.startClaudeSignIn.mockResolvedValue({ url: URL_ });
    mocks.open.mockResolvedValue(false);
    startAdding('claude');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const link = await screen.findByRole('link', { name: 'Open the Claude sign-in page' });
    expect(link.getAttribute('href')).toBe(URL_);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.getByLabelText('Code from Anthropic')).toBeTruthy();
  });

  it('closes the tab and reports a failed start', async () => {
    mocks.startClaudeSignIn.mockRejectedValue(new Error('backend said no'));
    startAdding('claude');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByText('backend said no');
    expect(mocks.close).toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connect_failed', {
      provider: 'selfhosted', agent: 'claude', stage: 'start', error: 'backend said no', error_code: null,
    });
  });

  it('reports a failed finish and a successful one', async () => {
    mocks.startClaudeSignIn.mockResolvedValue({ url: URL_ });
    mocks.open.mockResolvedValue(true);
    mocks.completeClaudeSignIn.mockRejectedValueOnce(new Error('bad code')).mockResolvedValueOnce({ connected: true });
    startAdding('claude');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.change(await screen.findByLabelText('Code from Anthropic'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));

    await screen.findByText('bad code');
    expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connect_failed', expect.objectContaining({ stage: 'finish', error: 'bad code' }));
    expect(trackEvent).not.toHaveBeenCalledWith('cloud_provider_connected', expect.anything());

    fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connected', { provider: 'selfhosted', agent: 'claude' }));
  });
});

describe('Claude reconnect in an account row', () => {
  const account = {
    id: 'a1', agent: 'claude', kind: 'claude_oauth', label: 'Work', priority: 0, needsReauth: true, usage: null,
  } as unknown as FleetAccountView;

  it('reserves the tab first and shows the fallback link when blocked', async () => {
    let reservedFirst = false;
    mocks.startClaudeSignIn.mockImplementation(async () => {
      reservedFirst = mocks.prepareSignInWindow.mock.calls.length === 1;
      return { url: URL_ };
    });
    mocks.open.mockResolvedValue(false);
    render(<FleetAccountRow account={account} active={false} switchAtPercent={95} index={0} ids={['a1']} workspaceId="ws1" onChanged={mocks.onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));

    const link = await screen.findByRole('link', { name: 'Open the Claude sign-in page' });
    expect(link.getAttribute('href')).toBe(URL_);
    expect(reservedFirst).toBe(true);
    expect(trackEvent).toHaveBeenCalledWith('cloud_provider_signin_started', {
      provider: 'selfhosted', agent: 'claude', method: 'claude_oauth',
    });
  });
});

describe('API key and Codex paste in the accounts list', () => {
  it.each([
    ['claude', 'Claude API key', 'claude_api_key'],
    ['codex', 'Codex API key', 'codex_api_key'],
  ] as const)('tracks the %s API key save failure', async (agent, label, method) => {
    mocks.add.mockRejectedValue(new Error('x'.repeat(300)));
    startAdding(agent);
    fireEvent.click(screen.getByRole('button', { name: 'Paste an API key' }));
    fireEvent.change(screen.getByLabelText(label), { target: { value: 'sk-x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));

    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connect_failed', {
      provider: 'selfhosted', agent, stage: 'save', error: 'x'.repeat(200), error_code: null,
    }));
    expect(trackEvent).toHaveBeenCalledWith('cloud_provider_signin_started', { provider: 'selfhosted', agent, method });
  });

  it('tracks a successful API key add once', async () => {
    mocks.add.mockResolvedValue({});
    startAdding('claude');
    fireEvent.click(screen.getByRole('button', { name: 'Paste an API key' }));
    fireEvent.change(screen.getByLabelText('Claude API key'), { target: { value: 'sk-x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));

    await waitFor(() => expect(mocks.onChanged).toHaveBeenCalled());
    expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connected', { provider: 'selfhosted', agent: 'claude' });
    expect(vi.mocked(trackEvent).mock.calls.filter(([name]) => name === 'cloud_provider_connected')).toHaveLength(1);
  });

  it.each([
    ['not JSON', 'nope', 'parse'],
    ['valid JSON, save rejected', JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' } }), 'save'],
  ])('tracks the Codex paste: %s', async (_name, value, stage) => {
    mocks.saveConfig.mockRejectedValue(new Error('save refused'));
    startAdding('codex');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.change(await screen.findByLabelText('Codex auth JSON'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save sign-in' }));

    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connect_failed', expect.objectContaining({
      provider: 'selfhosted', agent: 'codex', stage,
    })));
    expect(trackEvent).toHaveBeenCalledWith('cloud_provider_signin_started', { provider: 'selfhosted', agent: 'codex', method: 'codex_paste' });
    expect(mocks.prepareSignInWindow).not.toHaveBeenCalled();
  });
});

function view(id: string, label: string, agent: 'claude' | 'codex' = 'claude'): FleetAccountView {
  return {
    id, agent, kind: agent === 'claude' ? 'claude_oauth' : 'codex_oauth', label, priority: 1,
    needsReauth: false, held: null, usage: null, over: false,
  } as FleetAccountView;
}

// Holds the account list, as the settings panel does, so a connect can add a row.
function Harness({ agent, initial, added }: { agent: 'claude' | 'codex'; initial: FleetAccountView[]; added: FleetAccountView }) {
  const [accounts, setAccounts] = useState(initial);
  return <FleetAccountsList agent={agent} workspaceId="ws1" accounts={accounts} activeId={null} switchAtPercent={95}
    onChanged={async () => { await mocks.onChanged(); setAccounts([...initial, added]); }} />;
}

const CONNECTS = {
  'a Claude sign-in': async () => {
    mocks.startClaudeSignIn.mockResolvedValue({ url: URL_ });
    mocks.open.mockResolvedValue(true);
    mocks.completeClaudeSignIn.mockResolvedValue({ connected: true, accountId: 'new' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.change(await screen.findByLabelText('Code from Anthropic'), { target: { value: 'abc#def' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
  },
  'an API key': async () => {
    mocks.add.mockResolvedValue(view('new', 'Claude 2'));
    fireEvent.click(screen.getByRole('button', { name: 'Paste an API key' }));
    fireEvent.change(screen.getByLabelText('Claude API key'), { target: { value: 'sk-ant-x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
  },
} as const;

describe('naming an account after it connects', () => {
  it('asks for no name before the sign-in and sends a new-account target', async () => {
    mocks.startClaudeSignIn.mockResolvedValue({ url: URL_ });
    mocks.open.mockResolvedValue(true);
    mocks.completeClaudeSignIn.mockResolvedValue({ connected: true, accountId: 'new' });
    startAdding('claude');
    expect(screen.queryByLabelText('Account name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.change(await screen.findByLabelText('Code from Anthropic'), { target: { value: 'abc#def' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
    await waitFor(() => expect(mocks.completeClaudeSignIn).toHaveBeenCalledWith('ws1', 'abc#def', { newAccount: true }));
    expect(mocks.startClaudeSignIn).toHaveBeenCalledWith('ws1', { newAccount: true });
  });

  it('adds an API key with no name', async () => {
    mocks.add.mockResolvedValue(view('new', 'Claude'));
    startAdding('claude');
    await CONNECTS['an API key']();
    await waitFor(() => expect(mocks.add).toHaveBeenCalledWith('ws1', 'claude', 'anthropic_key', 'sk-ant-x'));
  });

  it.each(Object.keys(CONNECTS) as Array<keyof typeof CONNECTS>)('opens the name field on the new row after %s, and saves a new name', async (method) => {
    render(<Harness agent="claude" initial={[view('old', 'Claude')]} added={view('new', 'Claude 2')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add another Claude account' }));
    await CONNECTS[method]();

    const field = await screen.findByLabelText('Name for Claude 2');
    expect((field as HTMLInputElement).value).toBe('Claude 2');
    expect(document.activeElement).toBe(field);
    expect(screen.queryByLabelText('Name for Claude')).toBeNull();
    expect(screen.getByText('Connected. Give this account a name, or keep this one.')).toBeTruthy();

    mocks.rename.mockResolvedValue(undefined);
    fireEvent.change(field, { target: { value: '  Work  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.rename).toHaveBeenCalledWith('new', 'Work'));
    await waitFor(() => expect(screen.queryByLabelText('Name for Claude 2')).toBeNull());
  });

  it('opens the name field after a Codex paste', async () => {
    mocks.saveConfig.mockResolvedValue({ connected: true, accountId: 'new' });
    render(<Harness agent="codex" initial={[]} added={view('new', 'Codex', 'codex')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.change(await screen.findByLabelText('Codex auth JSON'), { target: { value: JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' } }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save sign-in' }));
    await waitFor(() => expect(mocks.saveConfig).toHaveBeenCalledWith('selfhosted', 'ws1', { codexAccessToken: 'a', codexRefreshToken: 'r' }, { codexNewAccount: true }));
    expect(((await screen.findByLabelText('Name for Codex')) as HTMLInputElement).value).toBe('Codex');
  });

  it.each([
    ['Skip', () => fireEvent.click(screen.getByRole('button', { name: 'Skip' }))],
    ['Escape', (field: HTMLElement) => fireEvent.keyDown(field, { key: 'Escape' })],
    ['Enter on the default name', (field: HTMLElement) => fireEvent.keyDown(field, { key: 'Enter' })],
  ])('keeps the default name on %s', async (_name, act) => {
    render(<Harness agent="claude" initial={[]} added={view('new', 'Claude')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Claude' }));
    mocks.add.mockResolvedValue(view('new', 'Claude'));
    fireEvent.click(screen.getByRole('button', { name: 'Paste an API key' }));
    fireEvent.change(screen.getByLabelText('Claude API key'), { target: { value: 'sk-ant-x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    const field = await screen.findByLabelText('Name for Claude');
    act(field);
    await waitFor(() => expect(screen.queryByLabelText('Name for Claude')).toBeNull());
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Claude' })).toBeTruthy();
  });

  it('refuses an empty name', async () => {
    render(<Harness agent="claude" initial={[]} added={view('new', 'Claude')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Claude' }));
    mocks.add.mockResolvedValue(view('new', 'Claude'));
    fireEvent.click(screen.getByRole('button', { name: 'Paste an API key' }));
    fireEvent.change(screen.getByLabelText('Claude API key'), { target: { value: 'sk-ant-x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    const field = await screen.findByLabelText('Name for Claude');
    fireEvent.change(field, { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(await screen.findByText('Enter an account name.')).toBeTruthy();
    expect(mocks.rename).not.toHaveBeenCalled();
  });

  it('opens no name field when an older backend answers without an id', async () => {
    mocks.completeClaudeSignIn.mockResolvedValue({ connected: true });
    mocks.startClaudeSignIn.mockResolvedValue({ url: URL_ });
    mocks.open.mockResolvedValue(true);
    render(<Harness agent="claude" initial={[]} added={view('new', 'Claude')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Claude' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.change(await screen.findByLabelText('Code from Anthropic'), { target: { value: 'abc#def' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
    await screen.findByRole('button', { name: 'Claude' });
    expect(screen.queryByLabelText('Name for Claude')).toBeNull();
  });
});

describe('abandoned sign-in in the accounts list', () => {
  const abandoned = () => vi.mocked(trackEvent).mock.calls.filter(([name]) => name === 'cloud_provider_signin_abandoned');

  async function awaitCode() {
    mocks.startClaudeSignIn.mockResolvedValue({ url: URL_ });
    mocks.open.mockResolvedValue(true);
    startAdding('claude');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByLabelText('Code from Anthropic');
  }

  it('fires once with via cancel', async () => {
    await awaitCode();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    cleanup();
    expect(abandoned()).toHaveLength(1);
    expect(abandoned()[0][1]).toEqual({
      provider: 'selfhosted', agent: 'claude', method: 'claude_oauth', via: 'cancel', elapsed_ms: expect.any(Number),
    });
  });

  it('fires via closed on unmount while awaiting the code', async () => {
    await awaitCode();
    cleanup();
    expect(abandoned()).toHaveLength(1);
    expect(abandoned()[0][1]).toMatchObject({ via: 'closed' });
  });

  it('does not fire after connected', async () => {
    mocks.completeClaudeSignIn.mockResolvedValue({ connected: true });
    await awaitCode();
    fireEvent.change(screen.getByLabelText('Code from Anthropic'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connected', expect.anything()));
    cleanup();
    expect(abandoned()).toHaveLength(0);
  });

  it('sends the API error code on a failed finish and does not report abandonment', async () => {
    const err = Object.assign(new (ApiError as unknown as new (message: string) => Error)('expired'), { code: 'signin_expired' });
    mocks.completeClaudeSignIn.mockRejectedValue(err);
    await awaitCode();
    fireEvent.change(screen.getByLabelText('Code from Anthropic'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
    await screen.findByText('expired');
    cleanup();
    expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connect_failed', expect.objectContaining({ stage: 'finish', error_code: 'signin_expired' }));
    expect(abandoned()).toHaveLength(0);
  });
});
