import type { PrivateConnector } from '@talyn/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { PrivateRoutesScreen } from '../features/privateRoutes/PrivateRoutesScreen';
import { fixture } from './workflowFixtures';

const mockLifecycle = fixture().lifecycle;
const mockGet = jest.fn();
const mockPeers = jest.fn();
const mockReplace = jest.fn();
const mockDisconnect = jest.fn();
const mockStart = jest.fn();
let mockFeatures: { privateRoutes: boolean } | null = { privateRoutes: true };
jest.mock('@talyn/client/native', () => ({
  ...jest.requireActual('@talyn/client/native'),
  workspaces: { privateConnector: {
    get: (...a: unknown[]) => mockGet(...a), peers: (...a: unknown[]) => mockPeers(...a), replaceRoutes: (...a: unknown[]) => mockReplace(...a),
    disconnect: (...a: unknown[]) => mockDisconnect(...a), start: (...a: unknown[]) => mockStart(...a),
  } },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ lifecycle: mockLifecycle }),
  useWorkspace: () => ({ status: 'ready', selected: 'one' }),
  useNetwork: () => 'online',
}));
jest.mock('../lib/features', () => ({ useFeatures: () => mockFeatures }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'dismiss' })) }));

const connector = (patch: Partial<PrivateConnector> = {}): PrivateConnector => ({
  id: 'c1', workspaceId: 'one', createdAt: '', status: 'connected', routes: [{ host: 'db.corp', port: 5432 }], ...patch,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFeatures = { privateRoutes: true };
  mockGet.mockResolvedValue(connector());
  mockPeers.mockResolvedValue({ peers: [{ name: 'box', dnsName: 'box.ts.net', addresses: ['100.1.1.1'], os: 'linux', online: true, subnetRoutes: [] }] });
});

describe('PrivateRoutesScreen', () => {
  it('is hidden when the feature is off', async () => {
    mockFeatures = { privateRoutes: false };
    await render(<PrivateRoutesScreen />);
    expect(screen.getByText('Not available')).toBeVisible();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('shows an error for an invalid destination and does not save', async () => {
    await render(<PrivateRoutesScreen />);
    await screen.findByText('db.corp:5432');
    await fireEvent.changeText(screen.getByLabelText('Hostname or IP'), 'https://x');
    await fireEvent.changeText(screen.getByLabelText('TCP port'), '80');
    await act(async () => { fireEvent.press(screen.getByLabelText('Add destination')); });
    expect(screen.getByText('Enter one exact hostname or IP address.')).toBeVisible();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('adds a route and clears the fields', async () => {
    mockReplace.mockResolvedValue(connector({ status: undefined, routes: [{ host: 'db.corp', port: 5432 }, { host: '10.0.0.8', port: 22 }] }));
    await render(<PrivateRoutesScreen />);
    await screen.findByText('db.corp:5432');
    await fireEvent.changeText(screen.getByLabelText('Hostname or IP'), '10.0.0.8');
    await fireEvent.changeText(screen.getByLabelText('TCP port'), '22');
    await act(async () => { fireEvent.press(screen.getByLabelText('Add destination')); });
    expect(mockReplace).toHaveBeenCalledWith('one', { routes: [{ host: 'db.corp', port: 5432 }, { host: '10.0.0.8', port: 22 }] });
    await screen.findByText('10.0.0.8:22');
    expect(screen.getByLabelText('Hostname or IP').props.value).toBe('');
  });

  it('shows the server message when saving fails', async () => {
    mockReplace.mockRejectedValue(new Error('The tailnet refused the route.'));
    await render(<PrivateRoutesScreen />);
    await screen.findByText('db.corp:5432');
    await act(async () => { fireEvent.press(screen.getByLabelText('Remove db.corp:5432')); });
    expect(mockReplace).toHaveBeenCalledWith('one', { routes: [] });
    expect(await screen.findByText('The tailnet refused the route.')).toBeVisible();
    expect(screen.getByText('db.corp:5432')).toBeVisible();
  });

  it('fills the host from a device address', async () => {
    await render(<PrivateRoutesScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Use box.ts.net as the hostname')); });
    expect(screen.getByLabelText('Hostname or IP').props.value).toBe('box.ts.net');
  });

  it('asks before it disconnects, then clears the connector', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockDisconnect.mockResolvedValue(undefined);
    await render(<PrivateRoutesScreen />);
    await screen.findByText('db.corp:5432');
    await fireEvent.press(screen.getByLabelText('Disconnect', { exact: true }));
    expect(mockDisconnect).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0][2] as Array<{ text: string; onPress?: () => void }>;
    await act(async () => { buttons.find((b) => b.text === 'Disconnect')?.onPress?.(); });
    expect(mockDisconnect).toHaveBeenCalledWith('one');
    await waitFor(() => expect(screen.getByText('Not connected')).toBeVisible());
    alert.mockRestore();
  });

  it('shows not connected on a 404 and opens the sign-in page on connect', async () => {
    const { ApiError } = jest.requireActual('@talyn/client/native');
    mockGet.mockRejectedValue(new ApiError('none', 404, 'not_found'));
    mockStart.mockResolvedValue({ ...connector({ status: 'needs_login', routes: [] }), loginUrl: 'https://login.tailscale.com/a/1' });
    await render(<PrivateRoutesScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Connect Tailscale')); });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(require('expo-web-browser').openBrowserAsync).toHaveBeenCalledWith('https://login.tailscale.com/a/1');
  });
});
