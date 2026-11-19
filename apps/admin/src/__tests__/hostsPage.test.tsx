import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AdminFleetHost } from '@talyn/shared';
import { HostsPage } from '../routes/fleet/HostsPage';
import { HostHealthPanel } from '../components/fleet/HostHealth';

const hosts = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', () => ({
  api: { admin: { fleet: { hosts } } },
}));
vi.mock('../components/auth/AdminGate', () => ({
  useCapability: () => false,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function host(overrides: Partial<AdminFleetHost> = {}): AdminFleetHost {
  return {
    name: 'coder-1',
    apiEndpoint: 'http://coder-1.yas-tunnel.invalid',
    version: '1.0.0',
    reportedAt: new Date().toISOString(),
    draining: false,
    runsLive: 1,
    runsMax: 2,
    memReservedMib: 512,
    memBudgetMib: 2048,
    diskFreeMib: 40_000,
    maxIdleSeconds: 0,
    online: true,
    dispatchable: true,
    live: {
      draining: false,
      runsLive: 1,
      runsMax: 2,
      memReservedMib: 512,
      memBudgetMib: 2048,
      accepting: true,
    },
    liveSource: 'report',
    liveError: null,
    liveErrorCode: null,
    ...overrides,
  };
}

function renderPage(value: AdminFleetHost) {
  hosts.mockResolvedValue([value]);
  render(<MemoryRouter><HostsPage /></MemoryRouter>);
}

describe('Hosts page live pills', () => {
  it.each([true, false])('labels report capacity with accepting=%s', async (accepting) => {
    const value = host();
    value.live!.accepting = accepting;
    value.online = accepting;
    renderPage(value);
    const pill = await screen.findByText(accepting ? 'accepting' : 'not accepting');
    expect(pill.getAttribute('title')).toBe("from the host's last report (control-tunnel host)");
    expect(screen.queryByText('unreachable')).toBeNull();
    expect(hosts).toHaveBeenCalledWith({ live: true });
  });

  it('keeps the normal probe pill without the report tooltip', async () => {
    renderPage(host({ apiEndpoint: 'http://10.0.0.1:8080', liveSource: 'probe' }));
    expect((await screen.findByText('accepting')).getAttribute('title')).toBeNull();
  });

  it('keeps the error tooltip for a failed direct probe', async () => {
    renderPage(host({ live: null, liveSource: 'probe', liveError: 'Connection refused' }));
    expect((await screen.findByText('unreachable')).getAttribute('title')).toBe('Connection refused');
  });

  it('shows that report capacity has no live health read', () => {
    render(<HostHealthPanel host={host()} />);
    expect(screen.getByText('No live read of this host.')).toBeTruthy();
  });
});
