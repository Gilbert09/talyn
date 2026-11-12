import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AdminBillingInterval, AdminBillingSubject, AdminBillingView } from '@talyn/shared';

const billing = vi.fn();
const grantCredits = vi.fn();
const reverseCreditLot = vi.fn();
const usageSummary = vi.fn();
vi.mock('../lib/api', () => ({
  api: { admin: { users: { billing, grantCredits, reverseCreditLot }, usageSummary } },
}));

const { BillingCard } = await import('../components/admin/BillingCard');
const { UsageTile } = await import('../components/admin/UsageTile');
const { costMicros } = await import('../lib/format');

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

describe('BillingCard: peak memory and cost', () => {
  const subject = (over: Partial<AdminBillingSubject>): AdminBillingSubject => ({
    subjectKind: 'workbench', subjectId: 'wb-1', title: 'Speed up CI', firstStartedAt: '2026-11-12T10:00:00.000Z',
    lastEndedAt: null, running: true, intervals: 3, peakMemUsedMib: 9216, peakSize: 'large', billedWsec: 7200,
    costMicros: 440_000, ...over,
  });
  const interval = (over: Partial<AdminBillingInterval>): AdminBillingInterval => ({
    id: 'i-1', subjectKind: 'workbench', subjectId: 'wb-1', sandboxId: 'sb-1', size: 'standard',
    startedAt: '2026-11-12T10:00:00.000Z', endedAt: '2026-11-12T10:05:00.000Z', endReason: 'resize', billedWsec: 300, ...over,
  });

  async function show(view: Partial<AdminBillingView>) {
    billing.mockResolvedValue({ ...VIEW, ...view });
    render(
      <MemoryRouter>
        <BillingCard userId="u1" email="a@b.test" canMutate={false} />
      </MemoryRouter>
    );
    await screen.findByText('Credit lots');
  }

  it('lists each session and task with its title link, peak memory, billed size and cost', async () => {
    await show({
      subjects: [
        subject({}),
        subject({
          subjectKind: 'task', subjectId: 't-1', title: 'Fix the flaky test', running: false, lastEndedAt: '2026-11-12T11:00:00.000Z',
          intervals: 1, peakMemUsedMib: 812, peakSize: 'small', billedWsec: 30, costMicros: 1833,
        }),
        subject({ subjectKind: 'review_unit', subjectId: 'ru-1', title: null, peakMemUsedMib: null, costMicros: 0, intervals: 1 }),
      ],
    });
    const list = screen.getByRole('list', { name: 'Sessions and tasks' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByRole('link', { name: 'Speed up CI' }).getAttribute('href')).toBe('/product/sessions/wb-1');
    expect(rows[0].textContent).toContain('peak 9.0 GiB');
    expect(rows[0].textContent).toContain('billed up to large');
    expect(rows[0].textContent).toContain('$0.440');
    expect(rows[0].textContent).toContain('2 box-hours · 3 intervals');
    expect(within(rows[0]).getByText('running')).toBeTruthy();
    expect(within(rows[1]).getByRole('link', { name: 'Fix the flaky test' }).getAttribute('href')).toBe('/product/tasks/t-1');
    expect(rows[1].textContent).toContain('peak 812 MiB');
    expect(rows[1].textContent).toContain('$0.002');
    expect(rows[1].textContent).toContain('1 interval');
    expect(rows[1].textContent).toMatch(/ended .* ago/);
    // A review unit has no page: its id shows as text.
    expect(within(rows[2]).queryByRole('link')).toBeNull();
    expect(rows[2].textContent).toContain('ru-1');
    expect(rows[2].textContent).toContain('no memory reading');
    expect(rows[2].textContent).toContain('$0');
  });

  it.each([
    [[], 'No usage in the last 30 days.', true],
    [undefined, 'No usage in the last 30 days.', false],
  ])('with subjects=%j the empty note shows: %s', async (subjects, text, shown) => {
    await show({ subjects });
    expect(Boolean(screen.queryByText(text))).toBe(shown);
    expect(Boolean(screen.queryByText('Sessions and tasks, last 30 days'))).toBe(shown);
  });

  it('shows peak memory and cost on each interval and on an open box', async () => {
    const open = interval({ id: 'i-open', endedAt: null, endReason: null, billedWsec: 3600, peakMemUsedMib: 2048, costMicros: 220_000 });
    await show({
      openBoxes: [open],
      recentIntervals: [open, interval({ peakMemUsedMib: null, costMicros: 500 })],
    });
    const peaks = screen.getAllByTestId('peak-memory').map((n) => n.textContent);
    expect(peaks).toEqual(['peak 2.0 GiB', 'peak 2.0 GiB', 'no memory reading']);
    expect(screen.getAllByText(/1 box-hours billed so far · \$0\.220/)).toHaveLength(2);
    expect(screen.getByText(/ended resize · 0\.083 box-hours billed · <\$0\.001/)).toBeTruthy();
  });

  it('shows no peak or cost from an older backend that sends neither', async () => {
    await show({ recentIntervals: [interval({})] });
    expect(screen.queryByTestId('peak-memory')).toBeNull();
    expect(screen.getByText('ended resize · 0.083 box-hours billed')).toBeTruthy();
  });
});

describe('costMicros', () => {
  it.each([
    [null, '$0'],
    [undefined, '$0'],
    [Number.NaN, '$0'],
    [-5, '$0'],
    [0, '$0'],
    [1, '<$0.001'],
    [999, '<$0.001'],
    [1000, '$0.001'],
    [42_000, '$0.042'],
    [999_499, '$0.999'],
    [999_999, '$1.00'],
    [1_000_000, '$1.00'],
    [12_500_000, '$12.50'],
  ])('%s -> %s', (micros, text) => {
    expect(costMicros(micros)).toBe(text);
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
