import { MOBILE_NOTIFICATION_CATEGORIES, type MobileNotificationPreferences } from '@talyn/shared';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Linking, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { Status } from '../components/AuthControls';
import { ShellText, useShellColors } from '../components/ShellScreen';
import type { NotificationController, PushState } from './controller';

export const notificationLabels = {
  session_update: 'Session updates', pr_review: 'PR reviews', ci_failure: 'CI failures',
  merge_ready: 'Ready to merge', human_gate: 'Human input',
};
const messages: Record<PushState, string> = {
  disabled: 'Notifications are disabled on this device or workspace.',
  loading: 'Saving notification settings.', ready: 'Notifications are enabled on this device.',
  denied: 'Notification permission is denied. You can allow notifications in your device settings.',
  unavailable: 'The notification provider or device configuration is not available.',
  failed: 'Notification registration or settings failed. Connect to the internet and try again.',
};

function Toggle({ label, value, disabled, change }: { label: string; value: boolean; disabled: boolean; change: (value: boolean) => void }) {
  const colors = useShellColors();
  return <View style={styles.row}><Text style={{ color: colors.text, fontSize: 17, flex: 1 }}>{label}</Text>
    <Switch accessibilityLabel={label} accessibilityState={{ disabled, checked: value }} hitSlop={{ top: 9, bottom: 9 }}
      value={value} disabled={disabled} onValueChange={change} />
  </View>;
}
export function NotificationSettings({ controller, offline }: { controller: NotificationController; offline: boolean }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [draft, setDraft] = useState<MobileNotificationPreferences | null>(snapshot.preferences);
  const [invalid, setInvalid] = useState(false);
  const colors = useShellColors();
  useEffect(() => { setDraft(snapshot.preferences); }, [snapshot.preferences]);
  const disabled = offline || snapshot.state === 'loading';
  const save = () => {
    if (!draft) return;
    try {
      new Intl.DateTimeFormat('en', { timeZone: draft.timezone });
      if (![draft.quietHours.start, draft.quietHours.end].every((value) => /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value))) throw new Error();
      setInvalid(false); void controller.save(draft);
    } catch { setInvalid(true); }
  };
  const inputStyle = [styles.input, { color: colors.text, borderColor: colors.muted }];
  return <View style={styles.content}>
    <Text accessibilityRole="header" style={{ color: colors.text, fontSize: 24, fontWeight: '600' }}>Notifications</Text>
    <ShellText>Get a generic alert when a session needs attention or a pull request changes. Private content stays in Talyn.</ShellText>
    <ShellText>Enable notifications here to see the device permission prompt. Every workflow works without notifications.</ShellText>
    <Status message={messages[snapshot.state]} loading={snapshot.state === 'loading'} />
    {snapshot.state === 'denied' ? <Button title="Open device notification settings" onPress={() => { void Linking.openSettings().catch(() => {}); }} /> : null}
    {offline ? <Status message="You are offline. Notification settings need an internet connection." /> : null}
    {!draft ? <><ShellText>Choose an accessible workspace to load notification settings.</ShellText>
      <Button title="Retry notification settings" disabled={disabled} onPress={() => { void controller.refresh(); }} /></> : <>
      <Button title="Enable notifications on this device" disabled={disabled} onPress={() => { void controller.enableDevice(); }} />
      <Toggle label="Enable workspace notifications" value={draft.enabled} disabled={disabled} change={(enabled) => setDraft({ ...draft, enabled })} />
      {MOBILE_NOTIFICATION_CATEGORIES.map((category) => <Toggle key={category} label={notificationLabels[category]} value={draft.categories[category]}
        disabled={disabled || !draft.enabled} change={(value) => setDraft({ ...draft, categories: { ...draft.categories, [category]: value } })} />)}
      <Toggle label="Quiet hours" value={draft.quietHours.enabled} disabled={disabled || !draft.enabled}
        change={(enabled) => setDraft({ ...draft, quietHours: { ...draft.quietHours, enabled } })} />
      <ShellText>Quiet hours use 24-hour time in the timezone below.</ShellText>
      <TextInput accessibilityLabel="Quiet hours start" value={draft.quietHours.start} editable={!disabled} autoCapitalize="none"
        style={inputStyle} onChangeText={(start) => setDraft({ ...draft, quietHours: { ...draft.quietHours, start } })} />
      <TextInput accessibilityLabel="Quiet hours end" value={draft.quietHours.end} editable={!disabled} autoCapitalize="none"
        style={inputStyle} onChangeText={(end) => setDraft({ ...draft, quietHours: { ...draft.quietHours, end } })} />
      <TextInput accessibilityLabel="Notification timezone" value={draft.timezone} editable={!disabled} autoCapitalize="none" autoCorrect={false}
        style={inputStyle} onChangeText={(timezone) => setDraft({ ...draft, timezone })} />
      <Toggle label="Sensitive preview preference" value={draft.sensitivePreview} disabled={disabled}
        change={(sensitivePreview) => setDraft({ ...draft, sensitivePreview })} />
      <ShellText>This preview choice is reserved for a later version. All alerts currently use generic text.</ShellText>
      {invalid ? <Status message="Use a valid timezone and times in HH:MM format." /> : null}
      <Button title="Save notification settings" disabled={disabled} onPress={save} />
    </>}
  </View>;
}
const styles = StyleSheet.create({
  content: { gap: 16 }, row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 },
  input: { minHeight: 48, borderWidth: 1, padding: 12, borderRadius: 8, fontSize: 17 },
});
