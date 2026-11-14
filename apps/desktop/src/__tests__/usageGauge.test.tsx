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
import { trackEvent } from '../renderer/lib/analytics';
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

  it('shows the remaining share, reset date and Upgrade on Free', () => {
    useBillingStore.setState({ status: usageStatus('free', { usedHours: 3.75 }) });
    renderGauge();
    expect(screen.queryByText('Agents')).toBeNull();
    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getByText('63% left')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Plan and usage/ })).toHaveAccessibleName(
      expect.stringContaining('63% left (3.7 of 10 box-hours used)'),
    );
    expect(screen.getByText(/^Resets /)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Box-hours left' })).toHaveAttribute('aria-valuenow', '63');
    expect(screen.getByRole('progressbar').firstChild).toHaveStyle({ width: '63%' });
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

  it('shows the credit balance without an action on Pro', () => {
    useBillingStore.setState({ status: usageStatus('pro', { usedHours: 37.5, balanceMicros: 12_500_000 }) });
    renderGauge();
    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('82% left')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Plan and usage/ })).toHaveAccessibleName(
      expect.stringContaining('82% left (37.5 of 200 box-hours used)'),
    );
    expect(screen.getByText('Credits $12.50')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add credits' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upgrade' })).toBeNull();
  });

  it('opens the plan page from Add credits when Pro is nearly out', () => {
    useBillingStore.setState({ status: usageStatus('pro', { usedHours: 191 }) });
    renderGauge();
    fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    expect(mockOpenSettings).toHaveBeenCalledWith('billing');
    expect(trackEvent).toHaveBeenCalledWith('add_credits_clicked', { where: 'sidebar' });
  });

  it.each([
    ['nearly out', 198, false],
    ['out', 200, true],
  ])('hides Add credits when Pro is %s but has credits left', (_label, usedHours, exhausted) => {
    useBillingStore.setState({ status: usageStatus('pro', { usedHours, exhausted, balanceMicros: 100_000_000 }) });
    renderGauge();
    expect(screen.getByText('Credits $100')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add credits' })).toBeNull();
  });

  it.each([
    [10, 'Upgrade'],
    [48, 'Add credits'],
  ])('Legacy Pro at %i of 50 box-hours offers %s', (usedHours, label) => {
    useBillingStore.setState({ status: usageStatus('legacy_pro', { usedHours }) });
    renderGauge();
    expect(screen.getByText('Legacy Pro')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
  });

  it('turns into a credit bar once the included hours are used up', () => {
    useBillingStore.setState({
      status: usageStatus('pro', { usedHours: 230, balanceMicros: 93_840_000, drawStartMicros: 120_000_000 }),
    });
    renderGauge();
    expect(screen.getByText('Using credits · $93.84 left')).toBeInTheDocument();
    expect(screen.queryByText('0% left')).toBeNull();
    expect(screen.queryByText(/^Credits/)).toBeNull();
    const bar = screen.getByRole('progressbar', { name: 'Credit left' });
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeCloseTo(78.2);
    expect(bar.firstChild).toHaveStyle({ width: '78.2%' });
    expect(bar.firstChild).toHaveClass('bg-sky-500');
    expect(screen.getByRole('button', { name: /Plan and usage/ })).toHaveAccessibleName(
      expect.stringContaining('Included hours used up. Using credits: $93.84 of $120 left'),
    );
  });

  it.each([
    ['refills to a full bar after a top-up', 125_000_000, 125_000_000, '100', 'bg-sky-500'],
    ['reads an old backend without a start as full', 40_000_000, undefined, '100', 'bg-sky-500'],
    ['colours a low credit bar orange', 10_000_000, 100_000_000, '10', 'bg-orange-500'],
  ])('%s', (_label, balanceMicros, drawStartMicros, valueNow, barClass) => {
    useBillingStore.setState({ status: usageStatus('pro', { usedHours: 230, balanceMicros, drawStartMicros }) });
    renderGauge();
    const bar = screen.getByRole('progressbar', { name: 'Credit left' });
    expect(bar).toHaveAttribute('aria-valuenow', valueNow);
    expect(bar.firstChild).toHaveClass(barClass);
  });

  it('draws the credit draw in the collapsed ring', () => {
    useBillingStore.setState({
      status: usageStatus('pro', { usedHours: 230, balanceMicros: 50_000_000, drawStartMicros: 100_000_000 }),
    });
    renderGauge(true);
    const ring = screen.getByRole('button', { name: /Pro plan/ });
    expect(ring).toHaveAccessibleName(expect.stringContaining('Included hours used up. Using credits: $50 of $100 left'));
    const stroke = ring.querySelectorAll('circle')[1];
    expect(stroke).toHaveClass('stroke-sky-500');
    expect(Number(stroke.getAttribute('stroke-dasharray')?.split(' ')[0])).toBeCloseTo(2 * Math.PI * 6 * 0.5);
  });

  it('says so plainly when the hours are gone', () => {
    useBillingStore.setState({ status: usageStatus('free', { usedHours: 10, exhausted: true }) });
    renderGauge();
    expect(screen.getByText('Out of hours: new boxes paused')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByRole('progressbar').firstChild).toHaveStyle({ width: '0%' });
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(useBillingStore.getState().upgradeReason).toBe('usage_exhausted');
  });

  it('opens the plan page from the gauge itself', () => {
    useBillingStore.setState({ status: usageStatus('free') });
    renderGauge();
    fireEvent.click(screen.getByRole('button', { name: /^Plan and usage/ }));
    expect(mockOpenSettings).toHaveBeenCalledWith('billing');
  });

  it('opens Agents from an agent reconnect warning', () => {
    mockProviders = [fleet({ connectedAgents: ['claude', 'codex'], reauthAgents: ['claude'] })];
    useBillingStore.setState({ status: usageStatus('pro') });
    renderGauge();
    fireEvent.click(screen.getByRole('button', { name: 'Claude needs reconnecting' }));
    expect(mockOpenSettings).toHaveBeenCalledWith('agents');
  });

  it('opens Agents from a PostHog Code reconnect warning', () => {
    mockProviders = [fleet(), { type: 'posthog_code', displayName: 'PostHog Code', connected: true, needsReconnect: true }];
    useBillingStore.setState({ status: usageStatus('pro') });
    renderGauge();
    fireEvent.click(screen.getByRole('button', { name: 'PostHog Code needs reconnecting' }));
    expect(mockOpenSettings).toHaveBeenCalledWith('agents');
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
    expect(ring).toHaveAccessibleName(expect.stringContaining('82% left (37.5 of 200 box-hours used)'));
    const stroke = ring.querySelectorAll('circle')[1];
    expect(Number(stroke.getAttribute('stroke-dasharray')?.split(' ')[0])).toBeCloseTo(2 * Math.PI * 6 * 0.82);
    expect(ring).toHaveAccessibleName(expect.stringContaining('Credits $5'));
    expect(ring).toHaveAccessibleName(expect.stringContaining('Claude needs reconnecting'));
    expect(screen.queryByRole('progressbar')).toBeNull();
    fireEvent.click(ring);
    expect(mockOpenSettings).toHaveBeenCalledWith('billing');
  });

  it('empties the collapsed ring when exhausted', () => {
    useBillingStore.setState({ status: usageStatus('free', { usedHours: 10, exhausted: true }) });
    renderGauge(true);
    const ring = screen.getByRole('button', { name: /Free plan/ });
    expect(ring).toHaveAccessibleName(expect.stringContaining('0% left (10 of 10 box-hours used)'));
    expect(ring.querySelectorAll('circle')[1]).toHaveAttribute('stroke-dasharray', `0 ${2 * Math.PI * 6}`);
  });
});
