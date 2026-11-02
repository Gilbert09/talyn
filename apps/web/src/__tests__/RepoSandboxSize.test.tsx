import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ApiError } from '@talyn/client';
import { RepoSandboxSize } from '../components/widgets/RepoSandboxSize';
import { useBillingStore } from '../stores/billing';
import { oldStatus, usageStatus } from './usageBillingFixtures';

const { get, set } = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('@talyn/client')>('@talyn/client');
  return { ...actual, api: { repositories: { sandboxSize: { get, set } }, billing: { status: vi.fn(() => new Promise(() => {})) } } };
});
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../stores/toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const auto = { setting: 'auto', effective: 'large', detected: { size: 'large', reason: 'compose.yml runs kafka.', sha: 's', at: 't' } };

describe('RepoSandboxSize', () => {
  beforeEach(() => {
    get.mockReset();
    set.mockReset();
    useBillingStore.setState({ status: null, upgradeModalOpen: false, upgradeReason: null, upgradeNotice: null });
  });
  afterEach(cleanup);

  it('shows all five sizes with hints and the detected answer for Auto', async () => {
    get.mockResolvedValue(auto);
    render(<RepoSandboxSize repositoryId="r1" />);
    expect(await screen.findByLabelText('Sandbox size')).toHaveValue('auto');
    expect(screen.getByRole('option', { name: 'Auto' })).toBeTruthy();
    expect([...screen.getAllByRole('option')].map((option) => [option.getAttribute('value'), option.textContent])).toEqual([
      ['auto', 'Auto'],
      ['small', 'Small · 2 vCPU — Docs, scripts and unattended runs'],
      ['standard', 'Standard · 4 GB — Most repos'],
      ['medium', 'Medium · 8 GB — Big builds, one database'],
      ['large', 'Large · 12 GB — Full test stacks'],
      ['xlarge', 'X-Large · 16 GB — The heaviest stacks'],
    ]);
    expect(screen.getByText(/Auto picks Large · 12 GB: compose.yml runs kafka\./)).toBeTruthy();
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

  it('keeps the old options on a backend without usage billing', async () => {
    useBillingStore.setState({ status: oldStatus() });
    get.mockResolvedValue(auto);
    render(<RepoSandboxSize repositoryId="r1" />);
    await screen.findByLabelText('Sandbox size');
    expect(screen.getByRole('option', { name: 'Large · 12 GB — Full test stacks' })).not.toBeDisabled();
    expect(document.querySelector('[data-attr="sandbox-size-price"]')).toBeNull();
  });

  it.each([
    ['free', ['small', 'standard'], ['medium', 'large', 'xlarge']],
    ['pro', ['small', 'standard', 'medium', 'large', 'xlarge'], []],
    ['legacy_pro', ['small', 'standard', 'medium', 'large', 'xlarge'], []],
  ] as const)('on %s shows each price and weight and locks sizes above the plan', async (tier, open, locked) => {
    useBillingStore.setState({ status: usageStatus(tier) });
    get.mockResolvedValue({ setting: 'standard', effective: 'standard', detected: null });
    render(<RepoSandboxSize repositoryId="r1" />);
    await screen.findByLabelText('Sandbox size');
    for (const size of open) {
      const option = document.querySelector(`option[value="${size}"]`) as HTMLOptionElement;
      expect(option.disabled).toBe(false);
      expect(option.textContent).toMatch(/box-hours?\/h · \$0\.\d+\/h$/);
    }
    for (const size of locked) {
      const option = document.querySelector(`option[value="${size}"]`) as HTMLOptionElement;
      expect(option.disabled).toBe(true);
      expect(option.textContent).toMatch(/ · Pro$/);
    }
    expect(screen.getByText('Standard · 4 GB uses 1 box-hour per running hour, then $0.22/h from credits.')).toBeTruthy();
  });

  it('says a size the plan cannot start needs Pro', async () => {
    useBillingStore.setState({ status: usageStatus('free') });
    get.mockResolvedValue(auto);
    render(<RepoSandboxSize repositoryId="r1" />);
    expect(await screen.findByText(/Large boxes need Pro/)).toBeTruthy();
  });

  it('opens the plan modal when saving a size the plan refuses', async () => {
    useBillingStore.setState({ status: usageStatus('pro') });
    get.mockResolvedValue({ setting: 'standard', effective: 'standard', detected: null });
    set.mockRejectedValue(new ApiError('Large boxes need the Pro plan.', 402, 'size_requires_pro', { notice: { size: 'large' } }));
    render(<RepoSandboxSize repositoryId="r1" />);
    fireEvent.change(await screen.findByLabelText('Sandbox size'), { target: { value: 'large' } });
    await waitFor(() => expect(useBillingStore.getState().upgradeReason).toBe('size_requires_pro'));
  });
});
