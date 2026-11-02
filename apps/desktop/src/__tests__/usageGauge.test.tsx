/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CloudProviderInfo } from '@talyn/client';
import { SidebarAccountStatus } from '../renderer/components/layout/UsageGauge';
import { TooltipProvider } from '../renderer/components/ui/tooltip';
import { useBillingStore } from '../renderer/stores/billing';
import { oldStatus, usageStatus } from '../testing/billingStatus';

let mockProviders: CloudProviderInfo[] = [];
const mockOpenSettings = jest.fn();
jest.mock('../renderer/stores/workspace', () => {
  const state = () => ({
    cloudProviders: mockProviders,
    posthogStatus: { needsReauth: false },
    openSettings: mockOpenSettings,
  });
  const useWorkspaceStore = (selector: (s: unknown) => unknown) => selector(state());
  useWorkspaceStore.getState = state;
  return { useWorkspaceStore };
});
jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));

const fleet = (over: Partial<CloudProviderInfo> = {}): CloudProviderInfo => ({
  type: 'selfhosted',
  displayName: 'Talyn Fleet',
  connected: true,
  connectedAgents: ['claude'],
  ...over,
});

function renderGauge(collapsed = false) {
  return render(
    <TooltipProvider>
      <SidebarAccountStatus collapsed={collapsed} />
    </TooltipProvider>,
  );
}

describe('SidebarAccountStatus', () => {
  beforeEach(() => {
    mockProviders = [fleet()];
    mockOpenSettings.mockReset();
    useBillingStore.setState({ status: null, upgradeModalOpen: false, upgradeReason: null, upgradeNotice: null });
  });
  afterEach(cleanup);

  it.each([
    ['no status yet', null],
    ['an older backend', oldStatus()],
    ['an old Unlimited plan', oldStatus({ plan: 'unlimited', activeTaskLimit: null })],
    ['billing turned off', usageStatus('pro', { overrides: { billingEnabled: false } })],
  ])('keeps the old Agents box with %s', (_label, status) => {
    useBillingStore.setState({ status });
    renderGauge();
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Talyn Fleet')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('shows tier, box-hours, reset date and Upgrade on Free', () => {
    useBillingStore.setState({ status: usageStatus('free', { usedHours: 3.75 }) });
    renderGauge();
    expect(screen.queryByText('Agents')).toBeNull();
    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getByText('3.7 of 10 box-hours')).toBeInTheDocument();
    expect(screen.getByText(/^Resets /)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '37');
    expect(screen.queryByText(/^Credits/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(useBillingStore.getState().upgradeModalOpen).toBe(true);
    expect(mockOpenSettings).not.toHaveBeenCalled();
  });

  it.each([
    ['ok', 10, 'bg-primary'],
    ['notice', 100, 'bg-amber-500'],
    ['warning', 170, 'bg-orange-500'],
    ['danger', 200, 'bg-destructive'],
  ])('colours the bar %s at %i of 200', (_tone, usedHours, cls) => {
    useBillingStore.setState({ status: usageStatus('pro', { usedHours }) });
    renderGauge();
    expect(screen.getByRole('progressbar').firstChild).toHaveClass(cls);
  });

  it('shows the credit balance and Add credits on Pro, and the action opens the plan page', () => {
    useBillingStore.setState({ status: usageStatus('pro', { usedHours: 37.5, balanceMicros: 12_500_000 }) });
    renderGauge();
    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('37.5 of 200 box-hours')).toBeInTheDocument();
    expect(screen.getByText('Credits $12.50')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    expect(mockOpenSettings).toHaveBeenCalledWith('billing');
  });

  it.each([
    [10, 'Upgrade'],
    [45, 'Add credits'],
  ])('Legacy Pro at %i of 50 box-hours offers %s', (usedHours, label) => {
    useBillingStore.setState({ status: usageStatus('legacy_pro', { usedHours }) });
    renderGauge();
    expect(screen.getByText('Legacy Pro')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
  });

  it('says so plainly when the hours are gone', () => {
    useBillingStore.setState({ status: usageStatus('free', { usedHours: 10, exhausted: true }) });
    renderGauge();
    expect(screen.getByText('Out of hours: new boxes paused')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(useBillingStore.getState().upgradeReason).toBe('usage_exhausted');
  });

  it('opens the plan page from the gauge itself', () => {
    useBillingStore.setState({ status: usageStatus('free') });
    renderGauge();
    fireEvent.click(screen.getByRole('button', { name: /^Plan and usage/ }));
    expect(mockOpenSettings).toHaveBeenCalledWith('billing');
  });

  it('keeps an agent that needs reconnecting visible, and opens integrations', () => {
    mockProviders = [fleet({ connectedAgents: ['claude', 'codex'], reauthAgents: ['claude'] })];
    useBillingStore.setState({ status: usageStatus('pro') });
    renderGauge();
    fireEvent.click(screen.getByRole('button', { name: 'Claude needs reconnecting' }));
    expect(mockOpenSettings).toHaveBeenCalledWith('integrations');
  });

  it('lists no healthy agents', () => {
    useBillingStore.setState({ status: usageStatus('pro') });
    renderGauge();
    expect(screen.queryByText(/needs reconnecting/)).toBeNull();
    expect(screen.queryByText('Talyn Fleet')).toBeNull();
  });

  it('collapses to a ring that carries the data in its label', () => {
    mockProviders = [fleet({ reauthAgents: ['claude'] })];
    useBillingStore.setState({ status: usageStatus('pro', { usedHours: 37.5, balanceMicros: 5_000_000 }) });
    renderGauge(true);
    const ring = screen.getByRole('button', { name: /Pro plan/ });
    expect(ring).toHaveAccessibleName(expect.stringContaining('37.5 of 200 box-hours'));
    expect(ring).toHaveAccessibleName(expect.stringContaining('Credits $5.00'));
    expect(ring).toHaveAccessibleName(expect.stringContaining('Claude needs reconnecting'));
    expect(screen.queryByRole('progressbar')).toBeNull();
    fireEvent.click(ring);
    expect(mockOpenSettings).toHaveBeenCalledWith('billing');
  });
});
