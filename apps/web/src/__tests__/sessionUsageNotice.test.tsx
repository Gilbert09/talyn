import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { AgentEvent } from '@talyn/shared';
import { SessionUsageNotice } from '../components/workbench/SessionUsageNotice';
import { AgentBlocks } from '../components/workbench/AgentBlocks';
import { useBillingStore } from '../stores/billing';
import { trackEvent } from '../lib/analytics';
import { useWakeRefusalStore, wakeWorkbench } from '../lib/wakeWorkbench';
import { oldStatus, usageStatus } from './usageBillingFixtures';

const { wake } = vi.hoisted(() => ({ wake: vi.fn() }));

vi.mock('@talyn/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@talyn/client')>();
  return { ...actual, api: { ...actual.api, workbenches: { ...actual.api.workbenches, wake } } };
});
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));

const BUSY = { code: 'concurrent_box_limit_reached', message: 'The Free plan runs 2 boxes at the same time (2 in use).', limit: 2, active: 2 } as const;

describe('SessionUsageNotice', () => {
  beforeEach(() => {
    useWakeRefusalStore.setState({ refusals: {} });
    useBillingStore.setState({ upgradeModalOpen: false, upgradeReason: null, upgradeNotice: null });
  });
  afterEach(cleanup);

  it.each([
    ['an old backend', oldStatus()],
    ['a plan with room', usageStatus('free', { usedHours: 3 })],
  ])('draws nothing for %s', (_label, status) => {
    useBillingStore.setState({ status });
    const { container } = render(<SessionUsageNotice workbenchId="wb1" />);
    expect(container.innerHTML).toBe('');
  });

  it('draws nothing for a wake refusal on an old backend', () => {
    useBillingStore.setState({ status: oldStatus() });
    useWakeRefusalStore.getState().setRefusal('wb1', BUSY);
    const { container } = render(<SessionUsageNotice workbenchId="wb1" />);
    expect(container.innerHTML).toBe('');
  });

  it.each([
    ['free', 'Upgrade'],
    ['pro', 'Add credits'],
  ] as const)('says the hours are out on %s and offers %s', (tier, action) => {
    useBillingStore.setState({ status: usageStatus(tier, { usedHours: 300, exhausted: true }) });
    render(<SessionUsageNotice workbenchId="wb1" />);
    expect(screen.getByText('Out of hours: new boxes paused')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: action }));
    expect(useBillingStore.getState()).toMatchObject({ upgradeModalOpen: true, upgradeReason: 'usage_exhausted' });
    if (action === 'Add credits') expect(trackEvent).toHaveBeenCalledWith('add_credits_clicked', { where: 'refusal' });
  });

  it('shows the wake refusal for this session only', () => {
    useBillingStore.setState({ status: usageStatus('free') });
    useWakeRefusalStore.getState().setRefusal('wb1', BUSY);
    render(<SessionUsageNotice workbenchId="wb1" />);
    render(<SessionUsageNotice workbenchId="wb2" />);
    expect(screen.getAllByText('All your boxes are busy')).toHaveLength(1);
    expect(screen.getByText(BUSY.message)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(useBillingStore.getState()).toMatchObject({ upgradeReason: 'concurrent_box_limit', upgradeNotice: BUSY });
  });

  it('drops an out-of-hours wake refusal once the status has hours again', () => {
    useBillingStore.setState({ status: usageStatus('pro', { usedHours: 10 }) });
    useWakeRefusalStore.getState().setRefusal('wb1', { code: 'usage_exhausted', message: 'Out.' });
    const { container } = render(<SessionUsageNotice workbenchId="wb1" />);
    expect(container.innerHTML).toBe('');
  });
});

describe('wakeWorkbench', () => {
  beforeEach(() => {
    wake.mockReset();
    useWakeRefusalStore.setState({ refusals: {} });
  });

  it('stores a refused wake and clears it on the next good one', async () => {
    wake.mockResolvedValueOnce({ status: 'box_limit', code: BUSY.code, notice: BUSY });
    wakeWorkbench('wb-a');
    await waitFor(() => expect(useWakeRefusalStore.getState().refusals['wb-a']).toEqual(BUSY));

    wake.mockResolvedValueOnce({ status: 'resuming' });
    wakeWorkbench('wb-b');
    await waitFor(() => expect(wake).toHaveBeenCalledTimes(2));
    expect(useWakeRefusalStore.getState().refusals['wb-b']).toBeUndefined();
  });

  it('stores nothing for an old backend answer', async () => {
    wake.mockResolvedValueOnce({ status: 'skipped' });
    wakeWorkbench('wb-c');
    await waitFor(() => expect(wake).toHaveBeenCalled());
    expect(useWakeRefusalStore.getState().refusals).toEqual({});
  });
});

describe('box refusal events in a session', () => {
  afterEach(cleanup);

  it.each([
    ['usage_exhausted', 'Out of hours', 'usage_exhausted'],
    ['box_limit_reached', 'All your boxes are busy', 'concurrent_box_limit'],
  ])('renders %s as a notice with an action', (subtype, heading, reason) => {
    const text = 'Talyn did not start this message. It stays in the queue: send a message to try again.';
    const events = [{ type: 'system', subtype, text, seq: 1 } as unknown as AgentEvent];
    render(<AgentBlocks events={events} />);
    expect(screen.getByText(heading)).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'See options' }));
    expect(useBillingStore.getState()).toMatchObject({ upgradeModalOpen: true, upgradeReason: reason });
  });

  it('keeps other system lines as they were', () => {
    render(<AgentBlocks events={[{ type: 'system', subtype: 'compact', text: 'Compacted.', seq: 1 } as unknown as AgentEvent]} />);
    expect(screen.queryByRole('button', { name: 'See options' })).toBeNull();
  });
});
