import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../lib/api';
import { ComputeUsagePage } from '../routes/product/ComputeUsagePage';

vi.mock('../lib/api', () => ({ api: { admin: { computeUsage: vi.fn() } } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('compute usage page', () => {
  it('shows usage and sends the selected sort', async () => {
    vi.mocked(api.admin.computeUsage).mockResolvedValue({
      items: [{
        user_id: 'alice', email: 'alice@example.test', tier: 'pro', plan_override: null,
        period_start: null, period_end: null, period_used_hours: 3.25,
        period_included_hours: 10, credits_used_usd: 0, all_time_hours: 6,
        hours_last_7_days: 2, sessions_total: 4, sessions_active: 2,
        boxes_running: 1, last_active_at: '2026-11-06T12:00:00.000Z',
      }],
      totals: { users: 1, period_used_hours: 3.25, all_time_hours: 6, sessions_total: 4, boxes_running: 1 },
    });

    render(<MemoryRouter><ComputeUsagePage /></MemoryRouter>);
    expect(await screen.findByText('alice@example.test')).toBeTruthy();
    expect(screen.getByText('of 10.0 included')).toBeTruthy();
    expect(screen.getByText('(2 active)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Sessions' }));
    await waitFor(() => expect(api.admin.computeUsage).toHaveBeenLastCalledWith({ q: undefined, sort: 'sessions', order: 'desc' }));
  });
});
