import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AdminFleetAlerts } from '@talyn/shared';

/**
 * The host alerts banner on every console page.
 */

const alerts = vi.fn();
vi.mock('../lib/api', () => ({
  api: { admin: { fleet: { alerts: (...a: unknown[]) => alerts(...a) } } },
}));

const { HostAlertsBanner } = await import('../components/layout/HostAlertsBanner');

beforeEach(() => {
  vi.clearAllMocks();
  alerts.mockResolvedValue({ alerts: [], checkedAt: new Date().toISOString() } satisfies AdminFleetAlerts);
});
afterEach(cleanup);

describe('HostAlertsBanner', () => {
  function renderBanner() {
    return render(
      <MemoryRouter>
        <HostAlertsBanner />
      </MemoryRouter>
    );
  }

  it('shows nothing when no host has an alert', async () => {
    renderBanner();
    await waitFor(() => expect(alerts).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names the host and the alert, critical first', async () => {
    alerts.mockResolvedValue({
      alerts: [
        { host: 'hetzner-64', kind: 'disk_low', severity: 'critical', detail: 'fleet store has 900 MiB free' },
        { host: 'scaleway-1', kind: 'bake_failing', severity: 'warning', detail: '1 repo failed 3 bakes' },
      ],
      checkedAt: new Date().toISOString(),
    } satisfies AdminFleetAlerts);
    renderBanner();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toContain('hetzner-64: Disk low (critical)');
    expect(text).toContain('scaleway-1: Bakes failing');
    expect(text.indexOf('hetzner-64')).toBeLessThan(text.indexOf('scaleway-1'));
  });

  it('shows nothing when the read fails', async () => {
    alerts.mockRejectedValue(new Error('boom'));
    renderBanner();
    await waitFor(() => expect(alerts).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
