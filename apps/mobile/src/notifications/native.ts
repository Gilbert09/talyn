import { version } from '../../package.json';
import { MOBILE_NOTIFICATION_CATEGORIES } from '@talyn/shared';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { MobileConfig } from '../config';
import type { NotificationController, PushDevice } from './controller';

export const channelNames = {
  session_update: 'Session updates', pr_review: 'PR reviews', ci_failure: 'CI failures',
  merge_ready: 'Ready to merge', human_gate: 'Human input',
};
export const installationKey = (namespace: string, user: string) => `${namespace}.push.${user}`;

export async function createNotificationChannels() {
  if (Platform.OS !== 'android') return;
  await Promise.all(MOBILE_NOTIFICATION_CATEGORIES.map((category) => Notifications.setNotificationChannelAsync(category, {
    name: channelNames[category], importance: Notifications.AndroidImportance.DEFAULT,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    sound: 'default', enableVibrate: true,
  })));
}

export function notificationDevice(config: MobileConfig, namespace: string): PushDevice {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  return {
    available: () => Device.isDevice && ['ios', 'android'].includes(Platform.OS) &&
      typeof projectId === 'string' && /^[0-9a-f-]{36}$/i.test(projectId),
    channels: createNotificationChannels,
    async permission(request) {
      let result = await Notifications.getPermissionsAsync();
      if (!result.granted && request && result.canAskAgain) result = await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: false, allowSound: true },
      });
      return result.granted;
    },
    async token() { return (await Notifications.getExpoPushTokenAsync({ projectId })).data; },
    metadata: () => ({
      platform: Platform.OS === 'ios' ? 'ios' : 'android', environment: config.environment,
      appIdentity: (Platform.OS === 'ios' ? Constants.expoConfig?.ios?.bundleIdentifier : Constants.expoConfig?.android?.package) ?? '',
      appVersion: Constants.expoConfig?.version ?? version,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
    async installation(user, create) {
      const key = installationKey(namespace, user);
      const existing = await SecureStore.getItemAsync(key);
      if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
      if (!create) return null;
      const id = Crypto.randomUUID();
      await SecureStore.setItemAsync(key, id, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
      return id;
    },
    clearInstallation: (user) => SecureStore.deleteItemAsync(installationKey(namespace, user)),
  };
}

export function bindNativeNotifications(controller: NotificationController) {
  let disposed = false;
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const show = !disposed && controller.shouldAlert(notification.request.content.data);
      return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: false, shouldSetBadge: false };
    },
  });
  const receive = (response: Notifications.NotificationResponse | null) => {
    if (disposed || !response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    controller.receiveTap(response.notification.request.content.data);
    Notifications.clearLastNotificationResponse();
  };
  const taps = Notifications.addNotificationResponseReceivedListener(receive);
  const tokens = Notifications.addPushTokenListener(() => controller.tokenChanged());
  receive(Notifications.getLastNotificationResponse());
  return () => { disposed = true; taps.remove(); tokens.remove(); Notifications.setNotificationHandler(null); };
}
