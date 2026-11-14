import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { trackEvent } from '../renderer/lib/analytics';
import { FleetAgentRow } from '../renderer/components/settings/providerCards';

const saveConfig = jest.fn();
const startClaudeSignIn = jest.fn();

jest.mock('../renderer/lib/api', () => ({
  ApiError: class extends Error {},
  api: {
    cloudProviders: {
      saveConfig: (...args: unknown[]) => saveConfig(...args),
      startClaudeSignIn: (...args: unknown[]) => startClaudeSignIn(...args),
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
    })
  );
  expect(trackEvent).toHaveBeenCalledWith('cloud_provider_signin_started', {
    provider: 'selfhosted',
    agent: 'claude',
    method: 'claude_api_key',
  });
});
