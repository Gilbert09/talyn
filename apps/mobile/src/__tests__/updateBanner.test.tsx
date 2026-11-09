import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { AppInfo } from '../features/settings/about';
import { AboutUpdates } from '../features/updates/AboutUpdates';
import { createUpdateController, type UpdatesApi } from '../features/updates/controller';
import { FOREGROUND_CHECK_INTERVAL_MS } from '../features/updates/model';
import { UpdateBanner } from '../features/updates/UpdateBanner';

jest.mock('expo-updates', () => ({
  isEnabled: false, channel: null, runtimeVersion: null, updateId: null, createdAt: null, isEmbeddedLaunch: true,
  checkForUpdateAsync: jest.fn(), fetchUpdateAsync: jest.fn(), reloadAsync: jest.fn(),
}));

const insets = { frame: { x: 0, y: 0, width: 400, height: 900 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const draw = (node: React.ReactElement) => render(<SafeAreaProvider initialMetrics={insets}>{node}</SafeAreaProvider>);

let appStateListener: ((state: AppStateStatus) => void) | null = null;
beforeEach(() => {
  appStateListener = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appStateListener = listener as (state: AppStateStatus) => void;
    return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
  });
});
afterEach(() => jest.restoreAllMocks());

function api(found = true): jest.Mocked<UpdatesApi> {
  return {
    checkForUpdateAsync: jest.fn(async () => ({ isAvailable: found, isRollBackToEmbedded: false })),
    fetchUpdateAsync: jest.fn(async () => ({ isNew: true, isRollBackToEmbedded: false, manifest: { id: 'abcdef12-3456' } })),
    reloadAsync: jest.fn(async () => {}),
  } as jest.Mocked<UpdatesApi>;
}

describe('update banner', () => {
  it('checks at launch and offers a restart without reloading', async () => {
    const updates = api();
    await draw(<UpdateBanner controller={createUpdateController(updates, { enabled: true })} />);
    expect(await screen.findByText('Update ready. Restart Talyn to use it.')).toBeTruthy();
    expect(updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(updates.reloadAsync).not.toHaveBeenCalled();
    fireEvent.press(screen.getByLabelText('Restart Talyn to apply the update'));
    expect(updates.reloadAsync).toHaveBeenCalledTimes(1);
  });

  it('closes until the next download and leaves the update for the next start', async () => {
    const updates = api();
    await draw(<UpdateBanner controller={createUpdateController(updates, { enabled: true })} />);
    const close = await screen.findByLabelText('Restart later');
    await act(async () => { fireEvent.press(close); });
    expect(screen.queryByTestId('update-banner')).toBeNull();
    expect(updates.reloadAsync).not.toHaveBeenCalled();
  });

  it.each([[false, 'no update'], [true, 'updates off']])('draws nothing for %s', async (off) => {
    const updates = api(false);
    await draw(<UpdateBanner controller={createUpdateController(updates, { enabled: !off })} />);
    await act(async () => {});
    expect(screen.queryByTestId('update-banner')).toBeNull();
    expect(updates.checkForUpdateAsync).toHaveBeenCalledTimes(off ? 0 : 1);
  });

  it('checks again on return to the foreground, at most every 15 minutes', async () => {
    let now = 0;
    const updates = api(false);
    await draw(<UpdateBanner controller={createUpdateController(updates, { enabled: true, now: () => now })} />);
    await act(async () => {});
    await act(async () => { appStateListener?.('active'); });
    expect(updates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    now = FOREGROUND_CHECK_INTERVAL_MS;
    await act(async () => { appStateListener?.('background'); });
    await act(async () => { appStateListener?.('active'); });
    expect(updates.checkForUpdateAsync).toHaveBeenCalledTimes(2);
  });
});

describe('About update rows', () => {
  const info: AppInfo = { version: '0.1.0', build: '7', channel: 'preview', runtime: 'a'.repeat(40), update: 'abcdef12', createdAt: '2026-11-03T17:01:00Z' };

  it('shows the channel, runtime, and running update', async () => {
    await draw(<AboutUpdates info={info} controller={createUpdateController(api(false), { enabled: true })} />);
    expect(screen.getByText('preview')).toBeTruthy();
    expect(screen.getByText('a'.repeat(12))).toBeTruthy();
    expect(screen.getByText(/^abcdef12 · 3 Nov 2026/)).toBeTruthy();
  });

  it.each<[string, boolean, () => jest.Mocked<UpdatesApi>, string]>([
    ['up to date', true, () => api(false), 'Talyn is up to date'],
    ['a failure', true, () => ({ ...api(), checkForUpdateAsync: jest.fn(async () => { throw new Error('Network request failed'); }) }), 'Could not check for updates. Network request failed'],
    ['a ready update', true, () => api(), 'Update ready. Restart to apply it'],
  ])('checks on demand and shows %s', async (_name, enabled, make, label) => {
    const updates = make();
    await draw(<AboutUpdates info={info} controller={createUpdateController(updates, { enabled })} />);
    expect(screen.getByText('Updates install when Talyn restarts')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByText('Check for updates')); });
    expect(await screen.findByText(label)).toBeTruthy();
    expect(updates.reloadAsync).not.toHaveBeenCalled();
  });

  it('restarts from About when an update is ready', async () => {
    const updates = api();
    const controller = createUpdateController(updates, { enabled: true });
    await controller.check('manual');
    await draw(<AboutUpdates info={info} controller={controller} />);
    fireEvent.press(screen.getByText('Restart to update'));
    expect(updates.reloadAsync).toHaveBeenCalledTimes(1);
  });

  it('explains a build without updates', async () => {
    await draw(<AboutUpdates info={{ ...info, channel: null, runtime: null, update: null, createdAt: null }} controller={createUpdateController(api(), { enabled: false })} />);
    expect(screen.getByText('This build does not receive updates')).toBeTruthy();
    expect(screen.queryByText('Running update')).toBeNull();
  });
});
