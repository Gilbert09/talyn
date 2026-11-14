import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { FleetAccountView } from '@talyn/shared';

const mocks = vi.hoisted(() => ({
  startClaudeSignIn: vi.fn(),
  completeClaudeSignIn: vi.fn(),
  saveConfig: vi.fn(),
  add: vi.fn(),
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
      fleetAccounts: { add: mocks.add },
    },
  },
}));
vi.mock('../lib/openExternal', () => ({
  openExternal: vi.fn(),
  prepareSignInWindow: mocks.prepareSignInWindow,
}));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));

const { trackEvent } = await import('../lib/analytics');
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
      provider: 'selfhosted', agent: 'claude', stage: 'start', error: 'backend said no',
    });
  });

  it('reports a failed finish and a successful one', async () => {
    mocks.startClaudeSignIn.mockResolvedValue({ url: URL_ });
    mocks.open.mockResolvedValue(true);
    mocks.completeClaudeSignIn.mockRejectedValueOnce(new Error('bad code')).mockResolvedValueOnce(undefined);
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
      provider: 'selfhosted', agent, stage: 'save', error: 'x'.repeat(200),
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
