import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  startClaudeSignIn: vi.fn(),
  completeClaudeSignIn: vi.fn(),
  saveConfig: vi.fn(),
  list: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  prepareSignInWindow: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      cloudProviders: {
        ...actual.api.cloudProviders,
        startClaudeSignIn: mocks.startClaudeSignIn,
        completeClaudeSignIn: mocks.completeClaudeSignIn,
        saveConfig: mocks.saveConfig,
        list: mocks.list,
      },
    },
  };
});
vi.mock('../lib/openExternal', () => ({
  openExternal: vi.fn(),
  isOpenInBrowserClick: () => false,
  prepareSignInWindow: mocks.prepareSignInWindow,
}));
vi.mock('../lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/analytics')>()),
  trackEvent: vi.fn(),
}));

const { trackEvent } = await import('../lib/analytics');
const { useWorkspaceStore } = await import('../stores/workspace');
const { FleetAgentRow } = await import('../components/panels/SettingsPanel');

const SIGN_IN_URL = 'https://claude.ai/oauth/authorize?x=1';

function renderRow(agent: 'claude' | 'codex') {
  return render(<FleetAgentRow agent={agent} connected={false} needsReauth={false} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
  mocks.prepareSignInWindow.mockReturnValue({ open: mocks.open, close: mocks.close });
  mocks.list.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
});

describe('Claude sign-in on the web', () => {
  it('reserves the tab before the API call and opens the sign-in page in it', async () => {
    let reservedFirst = false;
    mocks.startClaudeSignIn.mockImplementation(async () => {
      reservedFirst = mocks.prepareSignInWindow.mock.calls.length === 1;
      return { url: SIGN_IN_URL };
    });
    mocks.open.mockResolvedValue(true);
    renderRow('claude');

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }));

    await screen.findByText(/paste the code Anthropic shows you/);
    expect(reservedFirst).toBe(true);
    expect(mocks.open).toHaveBeenCalledWith(SIGN_IN_URL);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Open the Claude sign-in page' })).toBeNull();
    expect(trackEvent).toHaveBeenCalledWith('cloud_provider_signin_started', {
      provider: 'selfhosted',
      agent: 'claude',
      method: 'claude_oauth',
    });
  });

  it('shows a link to the sign-in page when the browser blocked the tab', async () => {
    mocks.startClaudeSignIn.mockResolvedValue({ url: SIGN_IN_URL });
    mocks.open.mockResolvedValue(false);
    renderRow('claude');

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }));

    const link = await screen.findByRole('link', { name: 'Open the Claude sign-in page' });
    expect(link.getAttribute('href')).toBe(SIGN_IN_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.getByText('Code from Anthropic')).toBeTruthy();
  });

  it('closes the reserved tab and reports the failure when the start fails', async () => {
    mocks.startClaudeSignIn.mockRejectedValue(new Error('backend said no'));
    renderRow('claude');

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }));

    await screen.findByText('backend said no');
    expect(mocks.close).toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connect_failed', {
      provider: 'selfhosted',
      agent: 'claude',
      stage: 'start',
      error: 'backend said no',
    });
  });

  it('reports a failed finish', async () => {
    mocks.startClaudeSignIn.mockResolvedValue({ url: SIGN_IN_URL });
    mocks.open.mockResolvedValue(true);
    mocks.completeClaudeSignIn.mockRejectedValue(new Error('bad code'));
    renderRow('claude');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }));
    await screen.findByText('Code from Anthropic');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));

    await screen.findByText('bad code');
    expect(trackEvent).toHaveBeenCalledWith(
      'cloud_provider_connect_failed',
      expect.objectContaining({ agent: 'claude', stage: 'finish', error: 'bad code' })
    );
  });
});

describe('Anthropic API key', () => {
  it('has a visible summary and tracks the save as a sign-in start', async () => {
    mocks.saveConfig.mockResolvedValue({});
    renderRow('claude');
    fireEvent.click(screen.getByText('No Claude subscription? Use an Anthropic API key'));
    fireEvent.change(screen.getByPlaceholderText('sk-ant-api…'), { target: { value: 'sk-ant-api-x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & verify' }));

    await waitFor(() => expect(mocks.saveConfig).toHaveBeenCalledWith('selfhosted', 'ws1', { claudeToken: 'sk-ant-api-x' }));
    expect(trackEvent).toHaveBeenCalledWith('cloud_provider_signin_started', {
      provider: 'selfhosted',
      agent: 'claude',
      method: 'claude_api_key',
    });
    await waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connected', { provider: 'selfhosted', agent: 'claude' })
    );
  });

  it('truncates a long save error to 200 characters', async () => {
    mocks.saveConfig.mockRejectedValue(new Error('x'.repeat(500)));
    renderRow('claude');
    fireEvent.click(screen.getByText('No Claude subscription? Use an Anthropic API key'));
    fireEvent.change(screen.getByPlaceholderText('sk-ant-api…'), { target: { value: 'sk-ant-api-x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & verify' }));

    await waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connect_failed', {
        provider: 'selfhosted',
        agent: 'claude',
        stage: 'save',
        error: 'x'.repeat(200),
      })
    );
  });
});

describe('Codex paste', () => {
  it.each([
    ['not JSON', 'nope', 'That is not valid JSON. Paste the whole contents of ~/.codex/auth.json.'],
    ['no token pair', '{"tokens":{}}', 'That JSON has no access_token / refresh_token pair. Run `codex login` first.'],
    ['null', 'null', 'That JSON has no access_token / refresh_token pair. Run `codex login` first.'],
  ])('reports a parse failure: %s', async (_name, value, message) => {
    renderRow('codex');
    fireEvent.change(screen.getByRole('textbox'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & verify' }));

    expect(await screen.findByText(message)).toBeTruthy();
    expect(trackEvent).toHaveBeenCalledWith('cloud_provider_signin_started', {
      provider: 'selfhosted',
      agent: 'codex',
      method: 'codex_paste',
    });
    expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connect_failed', {
      provider: 'selfhosted',
      agent: 'codex',
      stage: 'parse',
      error: message,
    });
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });
});
