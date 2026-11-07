import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivateConnector, PrivateConnectorStatus } from '@talyn/shared';
import { PrivateRoutesSettings } from './PrivateRoutesSettings';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  start: vi.fn(),
  replaceRoutes: vi.fn(),
  disconnect: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  offered: true,
}));

vi.mock('../../../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) {
      super(message);
    }
  },
  api: { workspaces: { privateConnector: mocks } },
}));

vi.mock('../../../lib/openExternal', () => ({
  prepareSignInWindow: () => ({ open: mocks.open, close: mocks.close }),
}));

vi.mock('../../../stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: object) => unknown) => selector({
    currentWorkspaceId: 'workspace-1',
    features: { privateRoutes: mocks.offered },
  }),
}));

function connector(status: PrivateConnectorStatus, routes = [{ host: 'db.corp', port: 5432 }]): PrivateConnector {
  return {
    id: 'connector-1',
    workspaceId: 'workspace-1',
    createdAt: '2026-11-07T00:00:00Z',
    status,
    routes,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.offered = true;
  mocks.open.mockResolvedValue(true);
  mocks.disconnect.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PrivateRoutesSettings', () => {
  it.each([
    ['needs_login', 'Sign-in needed'],
    ['awaiting_approval', 'Waiting for approval'],
    ['connecting', 'Connecting'],
    ['connected', 'Connected'],
    ['unavailable', 'Unavailable'],
  ] as const)('shows the %s state', async (status, label) => {
    mocks.get.mockResolvedValue(connector(status));
    render(<PrivateRoutesSettings />);
    expect(await screen.findByText(label)).toBeTruthy();
  });

  it('opens the one-time login URL and polls until approval is required', async () => {
    vi.useFakeTimers();
    const ApiError = (await import('../../../lib/api')).ApiError;
    mocks.get
      .mockRejectedValueOnce(new ApiError('not found', 404, 'connector_not_found'))
      .mockResolvedValueOnce(connector('awaiting_approval'));
    mocks.start.mockResolvedValue({
      ...connector('needs_login', []),
      loginUrl: 'https://login.tailscale.example/secret-once',
    });
    render(<PrivateRoutesSettings />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole('button', { name: 'Connect Tailscale' }));
    await act(async () => Promise.resolve());
    expect(mocks.open).toHaveBeenCalledWith('https://login.tailscale.example/secret-once');
    expect(document.body.textContent).not.toContain('secret-once');

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Waiting for approval')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('replaces the complete allow-list when a route is added or removed', async () => {
    mocks.get.mockResolvedValue(connector('connected'));
    mocks.replaceRoutes.mockImplementation(async (_workspaceId: string, input: { routes: PrivateConnector['routes'] }) => ({
      id: 'connector-1',
      workspaceId: 'workspace-1',
      createdAt: '2026-11-07T00:00:00Z',
      routes: input.routes,
    }));
    render(<PrivateRoutesSettings />);
    await screen.findByText('Connected');

    fireEvent.change(screen.getByLabelText('Hostname or IP'), { target: { value: 'cache.corp' } });
    fireEvent.change(screen.getByLabelText('TCP port'), { target: { value: '6379' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mocks.replaceRoutes).toHaveBeenCalledWith('workspace-1', {
      routes: [
        { host: 'db.corp', port: 5432 },
        { host: 'cache.corp', port: 6379 },
      ],
    }));

    fireEvent.click(await screen.findByRole('button', { name: 'Remove db.corp:5432' }));
    await waitFor(() => expect(mocks.replaceRoutes).toHaveBeenLastCalledWith('workspace-1', {
      routes: [{ host: 'cache.corp', port: 6379 }],
    }));
    expect(screen.getByText('Connected')).toBeTruthy();
  });

  it('accepts an already-connected start response without a login URL', async () => {
    const ApiError = (await import('../../../lib/api')).ApiError;
    mocks.get.mockRejectedValueOnce(new ApiError('not found', 404, 'no_such_connector'));
    mocks.start.mockResolvedValue(connector('connected', []));
    render(<PrivateRoutesSettings />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole('button', { name: 'Connect Tailscale' }));
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalled();
  });

  it('does not report disconnect before the backend confirms it', async () => {
    let confirm!: () => void;
    mocks.get.mockResolvedValue(connector('connected'));
    mocks.disconnect.mockReturnValue(new Promise<void>((resolve) => { confirm = resolve; }));
    render(<PrivateRoutesSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(screen.getByText('Connected')).toBeTruthy();
    await act(async () => confirm());
    expect(await screen.findByRole('button', { name: 'Connect Tailscale' })).toBeTruthy();
  });

  it('does not load connector state when the feature is not offered', () => {
    mocks.offered = false;
    const { container } = render(<PrivateRoutesSettings />);
    expect(container.innerHTML).toBe('');
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
