import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PrivateConnector, PrivatePeer } from '@talyn/shared';
import { PrivateRoutesSettings } from '../components/settings/sections/PrivateRoutesSettings';

const connectorGet = vi.fn();
const peersGet = vi.fn();

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  }
  return {
    ApiError,
    api: {
      workspaces: {
        privateConnector: {
          get: (...args: unknown[]) => connectorGet(...args),
          peers: (...args: unknown[]) => peersGet(...args),
          start: vi.fn(),
          replaceRoutes: vi.fn(),
          disconnect: vi.fn(),
        },
      },
    },
  };
});
vi.mock('../lib/openExternal', () => ({ prepareSignInWindow: vi.fn() }));
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({ currentWorkspaceId: 'ws1', features: { privateRoutes: true } }),
}));

function connector(patch: Partial<PrivateConnector> = {}): PrivateConnector {
  return {
    id: 'connector-1', workspaceId: 'ws1', createdAt: '2026-11-07T00:00:00Z', status: 'connected', routes: [], ...patch,
  };
}

function peer(patch: Partial<PrivatePeer> = {}): PrivatePeer {
  return {
    name: 'db-1', dnsName: 'db-1.tail.ts.net', addresses: ['100.64.0.5', 'fd7a:115c:a1e0::5'], os: 'linux',
    online: true, subnetRoutes: [], ...patch,
  };
}

beforeEach(() => {
  connectorGet.mockResolvedValue(connector());
  peersGet.mockResolvedValue({ peers: [peer()] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('lists tailnet devices with every address', async () => {
  peersGet.mockResolvedValue({
    peers: [peer(), peer({ name: 'router', dnsName: '', addresses: ['100.64.0.9'], online: false, os: '', subnetRoutes: ['10.0.0.0/24'] })],
  });
  render(<PrivateRoutesSettings />);

  expect(await screen.findByText('db-1')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'db-1.tail.ts.net' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '100.64.0.5' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'fd7a:115c:a1e0::5' })).toBeInTheDocument();
  expect(screen.getByText('linux')).toBeInTheDocument();
  expect(screen.getByText('router')).toBeInTheDocument();
  expect(screen.getByText('Subnets: 10.0.0.0/24')).toBeInTheDocument();
  expect(screen.getByLabelText('Offline')).toBeInTheDocument();
  expect(peersGet).toHaveBeenCalledWith('ws1');
});

test('puts a selected address in the hostname field', async () => {
  render(<PrivateRoutesSettings />);

  fireEvent.click(await screen.findByRole('button', { name: '100.64.0.5' }));

  expect(screen.getByLabelText('Hostname or IP')).toHaveValue('100.64.0.5');
  expect(screen.getByLabelText('TCP port')).toHaveFocus();
});

test.each([
  ['an empty tailnet', () => peersGet.mockResolvedValue({ peers: [] }), 'No devices'],
  ['a failed request', () => peersGet.mockRejectedValue(new Error('The private connector is not connected.')), 'The private connector is not connected.'],
])('shows %s', async (_label, arrange, text) => {
  arrange();
  render(<PrivateRoutesSettings />);
  expect(await screen.findByText(text)).toBeInTheDocument();
});

test.each(['needs_login', 'awaiting_approval', 'connecting', 'unavailable'] as const)(
  'does not read devices while the connector is %s',
  async (status) => {
    connectorGet.mockResolvedValue(connector({ status }));
    render(<PrivateRoutesSettings />);
    await waitFor(() => expect(connectorGet).toHaveBeenCalled());
    await screen.findByText(/Sign-in needed|Waiting for approval|Connecting|Unavailable/);
    expect(peersGet).not.toHaveBeenCalled();
    expect(screen.queryByText('Tailnet devices')).not.toBeInTheDocument();
  },
);

test('reads devices again on refresh', async () => {
  render(<PrivateRoutesSettings />);
  await screen.findByText('db-1');
  peersGet.mockResolvedValue({ peers: [peer({ name: 'api', dnsName: 'api.tail.ts.net', addresses: ['100.64.0.6'] })] });

  fireEvent.click(screen.getByRole('button', { name: 'Refresh tailnet devices' }));

  expect(await screen.findByText('api')).toBeInTheDocument();
  expect(screen.queryByText('db-1')).not.toBeInTheDocument();
  expect(peersGet).toHaveBeenCalledTimes(2);
});

function filterPeers() {
  peersGet.mockResolvedValue({
    peers: [
      peer(),
      peer({ name: 'api-gateway', dnsName: 'api-gateway.tail.ts.net', addresses: ['100.64.0.6'], os: 'macOS' }),
      peer({ name: 'router', dnsName: '', addresses: ['100.64.0.9'], os: 'windows', subnetRoutes: ['10.0.0.0/24'] }),
    ],
  });
}

test.each([
  ['a name', 'API', ['api-gateway']],
  ['a DNS name', 'db-1.tail', ['db-1']],
  ['an IPv4 address', '100.64.0.9', ['router']],
  ['an IPv6 address', 'fd7a:115c', ['db-1']],
  ['an OS', 'macos', ['api-gateway']],
  ['a subnet route', '10.0.0.0', ['router']],
  ['several words', 'gateway  macos', ['api-gateway']],
  ['blank space', '   ', ['db-1', 'api-gateway', 'router']],
])('filters devices by %s', async (_label, query, expected) => {
  filterPeers();
  render(<PrivateRoutesSettings />);
  await screen.findByText('db-1');

  fireEvent.change(screen.getByLabelText('Filter tailnet devices'), { target: { value: query } });

  for (const name of ['db-1', 'api-gateway', 'router']) {
    if (expected.includes(name)) expect(screen.getByText(name)).toBeInTheDocument();
    else expect(screen.queryByText(name)).not.toBeInTheDocument();
  }
});

test('shows a message when no device matches the filter', async () => {
  render(<PrivateRoutesSettings />);
  await screen.findByText('db-1');

  fireEvent.change(screen.getByLabelText('Filter tailnet devices'), { target: { value: 'nothing ' } });

  expect(screen.getByText('No matching devices')).toBeInTheDocument();
  expect(screen.getByText('No device matches "nothing".')).toBeInTheDocument();
  expect(screen.queryByText('db-1')).not.toBeInTheDocument();
});

test.each([
  ['the clear button', () => fireEvent.click(screen.getByRole('button', { name: 'Clear device filter' }))],
  ['the Escape key', () => fireEvent.keyDown(screen.getByLabelText('Filter tailnet devices'), { key: 'Escape' })],
])('clears the device filter with %s', async (_label, clear) => {
  filterPeers();
  render(<PrivateRoutesSettings />);
  await screen.findByText('db-1');
  fireEvent.change(screen.getByLabelText('Filter tailnet devices'), { target: { value: 'router' } });
  expect(screen.queryByText('db-1')).not.toBeInTheDocument();

  clear();

  expect(screen.getByLabelText('Filter tailnet devices')).toHaveValue('');
  expect(screen.getByText('db-1')).toBeInTheDocument();
  expect(screen.getByText('api-gateway')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Clear device filter' })).not.toBeInTheDocument();
});

test('keeps the filter when devices are read again', async () => {
  filterPeers();
  render(<PrivateRoutesSettings />);
  await screen.findByText('db-1');
  fireEvent.change(screen.getByLabelText('Filter tailnet devices'), { target: { value: 'router' } });

  fireEvent.click(screen.getByRole('button', { name: 'Refresh tailnet devices' }));

  await waitFor(() => expect(peersGet).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('Filter tailnet devices')).toHaveValue('router');
  expect(screen.getByText('router')).toBeInTheDocument();
  expect(screen.queryByText('db-1')).not.toBeInTheDocument();
});

test.each([
  ['an empty tailnet', () => peersGet.mockResolvedValue({ peers: [] }), 'No devices'],
  ['a failed request', () => peersGet.mockRejectedValue(new Error('The private connector is not connected.')), 'The private connector is not connected.'],
])('does not show the device filter for %s', async (_label, arrange, text) => {
  arrange();
  render(<PrivateRoutesSettings />);
  await screen.findByText(text);
  expect(screen.queryByLabelText('Filter tailnet devices')).not.toBeInTheDocument();
});
