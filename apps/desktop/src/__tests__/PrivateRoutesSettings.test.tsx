import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PrivateConnector, PrivatePeer } from '@talyn/shared';
import { PrivateRoutesSettings } from '../renderer/components/settings/sections/PrivateRoutesSettings';

const connectorGet = jest.fn();
const peersGet = jest.fn();

jest.mock('../renderer/lib/api', () => {
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
          start: jest.fn(),
          replaceRoutes: jest.fn(),
          disconnect: jest.fn(),
        },
      },
    },
  };
});
jest.mock('../renderer/lib/openExternal', () => ({ prepareSignInWindow: jest.fn() }));
jest.mock('../renderer/stores/workspace', () => ({
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
  jest.clearAllMocks();
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
