import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import type { AdminBillingView } from '@talyn/shared';

const billing = vi.fn();
const grantCredits = vi.fn();
const reverseCreditLot = vi.fn();
const usageSummary = vi.fn();
vi.mock('../lib/api', () => ({
  api: { admin: { users: { billing, grantCredits, reverseCreditLot }, usageSummary } },
}));

const { BillingCard } = await import('../components/admin/BillingCard');
const { UsageTile } = await import('../components/admin/UsageTile');

const VIEW: AdminBillingView = {
  tier: 'pro',
  source: 'subscription',
  period: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' },
  usage: { tier: 'pro', includedWsec: 720_000, usedWsec: 360_000, creditMicrosUsed: 0, uncoveredMicros: 0, exhaustedAt: null },
  openBoxes: [],
  lots: [
    { id: 'lot-1', source: 'grant', totalMicros: 5_000_000, remainingMicros: 5_000_000, purchasedAt: '2026-11-01T00:00:00.000Z', expiresAt: '2099-11-01T00:00:00.000Z', live: true },
    { id: 'lot-2', source: 'purchase', totalMicros: 5_000_000, remainingMicros: 0, purchasedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2099-10-01T00:00:00.000Z', live: false },
  ],
  creditBalanceMicros: 5_000_000,
  autoTopup: { enabled: true, triggerMicros: 5_000_000, pack: '25', monthlyLimitMicros: 100_000_000, monthSpentMicros: 0, lastFailure: 'card declined', lastFailureAt: '2026-11-02T00:00:00.000Z' },
  recentIntervals: [],
};

const REASON = 'goodwill after the November outage';

beforeEach(() => {
  billing.mockResolvedValue(VIEW);
  grantCredits.mockResolvedValue({ lotId: 'x', created: true, micros: 1 });
  reverseCreditLot.mockResolvedValue({ lotId: 'lot-1', reversedMicros: 5_000_000 });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function setup(canMutate = true) {
  render(<BillingCard userId="u1" email="a@b.test" canMutate={canMutate} />);
  await screen.findByText('Credit lots');
}

describe('BillingCard', () => {
  it('shows tier, meter, balance and the auto top-up failure', async () => {
    await setup();
    expect(screen.getByText('pro')).toBeTruthy();
    expect(screen.getByText(/of 200 box-hours/)).toBeTruthy();
    expect(screen.getByText(/card declined/)).toBeTruthy();
  });

  it.each([
    [undefined, false],
    [0, false],
    [180_000, true],
  ])('reset hours note with resetUsedWsec=%s shows: %s', async (resetUsedWsec, shown) => {
    billing.mockResolvedValue({ ...VIEW, usage: { ...VIEW.usage!, resetUsedWsec } });
    await setup();
    const note = screen.queryByTestId('billing-reset-hours');
    expect(Boolean(note)).toBe(shown);
    if (note) expect(note.textContent).toMatch(/cleared 50 box-hours this period/);
  });

  it('hides both actions without the capability', async () => {
    await setup(false);
    expect(screen.queryByText('Grant credits')).toBeNull();
    expect(screen.queryByText('Reverse')).toBeNull();
  });

  it('offers Reverse only on a live lot', async () => {
    await setup();
    expect(screen.getAllByText('Reverse')).toHaveLength(1);
  });

  it('does not grant until the amount is valid and a reason is long enough', async () => {
    await setup();
    fireEvent.click(screen.getByText('Grant credits'));
    const send = () => screen.getByRole('group', { name: /Grant/ }).querySelector('button')!;
    expect(send().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Amount (USD)'), { target: { value: '12.50' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'short' } });
    expect(send().disabled).toBe(true);
    expect(grantCredits).not.toHaveBeenCalled();
  });

  it('sends the grant with the reason and one idempotency key, then refreshes', async () => {
    await setup();
    fireEvent.click(screen.getByText('Grant credits'));
    fireEvent.change(screen.getByLabelText('Amount (USD)'), { target: { value: '12.50' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: REASON } });
    fireEvent.click(screen.getByText('Grant $12.50'));
    await waitFor(() => expect(grantCredits).toHaveBeenCalledTimes(1));
    const [id, body] = grantCredits.mock.calls[0]!;
    expect(id).toBe('u1');
    expect(body).toMatchObject({ amountUsd: 12.5, reason: REASON });
    expect(typeof body.idempotencyKey).toBe('string');
    await waitFor(() => expect(billing).toHaveBeenCalledTimes(2));
  });

  it('keeps the panel and the typed reason when the grant fails', async () => {
    grantCredits.mockRejectedValueOnce(new Error('backend hiccup'));
    await setup();
    fireEvent.click(screen.getByText('Grant credits'));
    fireEvent.change(screen.getByLabelText('Amount (USD)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: REASON } });
    fireEvent.click(screen.getByText('Grant $5.00'));
    expect((await screen.findByRole('alert')).textContent).toContain('backend hiccup');
    expect((screen.getByLabelText('Reason') as HTMLTextAreaElement).value).toBe(REASON);
  });

  it('reverses a lot only after the reason is given', async () => {
    await setup();
    fireEvent.click(screen.getByText('Reverse'));
    expect(reverseCreditLot).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: REASON } });
    fireEvent.click(screen.getByText('Reverse lot'));
    await waitFor(() => expect(reverseCreditLot).toHaveBeenCalledWith('u1', 'lot-1', { reason: REASON }));
  });

  it('says so when billing cannot load', async () => {
    billing.mockRejectedValue(new Error('boom'));
    render(<BillingCard userId="u1" email="a@b.test" canMutate />);
    expect(await screen.findByText('boom')).toBeTruthy();
  });
});

describe('UsageTile', () => {
  it('renders the aggregate', async () => {
    usageSummary.mockResolvedValue({
      periodBoxWsec: 36_000, ownersWithUsage: 3, ownersExhausted: 1,
      creditsSoldMicros: 50_000_000, creditsGrantedMicros: 5_000_000,
    });
    render(<UsageTile />);
    expect(await screen.findByText('10')).toBeTruthy();
    expect(screen.getByText('$50.00')).toBeTruthy();
    expect(screen.getByText('$5.00')).toBeTruthy();
    expect(screen.getByText('3 owners with usage')).toBeTruthy();
  });
});
