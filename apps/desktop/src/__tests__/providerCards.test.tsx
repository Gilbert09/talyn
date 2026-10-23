import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '../renderer/lib/api';
import { ProviderConnectCards } from '../renderer/components/settings/providerCards';

const listAccounts = jest.fn();
const setCloudProviders = jest.fn();

jest.mock('../renderer/lib/api', () => ({
  ApiError: class extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
  api: { cloudProviders: { fleetAccounts: { list: (...args: unknown[]) => listAccounts(...args) } } },
}));

jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) => selector({
    currentWorkspaceId: 'ws1',
    cloudProviders: [{ type: 'selfhosted', connectedAgents: [], reauthAgents: [] }],
    setCloudProviders,
    posthogStatus: { connected: false, oauthAvailable: true },
    setPostHogStatus: jest.fn(),
  }),
}));

afterEach(() => { cleanup(); jest.clearAllMocks(); });

it('shows one compact loading row per agent', () => {
  listAccounts.mockReturnValue(new Promise(() => undefined));
  render(<ProviderConnectCards />);
  expect(screen.getByRole('status', { name: 'Loading claude accounts' })).toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'Loading codex accounts' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sign in with Claude' })).not.toBeInTheDocument();
});

it('uses the account list for agents without accounts', async () => {
  listAccounts.mockResolvedValue({ accounts: [], active: { claude: null, codex: null }, switchAtPercent: 95 });
  render(<ProviderConnectCards />);
  expect(await screen.findByRole('button', { name: 'Connect Claude' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Connect Codex' })).toBeInTheDocument();
  expect(screen.getAllByText('Not connected')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Sign in with Claude' })).not.toBeInTheDocument();
});

it('keeps the old connect rows for a 404 response', async () => {
  listAccounts.mockRejectedValue(new ApiError('Not found', 404));
  render(<ProviderConnectCards />);
  expect(await screen.findByText('Accounts need a newer Talyn backend.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sign in with Claude' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeInTheDocument();
});

it('retries other account errors', async () => {
  listAccounts.mockRejectedValueOnce(new ApiError('Server error', 500))
    .mockResolvedValueOnce({ accounts: [], active: { claude: null, codex: null }, switchAtPercent: 95 });
  render(<ProviderConnectCards />);
  expect(await screen.findByText('Could not load accounts.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sign in with Claude' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(listAccounts).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole('button', { name: 'Connect Claude' })).toBeInTheDocument();
});
