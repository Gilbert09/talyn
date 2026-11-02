import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { CloudProviderInfo } from '@talyn/client';
import type { BillingStatus } from '@talyn/shared';
import { SidebarUsageSlot, agentWarnings } from '../components/layout/UsageGauge';
import { useBillingStore } from '../stores/billing';
import { useWorkspaceStore } from '../stores/workspace';
import { oldStatus, usageStatus } from './usageBillingFixtures';

vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));

const FLEET: CloudProviderInfo = { type: 'selfhosted', displayName: 'Talyn Fleet', connected: true, connectedAgents: ['claude'] };
const POSTHOG: CloudProviderInfo = { type: 'posthog_code', displayName: 'PostHog Code', connected: false };

const openSettings = vi.fn();

function setup(status: BillingStatus | null, providers: CloudProviderInfo[] = [FLEET, POSTHOG]) {
  useBillingStore.setState({ status, upgradeModalOpen: false, upgradeReason: null, upgradeNotice: null });
  useWorkspaceStore.setState({ cloudProviders: providers, posthogStatus: null, openSettings } as never);
}

describe('SidebarUsageSlot', () => {
  beforeEach(() => openSettings.mockReset());
  afterEach(cleanup);

  it.each([
    ['no status yet', null],
    ['an old backend', oldStatus()],
    ['an old backend on Unlimited', oldStatus({ plan: 'unlimited', planSource: 'subscription' })],
  ])('keeps the Agents box for %s', (_label, status) => {
    setup(status);
    render(<SidebarUsageSlot collapsed={false} />);
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Talyn Fleet')).toBeInTheDocument();
    expect(document.querySelector('[data-attr="usage-gauge"]')).toBeNull();
  });

  it('shows the tier, the hours, the reset and the credits', () => {
    setup(usageStatus('pro', { usedHours: 37.5, balanceMicros: 12_500_000 }));
    render(<SidebarUsageSlot collapsed={false} />);
    expect(screen.queryByText('Agents')).toBeNull();
    expect(screen.getByText('Pro plan')).toBeInTheDocument();
    expect(screen.getByText('37.5 of 200 box-hours')).toBeInTheDocument();
    expect(screen.getByText(/Resets .* · \$12\.50 credits/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '18');
  });

  it.each([
    ['free', 2, 'Upgrade', 'bg-primary'],
    ['free', 5, 'Upgrade', 'bg-amber-400'],
    ['free', 8, 'Upgrade', 'bg-orange-500'],
    ['legacy_pro', 10, 'Upgrade', 'bg-primary'],
    ['legacy_pro', 45, 'Add credits', 'bg-orange-500'],
    ['pro', 20, 'Add credits', 'bg-primary'],
  ] as const)('%s with %i box-hours used offers %s and colours the bar %s', (tier, usedHours, action, barClass) => {
    setup(usageStatus(tier, { usedHours }));
    render(<SidebarUsageSlot collapsed={false} />);
    expect(screen.getByRole('button', { name: action })).toBeInTheDocument();
    expect(screen.getByRole('progressbar').firstElementChild).toHaveClass(barClass);
  });

  it('says plainly when the hours are out', () => {
    setup(usageStatus('free', { usedHours: 10, exhausted: true }));
    render(<SidebarUsageSlot collapsed={false} />);
    expect(screen.getByText('Out of hours: new boxes paused')).toBeInTheDocument();
    expect(screen.queryByText('10 of 10 box-hours')).toBeNull();
    expect(screen.getByRole('progressbar').firstElementChild).toHaveClass('bg-destructive');
  });

  it('opens the plan page on a click and the modal from the action', () => {
    setup(usageStatus('legacy_pro', { usedHours: 5 }));
    render(<SidebarUsageSlot collapsed={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Open plan and usage/ }));
    expect(openSettings).toHaveBeenCalledWith('billing');
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(useBillingStore.getState()).toMatchObject({ upgradeModalOpen: true, upgradeReason: 'upgrade' });
  });

  it('keeps an agent that needs reconnecting visible and opens integrations', () => {
    setup(usageStatus('pro'), [{ ...FLEET, reauthAgents: ['claude'] }, POSTHOG]);
    render(<SidebarUsageSlot collapsed={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Claude needs reconnecting' }));
    expect(openSettings).toHaveBeenCalledWith('integrations');
  });

  it('lists no healthy agents', () => {
    setup(usageStatus('pro'));
    render(<SidebarUsageSlot collapsed={false} />);
    expect(screen.queryByText(/Talyn Fleet/)).toBeNull();
    expect(screen.queryByText(/PostHog Code/)).toBeNull();
  });

  it('draws a ring with the same data in its tooltip when collapsed', () => {
    setup(usageStatus('pro', { usedHours: 100, balanceMicros: 5_000_000 }), [{ ...FLEET, reauthAgents: ['claude'] }]);
    render(<SidebarUsageSlot collapsed />);
    const button = document.querySelector('[data-attr="usage-gauge"]') as HTMLElement;
    const title = button.getAttribute('title') ?? '';
    expect(title).toContain('Pro plan');
    expect(title).toContain('100 of 200 box-hours');
    expect(title).toContain('$5.00 credits');
    expect(title).toContain('Claude needs reconnecting');
    expect(button.querySelector('svg')).not.toBeNull();
    fireEvent.click(button);
    expect(openSettings).toHaveBeenCalledWith('billing');
  });
});

describe('agentWarnings', () => {
  it.each([
    ['no providers', [], false, []],
    ['healthy providers', [FLEET, POSTHOG], false, []],
    ['a fleet agent that needs a new sign-in', [{ ...FLEET, reauthAgents: ['codex'] }], false, ['Codex needs reconnecting']],
    ['a provider that needs reconnecting', [{ ...FLEET, needsReconnect: true }], false, ['Talyn Fleet needs reconnecting']],
    ['a PostHog Code token that needs a new sign-in', [FLEET, { ...POSTHOG, connected: true }], true, ['PostHog Code needs reconnecting']],
    ['nothing connected at all', [{ ...FLEET, connected: false }, POSTHOG], false, ['No agent is connected']],
  ] as const)('%s', (_label, providers, posthogReauth, expected) => {
    expect(agentWarnings(providers as unknown as CloudProviderInfo[], posthogReauth)).toEqual(expected);
  });
});
