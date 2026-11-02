/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentEvent } from '@talyn/shared';
import { AgentBlocks } from '../renderer/components/terminal/AgentConversation';
import { sessionRefusalText } from '../renderer/components/billing/BoxRefusalAction';
import { deferralNotice } from '../renderer/hooks/useDeferredRuns';
import { useBillingStore } from '../renderer/stores/billing';
import type { PRRow } from '../renderer/lib/api';
import { usageStatus } from '../testing/billingStatus';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));

const HELD = 'Talyn did not start this message. It stays in the queue: send a message to try again.';

function systemEvent(subtype: string, text: string): AgentEvent {
  return { seq: 1, type: 'system', subtype, text } as AgentEvent;
}

describe('chat notes for a refused turn', () => {
  beforeEach(() => useBillingStore.setState({ status: null, upgradeModalOpen: false, upgradeReason: null, upgradeNotice: null }));
  afterEach(cleanup);

  it.each([
    ['usage_exhausted', 'free', 'Upgrade', 'usage_exhausted'],
    ['usage_exhausted', 'pro', 'Add credits', 'usage_exhausted'],
    ['box_limit_reached', 'free', 'Upgrade', 'concurrent_box_limit'],
  ] as const)('draws %s on %s as a notice with %s', (subtype, tier, label, reason) => {
    useBillingStore.setState({ status: usageStatus(tier) });
    const text = `The plan said no. ${HELD}`;
    render(<AgentBlocks events={[systemEvent(subtype, text)]} />);
    const note = screen.getByTestId('box-refusal-note');
    expect(note).toHaveTextContent(text);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(useBillingStore.getState().upgradeModalOpen).toBe(true);
    expect(useBillingStore.getState().upgradeReason).toBe(reason);
    expect(useBillingStore.getState().upgradeNotice).toEqual({ message: text });
  });

  it('offers no button when money does not help (a full box cap on Pro)', () => {
    useBillingStore.setState({ status: usageStatus('pro') });
    render(<AgentBlocks events={[systemEvent('box_limit_reached', 'Busy.')]} />);
    expect(screen.getByTestId('box-refusal-note')).toHaveTextContent('Busy.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('still drops other system noise', () => {
    render(<AgentBlocks events={[systemEvent('status', 'noise')]} />);
    expect(screen.queryByText('noise')).toBeNull();
  });
});

describe('sessionRefusalText', () => {
  it.each([
    [{ status: 'exhausted' as const, notice: { message: 'Server words.' } }, 'Server words.'],
    [{ status: 'exhausted' as const, notice: null }, /Out of box-hours: this session stays asleep/],
    [{ status: 'box_limit' as const, notice: null }, /All your boxes are busy/],
  ])('%o', (refusal, expected) => {
    expect(sessionRefusalText(refusal)).toMatch(expected);
  });
});

describe('deferralNotice', () => {
  const row = (state: Partial<NonNullable<PRRow['autoMergeState']>> | null) =>
    ({ autoMergeState: state }) as unknown as PRRow;

  it.each([
    ['no row', undefined, null],
    ['no auto-keep state', row(null), null],
    ['an older backend (deferredSince only)', row({ deferredSince: '2026-11-01T00:00:00Z' }), null],
    [
      'a usage deferral',
      row({ deferredSince: 'x', deferredReason: 'usage_exhausted', deferredMessage: 'Out of hours.', deferredRetryAt: '2026-12-01T00:00:00Z' }),
      { code: 'usage_exhausted', message: 'Out of hours.', retryAt: '2026-12-01T00:00:00Z' },
    ],
    [
      'a box-cap deferral with no message',
      row({ deferredSince: 'x', deferredReason: 'box_limit_reached' }),
      { code: 'concurrent_box_limit_reached', message: undefined, retryAt: undefined },
    ],
  ])('%s', (_label, input, expected) => {
    expect(deferralNotice(input)).toEqual(expected);
  });
});

// Loops read the shared labels; pin the wording a parked run shows.
describe('loop run labels', () => {
  it('calls a parked loop run "Waiting to start"', async () => {
    const { LOOP_RUN_STATUS_LABELS, LOOP_RUN_FAILURE_LABELS } = await import('@talyn/shared');
    expect(LOOP_RUN_STATUS_LABELS.waiting_slot).toBe('Waiting to start');
    expect(LOOP_RUN_FAILURE_LABELS.usage_exhausted).toBe('Waiting for box-hours or credits');
  });
});
