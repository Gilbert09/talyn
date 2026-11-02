import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { RepoSandboxSize } from '../renderer/components/widgets/RepoSandboxSize';
import { useBillingStore } from '../renderer/stores/billing';
import { oldStatus, usageStatus } from '../testing/billingStatus';

const get = jest.fn();
const set = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: { repositories: { sandboxSize: { get: (...a: unknown[]) => get(...a), set: (...a: unknown[]) => set(...a) } } },
  ApiError: class ApiError extends Error {},
}));
jest.mock('../renderer/stores/toast', () => ({ toast: { error: jest.fn(), success: jest.fn(), info: jest.fn() } }));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));

const auto = { setting: 'auto', effective: 'large', detected: { size: 'large', reason: 'compose.yml runs kafka.', sha: 's', at: 't' } };

function options() {
  return [...screen.getAllByRole('option')].map((option) => [
    option.getAttribute('value'),
    option.textContent,
    (option as HTMLOptionElement).disabled,
  ]);
}

describe('RepoSandboxSize', () => {
  beforeEach(() => {
    get.mockReset();
    set.mockReset();
    useBillingStore.setState({ status: null, upgradeModalOpen: false, upgradeReason: null });
  });
  afterEach(cleanup);

  it.each([
    ['no billing status', null],
    ['an older backend', oldStatus()],
  ])('shows all five sizes with hints and the detected answer for Auto with %s', async (_label, status) => {
    useBillingStore.setState({ status });
    get.mockResolvedValue(auto);
    render(<RepoSandboxSize repositoryId="r1" />);
    expect(await screen.findByLabelText('Sandbox size')).toHaveValue('auto');
    expect(options()).toEqual([
      ['auto', 'Auto', false],
      ['small', 'Small · 2 vCPU — Docs, scripts and unattended runs', false],
      ['standard', 'Standard · 4 GB — Most repos', false],
      ['medium', 'Medium · 8 GB — Big builds, one database', false],
      ['large', 'Large · 12 GB — Full test stacks', false],
      ['xlarge', 'X-Large · 16 GB — The heaviest stacks', false],
    ]);
    expect(screen.getByText(/Auto picks Large · 12 GB: compose.yml runs kafka\./)).toBeTruthy();
    expect(screen.queryByText(/need Pro/)).toBeNull();
  });

  it('shows prices and locks the larger sizes on Free', async () => {
    useBillingStore.setState({ status: usageStatus('free') });
    get.mockResolvedValue({ ...auto, setting: 'standard', effective: 'standard' });
    render(<RepoSandboxSize repositoryId="r1" />);
    await screen.findByLabelText('Sandbox size');
    expect(options()).toEqual([
      ['auto', 'Auto', false],
      ['small', 'Small · 2 vCPU: $0.11/h, 0.5x box-hours', false],
      ['standard', 'Standard · 4 GB: $0.22/h, 1x box-hours', false],
      ['medium', 'Medium · 8 GB (Pro)', true],
      ['large', 'Large · 12 GB (Pro)', true],
      ['xlarge', 'X-Large · 16 GB (Pro)', true],
    ]);
    expect(screen.getByText('Free runs small and standard boxes. Larger sizes need Pro.')).toBeTruthy();
  });

  it.each(['pro', 'legacy_pro'] as const)('unlocks every size on %s', async (tier) => {
    useBillingStore.setState({ status: usageStatus(tier) });
    get.mockResolvedValue({ ...auto, setting: 'large', effective: 'large' });
    render(<RepoSandboxSize repositoryId="r1" />);
    await screen.findByLabelText('Sandbox size');
    expect(options().every(([, , disabled]) => disabled === false)).toBe(true);
    expect(screen.getByRole('option', { name: 'Large · 12 GB: $0.44/h, 2x box-hours' })).toBeTruthy();
    expect(screen.queryByText(/need Pro/)).toBeNull();
  });

  it('keeps a locked size the repository already uses selectable, and offers the upgrade', async () => {
    useBillingStore.setState({ status: usageStatus('free') });
    get.mockResolvedValue({ ...auto, setting: 'large', effective: 'large' });
    render(<RepoSandboxSize repositoryId="r1" />);
    expect(await screen.findByLabelText('Sandbox size')).toHaveValue('large');
    expect((screen.getByRole('option', { name: 'Large · 12 GB (Pro)' }) as HTMLOptionElement).disabled).toBe(false);
    expect((screen.getByRole('option', { name: 'Medium · 8 GB (Pro)' }) as HTMLOptionElement).disabled).toBe(true);
    expect(screen.getByText(/Large · 12 GB boxes need Pro, so a new session here cannot start/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'upgrade to Pro' }));
    expect(useBillingStore.getState().upgradeModalOpen).toBe(true);
    expect(useBillingStore.getState().upgradeReason).toBe('size_requires_pro');
  });

  it('warns when Auto picks a size the plan cannot start', async () => {
    useBillingStore.setState({ status: usageStatus('free') });
    get.mockResolvedValue(auto);
    render(<RepoSandboxSize repositoryId="r1" />);
    await screen.findByLabelText('Sandbox size');
    expect(screen.getByText(/Large · 12 GB boxes need Pro/)).toBeTruthy();
  });

  it('saves a choice and drops the Auto hint', async () => {
    get.mockResolvedValue(auto);
    set.mockResolvedValue({ ...auto, setting: 'standard', effective: 'standard' });
    render(<RepoSandboxSize repositoryId="r1" />);
    fireEvent.change(await screen.findByLabelText('Sandbox size'), { target: { value: 'standard' } });
    await waitFor(() => expect(set).toHaveBeenCalledWith('r1', 'standard'));
    await waitFor(() => expect(screen.getByLabelText('Sandbox size')).toHaveValue('standard'));
    expect(screen.queryByText(/Auto picks/)).toBeNull();
  });

  it('renders nothing when the account has no sessions', async () => {
    get.mockRejectedValue(new Error('403'));
    const { container } = render(<RepoSandboxSize repositoryId="r1" />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});
