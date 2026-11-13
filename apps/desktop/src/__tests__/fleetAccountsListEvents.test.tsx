import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FleetAccountView } from '@talyn/shared';
import { trackEvent } from '../renderer/lib/analytics';
import { FleetAccountsList } from '../renderer/components/settings/FleetAccountsList';

const add = jest.fn();
const saveConfig = jest.fn();
const startClaudeSignIn = jest.fn();
const completeClaudeSignIn = jest.fn();
const codexSignIn = jest.fn();
const onChanged = jest.fn();

jest.mock('../renderer/lib/api', () => ({
  ApiError: class extends Error {},
  api: {
    cloudProviders: {
      startClaudeSignIn: (...args: unknown[]) => startClaudeSignIn(...args),
      completeClaudeSignIn: (...args: unknown[]) => completeClaudeSignIn(...args),
      saveConfig: (...args: unknown[]) => saveConfig(...args),
      fleetAccounts: { add: (...args: unknown[]) => add(...args) },
    },
  },
}));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('../renderer/lib/openExternal', () => ({ openExternal: jest.fn().mockResolvedValue(undefined) }));

function renderList(agent: 'claude' | 'codex', accounts: FleetAccountView[] = []) {
  return render(<FleetAccountsList agent={agent} workspaceId="ws1" accounts={accounts} activeId={null}
    switchAtPercent={95} onChanged={onChanged} />);
}

beforeEach(() => {
  onChanged.mockResolvedValue(undefined);
  (window as unknown as { electron: unknown }).electron = { codex: { signIn: codexSignIn } };
});
afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

it('tracks the Codex one-click sign-in start, failure and success', async () => {
  codexSignIn.mockRejectedValueOnce(new Error('user closed the window'));
  renderList('codex');
  fireEvent.click(screen.getByRole('button', { name: 'Connect Codex' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('user closed the window')).toBeInTheDocument();
  expect(trackEvent).toHaveBeenCalledWith('cloud_provider_signin_started', { provider: 'selfhosted', agent: 'codex', method: 'codex_oauth' });
  expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connect_failed', {
    provider: 'selfhosted', agent: 'codex', stage: 'start', error: 'user closed the window',
  });

  codexSignIn.mockResolvedValueOnce({ accessToken: 'a', refreshToken: 'r' });
  saveConfig.mockResolvedValueOnce(undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connected', { provider: 'selfhosted', agent: 'codex' }));
});

it('reports a Codex save failure at the save stage', async () => {
  codexSignIn.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
  saveConfig.mockRejectedValue(new Error('save refused'));
  renderList('codex');
  fireEvent.click(screen.getByRole('button', { name: 'Connect Codex' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByText('save refused');
  expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connect_failed', expect.objectContaining({ stage: 'save', error: 'save refused' }));
});

it('tracks the Claude sign-in start and a failed start', async () => {
  startClaudeSignIn.mockRejectedValue(new Error('backend said no'));
  renderList('claude');
  fireEvent.click(screen.getByRole('button', { name: 'Connect Claude' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByText('backend said no');
  expect(trackEvent).toHaveBeenCalledWith('cloud_provider_signin_started', { provider: 'selfhosted', agent: 'claude', method: 'claude_oauth' });
  expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connect_failed', {
    provider: 'selfhosted', agent: 'claude', stage: 'start', error: 'backend said no',
  });
});

it('reports a failed Claude finish and a connected account once', async () => {
  startClaudeSignIn.mockResolvedValue({ url: 'https://claude.ai/x' });
  completeClaudeSignIn.mockRejectedValueOnce(new Error('bad code')).mockResolvedValueOnce(undefined);
  renderList('claude');
  fireEvent.click(screen.getByRole('button', { name: 'Connect Claude' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  fireEvent.change(await screen.findByLabelText('Code from Anthropic'), { target: { value: 'abc' } });
  fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
  await screen.findByText('bad code');
  expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connect_failed', expect.objectContaining({ stage: 'finish' }));

  fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect((trackEvent as jest.Mock).mock.calls.filter(([name]) => name === 'cloud_provider_connected')).toHaveLength(1);
});

it.each([
  ['claude', 'Claude API key', 'claude_api_key'],
  ['codex', 'Codex API key', 'codex_api_key'],
] as const)('tracks the %s API key save failure', async (agent, label, method) => {
  add.mockRejectedValue(new Error('x'.repeat(300)));
  renderList(agent);
  fireEvent.click(screen.getByRole('button', { name: `Connect ${agent === 'claude' ? 'Claude' : 'Codex'}` }));
  fireEvent.click(screen.getByRole('button', { name: 'Paste an API key' }));
  fireEvent.change(screen.getByLabelText(label), { target: { value: 'sk-x' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
  await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('cloud_provider_connect_failed', {
    provider: 'selfhosted', agent, stage: 'save', error: 'x'.repeat(200),
  }));
  expect(trackEvent).toHaveBeenCalledWith('cloud_provider_signin_started', { provider: 'selfhosted', agent, method });
});
