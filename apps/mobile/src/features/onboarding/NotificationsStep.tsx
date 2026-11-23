import { useEffect, useSyncExternalStore } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { Status } from '../../components/AuthControls';
import { AppText, Button } from '../../components/UI';
import type { NotificationController, PushSnapshot } from '../../notifications/controller';
import { useTheme } from '../../theme/tokens';

const REASONS = [
  { key: 'human_gate', text: 'A session needs your input' },
  { key: 'pr_review', text: 'A review arrives on your pull request' },
  { key: 'ci_failure', text: 'CI fails' },
  { key: 'merge_ready', text: 'A pull request is ready to merge' },
] as const;

/**
 * The footer action for the notifications step. While the device can still
 * turn notifications on, the step asks for them. When they are on, or the
 * device cannot get them, the step only finishes.
 */
export function notificationStepAction(snapshot: PushSnapshot, offline: boolean): 'enable' | 'finish' {
  if (offline) return 'finish';
  return snapshot.state === 'ready' || snapshot.state === 'denied' || snapshot.state === 'unavailable' ? 'finish' : 'enable';
}

/** Turn notifications on: save the workspace opt-in and ask the system for permission. */
export function enableNotifications(controller: NotificationController) {
  return controller.getSnapshot().preferences ? controller.enableDevice() : controller.refresh();
}

export function useNotificationSnapshot(controller: NotificationController) {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

function StepStatus({ snapshot, offline }: { snapshot: PushSnapshot; offline: boolean }) {
  if (offline) return <Status message="You are offline. You can turn on notifications later in Settings." />;
  switch (snapshot.state) {
    case 'ready': return <Status message="Notifications are on for this device." tone="success" />;
    case 'loading': return <Status message="Turning on notifications." loading />;
    case 'denied': return <View style={styles.block}>
      <Status message="Notification permission is denied. You can allow notifications in your device settings." tone="warning" />
      <Button variant="secondary" size="sm" title="Open device notification settings" onPress={() => { void Linking.openSettings().catch(() => {}); }} />
    </View>;
    case 'unavailable': return <Status message="Notifications are not available on this device. You can continue without them." />;
    case 'failed': return <Status message="Notifications could not be turned on. Try again, or skip this step." tone="warning" />;
    default: return null;
  }
}

/**
 * The optional last onboarding step: why Talyn sends alerts, then one
 * explicit request for permission. Nothing is asked before the person taps.
 */
export function NotificationsStep({ controller, offline }: { controller: NotificationController; offline: boolean }) {
  const c = useTheme();
  const snapshot = useNotificationSnapshot(controller);
  const missing = !snapshot.preferences && snapshot.state === 'disabled';
  useEffect(() => { if (missing && !offline) void controller.refresh(); }, [controller, missing, offline]);
  return <View style={styles.content}>
    <AppText variant="meta" tone="muted">Talyn can tell you when work needs you, so you do not need to keep the app open.</AppText>
    <View style={styles.list}>
      {REASONS.map((reason) => <View key={reason.key} style={styles.reason}>
        <SymbolView name={{ ios: 'bell', android: 'notifications' }} size={16} tintColor={c.primaryAction} />
        <AppText style={styles.reasonText}>{reason.text}</AppText>
      </View>)}
    </View>
    <AppText variant="meta" tone="muted">Alerts use generic text. Private content stays in Talyn. You can change alerts and quiet hours in Settings.</AppText>
    <StepStatus snapshot={snapshot} offline={offline} />
  </View>;
}

const styles = StyleSheet.create({
  content: { gap: 14 },
  block: { gap: 10 },
  list: { gap: 10 },
  reason: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  reasonText: { flex: 1 },
});
