import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../lib/api';
import { ComputeUsagePage } from '../routes/product/ComputeUsagePage';

vi.mock('../lib/api', () => ({ api: { admin: { computeUsage: vi.fn(), computeDaily: vi.fn() } } }));

const USAGE = {
  items: [{
    user_id: 'alice', email: 'alice@example.test', tier: 'pro', plan_override: null,
    period_start: null, period_end: null, period_used_hours: 3.25,
    period_included_hours: 10, credits_used_usd: 0, all_time_hours: 6,
    hours_last_7_days: 2, sessions_total: 4, sessions_active: 2,
    boxes_running: 1, last_active_at: '2026-11-06T12:00:00.000Z',
  }],
  totals: { users: 1, period_used_hours: 3.25, all_time_hours: 6, sessions_total: 4, boxes_running: 1 },
};

function daily(userId: string | null = null) {
  return {
    start: '2026-11-09T00:00:00.000Z', end: '2026-11-11T12:00:00.000Z',
    user_id: userId, user_email: userId === 'carol' ? 'carol@example.test' : null,
    days: [
      { day: '2026-11-09', hours: 2, wall_hours: 2, boxes_started: 1 },
      { day: '2026-11-10', hours: 0, wall_hours: 0, boxes_started: 0 },
      { day: '2026-11-11', hours: 6, wall_hours: 3, boxes_started: 2 },
    ],
    totals: { hours: 8, wall_hours: 5, boxes_started: 3, peak_day: '2026-11-11', peak_hours: 6 },
    by_kind: [{ key: 'workbench', hours: 6 }, { key: 'task', hours: 2 }],
    by_size: [{ key: 'large', hours: 6 }, { key: 'small', hours: 2 }],
    users: [
      { user_id: 'alice', email: 'alice@example.test', hours: 8 },
      { user_id: 'bob', email: 'bob@example.test', hours: 8 },
    ],
  };
}

function renderPage(path = '/') {
  return render(<MemoryRouter initialEntries={[path]}><ComputeUsagePage /></MemoryRouter>);
}

beforeEach(() => {
  vi.mocked(api.admin.computeUsage).mockResolvedValue(USAGE);
  vi.mocked(api.admin.computeDaily).mockImplementation(async (params) => daily(params?.userId ?? null));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('compute usage page', () => {
  it('shows usage and sends the selected sort', async () => {
    renderPage();
    expect(await screen.findByText('of 10.0 included')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show compute hours for alice@example.test' })).toBeTruthy();
    expect(screen.getByText('(2 active)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Sessions' }));
    await waitFor(() => expect(api.admin.computeUsage).toHaveBeenLastCalledWith({ q: undefined, sort: 'sessions', order: 'desc' }));
  });

  it('charts box-hours per day for every account by default', async () => {
    renderPage();
    await waitFor(() => expect(api.admin.computeDaily).toHaveBeenCalledWith({ days: 30, userId: undefined }));
    expect(await screen.findByText('8.0 h')).toBeTruthy();
    expect(screen.getByText('5.0 wall-clock hours')).toBeTruthy();
    expect(screen.getByText('2 of 3 days active')).toBeTruthy();
    expect(screen.getByText('Accounts with usage')).toBeTruthy();
    expect(screen.getAllByTestId('compute-day')).toHaveLength(3);
    expect(screen.getByLabelText('Nov 11: 6.0 box-hours')).toBeTruthy();
    expect(screen.getByText('By kind')).toBeTruthy();
    expect(screen.getByText('Top accounts')).toBeTruthy();
  });

  it('shows a tooltip for the hovered day', async () => {
    renderPage();
    fireEvent.mouseEnter(await screen.findByLabelText('Nov 11: 6.0 box-hours'));
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('6.0 box-hours');
    expect(tooltip.textContent).toContain('2 boxes started');
  });

  it.each([
    ['the account select', async () => fireEvent.change(await screen.findByLabelText('Filter by account'), { target: { value: 'bob' } })],
    ['a top account', async () => fireEvent.click(await screen.findByRole('button', { name: 'Filter by bob@example.test' }))],
  ])('filters by user from %s', async (_label, act) => {
    renderPage();
    await act();
    await waitFor(() => expect(api.admin.computeDaily).toHaveBeenLastCalledWith({ days: 30, userId: 'bob' }));
    expect(await screen.findByText('Share of all hours')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.queryByText('Top accounts')).toBeNull();
  });

  it('filters by user from the table without opening the account', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Show compute hours for alice@example.test' }));
    await waitFor(() => expect(api.admin.computeDaily).toHaveBeenLastCalledWith({ days: 30, userId: 'alice' }));
    expect(screen.getByRole('button', { name: 'Show compute hours for alice@example.test' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('changes the range', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '7d' }));
    await waitFor(() => expect(api.admin.computeDaily).toHaveBeenLastCalledWith({ days: 7, userId: undefined }));
    expect(screen.getByRole('button', { name: '7d' }).getAttribute('aria-pressed')).toBe('true');
  });

  it.each([
    ['/?days=90&user=carol', 90, 'carol'],
    ['/?days=12', 30, undefined],
  ])('reads the range and user from the URL: %s', async (path, days, userId) => {
    renderPage(path);
    await waitFor(() => expect(api.admin.computeDaily).toHaveBeenCalledWith({ days, userId }));
  });

  it('keeps an account without usage selectable', async () => {
    renderPage('/?user=carol');
    const select = await screen.findByLabelText('Filter by account') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('carol'));
    expect(screen.getByRole('option', { name: 'carol@example.test' })).toBeTruthy();
  });

  it('shows an error when the daily stats fail', async () => {
    vi.mocked(api.admin.computeDaily).mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText(/Compute hours unavailable/)).toBeTruthy();
    expect(await screen.findByText('alice@example.test')).toBeTruthy();
  });
});
