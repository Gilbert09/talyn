import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { NotificationController } from '../notifications/controller';
import { bindNativeNotifications, createNotificationChannels, notificationDevice } from '../notifications/native';

const deviceToken = (data: string) => ({ type: 'android' as const, data });

jest.mock('expo-constants', () => ({
  expoConfig: { extra: { eas: { projectId: '10000000-0000-4000-8000-000000000001' } },
    ios: { bundleIdentifier: 'dev.example.mobile' }, android: { package: 'dev.example.mobile' }, version: '0.1.0' },
}));
jest.mock('expo-device', () => ({ isDevice: true }));
jest.mock('expo-crypto', () => ({ randomUUID: () => '20000000-0000-4000-8000-000000000002' }));
jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3 }, AndroidNotificationVisibility: { PRIVATE: 0 }, DEFAULT_ACTION_IDENTIFIER: 'default',
  setNotificationChannelAsync: jest.fn(async () => {}), getPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExpoPushToken[synthetic-device-value]' })),
  getDevicePushTokenAsync: jest.fn(async () => ({ type: 'android', data: 'synthetic-fcm-token' })),
  setNotificationHandler: jest.fn(), addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponse: jest.fn(() => null), clearLastNotificationResponse: jest.fn(),
}));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only', getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}), deleteItemAsync: jest.fn(async () => {}),
}));
const config = { environment: 'development' as const, apiOrigin: 'https://api.example.test', supabaseUrl: 'https://auth.example.test',
  supabaseKey: 'public', callbackUrl: 'talyn-mobile-development://auth/callback' };

afterEach(() => jest.restoreAllMocks());
describe('native push binding', () => {
  it('creates five meaningful Android channels with private lock-screen visibility', async () => {
    jest.replaceProperty(Platform, 'OS', 'android'); await createNotificationChannels();
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledTimes(5);
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('human_gate', expect.objectContaining({ name: 'Human input', lockscreenVisibility: 0 }));
  });
  it('requests only the required alert and sound permissions after opt-in', async () => {
    const device = notificationDevice(config, 'environment');
    expect(await device.permission(false)).toBe(false); expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(await device.permission(true)).toBe(true);
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledWith({ ios: { allowAlert: true, allowBadge: false, allowSound: true } });
  });
  it('uses the public EAS project and stores only the installation ID securely', async () => {
    const device = notificationDevice(config, 'environment'); expect(device.available()).toBe(true);
    await device.token(); await device.installation('alice', true);
    expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: '10000000-0000-4000-8000-000000000001', devicePushToken: deviceToken('synthetic-fcm-token'),
    });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('environment.push.alice', '20000000-0000-4000-8000-000000000002', { keychainAccessible: 'device-only' });
    expect(JSON.stringify(jest.mocked(SecureStore.setItemAsync).mock.calls)).not.toContain('ExpoPushToken');
  });
  it('binds cold, warm, foreground, and rotation events and releases listeners', async () => {
    const controller = { receiveTap: jest.fn(), shouldAlert: jest.fn(() => false), tokenChanged: jest.fn() };
    const response = { actionIdentifier: 'default', notification: { request: { content: { data: { schemaVersion: 1 } } } } };
    jest.mocked(Notifications.getLastNotificationResponse).mockReturnValueOnce(response as never);
    const dispose = bindNativeNotifications(controller as unknown as NotificationController);
    expect(controller.receiveTap).toHaveBeenCalledWith({ schemaVersion: 1 });
    expect(Notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    const handle = jest.mocked(Notifications.setNotificationHandler).mock.calls[0][0]!;
    expect(await handle.handleNotification(response.notification as never)).toMatchObject({ shouldShowBanner: false, shouldPlaySound: false });
    const warm = jest.mocked(Notifications.addNotificationResponseReceivedListener).mock.calls[0][0]; warm(response as never);
    const rotate = jest.mocked(Notifications.addPushTokenListener).mock.calls[0][0]; rotate(deviceToken('rotated-fcm-token'));
    expect(controller.receiveTap).toHaveBeenCalledTimes(2); expect(controller.tokenChanged).toHaveBeenCalledTimes(1);
    dispose(); expect(Notifications.setNotificationHandler).toHaveBeenLastCalledWith(null);
  });
  it('re-registers only when the device token changes, not on every fetch', async () => {
    const controller = { receiveTap: jest.fn(), shouldAlert: jest.fn(() => false), tokenChanged: jest.fn() };
    const dispose = bindNativeNotifications(controller as unknown as NotificationController);
    const event = jest.mocked(Notifications.addPushTokenListener).mock.calls.at(-1)![0];
    jest.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue(deviceToken('fetched-fcm-token'));
    await notificationDevice(config, 'environment').token();
    // Android emits the event for the fetch itself: the same token is not a rotation.
    event(deviceToken('fetched-fcm-token')); event(deviceToken('fetched-fcm-token'));
    expect(controller.tokenChanged).not.toHaveBeenCalled();
    event(deviceToken('new-fcm-token'));
    expect(controller.tokenChanged).toHaveBeenCalledTimes(1);
    event(deviceToken('new-fcm-token'));
    expect(controller.tokenChanged).toHaveBeenCalledTimes(1);
    dispose();
  });
});
