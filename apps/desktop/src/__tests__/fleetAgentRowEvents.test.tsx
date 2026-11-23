import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { trackEvent } from '../renderer/lib/analytics';
import { ApiError } from '../renderer/lib/api';
import { FleetAgentRow } from '../renderer/components/settings/providerCards';

const saveConfig = jest.fn();
const startClaudeSignIn = jest.fn();
const completeClaudeSignIn = jest.fn();

jest.mock('../renderer/lib/api', () => ({
  ApiError: class extends Error {},
  api: {
    cloudProviders: {
      saveConfig: (...args: unknown[]) => saveConfig(...args),
      startClaudeSignIn: (...args: unknown[]) => startClaudeSignIn(...args),
      completeClaudeSignIn: (...args: unknown[]) => completeClaudeSignIn(...args),
      list: jest.fn().mockResolvedValue([]),
    },
  },
}));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('../renderer/lib/openExternal', () => ({ openExternal: jest.fn() }));
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({ currentWorkspaceId: 'ws1', setCloudProviders: jest.fn() }),
}));

const codexSignIn = jest.fn();

beforeEach(() => {
  (window as unknown as { electron: unknown }).electron = { codex: { signIn: codexSignIn } };
});
afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

it('tracks the one-click ChatGPT sign-in and its failure', async () => {
  codexSignIn.mockRejectedValue(new Error('user closed the window'));
  render(<FleetAgentRow agent="codex" connected={false} needsReauth={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }));

  expect(await screen.findByText(/user closed the window/)).toBeInTheDocument();
  expect(trackEvent).toHaveBeenCalledWith('cloud_provider_signin_started', {
    provider: 'selfhosted',
    agent: 'codex',
    method: 'codex_oauth',
  });
  expect(trackEvent).toHaveBeenCalledWith(
    'cloud_provider_connect_failed',
    expect.objectContaining({ provider: 'selfhosted', agent: 'codex', stage: 'start' })
  );
});

it('tracks the Claude sign-in start and a failed start', async () => {
  startClaudeSignIn.mockRejectedValue(new Error('backend said no'));
  render(<FleetAgentRow agent="claude" connected={false} needsReauth={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }));

  expect(await screen.findByText('backend said no')).toBeInTheDocument();
  expect(trackEvent).toHaveBeenCalledWith('cloud_provider_signin_started', {
    provider: 'selfhosted',
    agent: 'claude',
    method: 'claude_oauth',
  });
  expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connect_failed', {
    provider: 'selfhosted',
    agent: 'claude',
    stage: 'start',
    error: 'backend said no',
    error_code: null,
  });
});

it('shows the API key option and tracks a failed save', async () => {
  saveConfig.mockRejectedValue(new Error('invalid key'));
  render(<FleetAgentRow agent="claude" connected={false} needsReauth={false} />);
  fireEvent.click(screen.getByText('No Claude subscription? Use an Anthropic API key'));
  fireEvent.change(screen.getByPlaceholderText('sk-ant-api…'), { target: { value: 'sk-ant-api-x' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save & verify' }));

  await waitFor(() =>
    expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connect_failed', {
      provider: 'selfhosted',
      agent: 'claude',
      stage: 'save',
      error: 'invalid key',
      error_code: null,
    })
  );
  expect(trackEvent).toHaveBeenCalledWith('cloud_provider_signin_started', {
    provider: 'selfhosted',
    agent: 'claude',
    method: 'claude_api_key',
  });
});

describe('abandoned sign-in', () => {
  const abandoned = () => (trackEvent as jest.Mock).mock.calls.filter(([name]) => name === 'cloud_provider_signin_abandoned');

  async function awaitCode() {
    startClaudeSignIn.mockResolvedValue({ url: 'https://claude.ai/x' });
    const view = render(<FleetAgentRow agent="claude" connected={false} needsReauth={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }));
    await screen.findByText('Code from Anthropic');
    return view;
  }

  it('fires once with via back, then not again on unmount', async () => {
    const view = await awaitCode();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    view.unmount();
    expect(abandoned()).toHaveLength(1);
    expect(abandoned()[0][1]).toEqual({
      provider: 'selfhosted',
      agent: 'claude',
      method: 'claude_oauth',
      via: 'back',
      elapsed_ms: expect.any(Number),
    });
  });

  it('fires via closed when unmounted while awaiting the code', async () => {
    const view = await awaitCode();
    view.unmount();
    expect(abandoned()).toHaveLength(1);
    expect(abandoned()[0][1]).toMatchObject({ via: 'closed' });
  });

  it('does not fire after connected', async () => {
    completeClaudeSignIn.mockResolvedValue({ connected: true });
    const view = await awaitCode();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connected', expect.anything()));
    view.unmount();
    expect(abandoned()).toHaveLength(0);
  });

  it('puts the API error code on a failed finish and does not fire', async () => {
    completeClaudeSignIn.mockRejectedValue(Object.assign(new ApiError('expired', 400), { code: 'signin_expired' }));
    const view = await awaitCode();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
    await screen.findByText('expired');
    view.unmount();
    expect(trackEvent).toHaveBeenCalledWith(
      'cloud_provider_connect_failed',
      expect.objectContaining({ stage: 'finish', error_code: 'signin_expired' })
    );
    expect(abandoned()).toHaveLength(0);
  });

  it('reports a ChatGPT sign-in timeout as abandoned, not failed', async () => {
    codexSignIn.mockRejectedValue(new Error("Error invoking remote method 'codex:signIn': Error: Timed out waiting for the ChatGPT sign-in to finish."));
    render(<FleetAgentRow agent="codex" connected={false} needsReauth={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }));
    await waitFor(() => expect(abandoned()).toHaveLength(1));
    expect(abandoned()[0][1]).toMatchObject({ agent: 'codex', method: 'codex_oauth', via: 'timeout' });
    expect(trackEvent).not.toHaveBeenCalledWith('cloud_provider_connect_failed', expect.anything());
    cleanup();
    expect(abandoned()).toHaveLength(1);
  });
});
