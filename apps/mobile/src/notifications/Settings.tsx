import { MOBILE_NOTIFICATION_CATEGORIES, type MobileNotificationPreferences } from '@talyn/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, Switch, Text, View } from 'react-native';

import { AppText, Button, Group, IconButton } from '../components/UI';
import { Status } from '../components/AuthControls';
import { sans, type, useTheme } from '../theme/tokens';
import type { NotificationController, PushState } from './controller';

export const notificationLabels = {
  session_update: 'Session updates', pr_review: 'PR reviews', ci_failure: 'CI failures',
  merge_ready: 'Ready to merge', human_gate: 'Human input',
};
const messages: Record<PushState, string> = {
  disabled: 'Notifications are off on this device or workspace.',
  loading: 'Loading notification settings.', ready: 'Notifications are on for this device.',
  denied: 'Notification permission is denied. You can allow notifications in your device settings.',
  unavailable: 'The notification provider or device configuration is not available.',
  failed: 'Notification registration or settings failed. Connect to the internet and try again.',
};
/** Edits wait this long so a run of toggles costs one save. */
export const SAVE_DEBOUNCE = 600;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const STEP = 30;

export function deviceTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
export function validPreferences(value: MobileNotificationPreferences) {
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }); } catch { return false; }
  return TIME.test(value.quietHours.start) && TIME.test(value.quietHours.end);
}
/** Move an `HH:MM` time by whole minutes, wrapping at midnight. */
export function shiftTime(value: string, minutes: number) {
  const [hours, mins] = TIME.test(value) ? value.split(':').map(Number) : [0, 0];
  const total = (((hours * 60 + mins + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function Toggle({ label, value, disabled, change, last = false }: { label: string; value: boolean; disabled: boolean; change: (value: boolean) => void; last?: boolean }) {
  const c = useTheme();
  return <View style={[styles.row, { borderBottomColor: last ? 'transparent' : c.border, opacity: disabled ? 0.45 : 1 }]}>
    <Text style={[type.body, { color: c.text, flex: 1 }]}>{label}</Text>
    <Switch trackColor={{ false: c.border, true: c.primaryAction }} thumbColor={c.elevated} accessibilityLabel={label} accessibilityState={{ disabled, checked: value }}
      hitSlop={{ top: 9, bottom: 9 }} value={value} disabled={disabled} onValueChange={change} />
  </View>;
}
function TimeStepper({ label, value, disabled, change }: { label: string; value: string; disabled: boolean; change: (value: string) => void }) {
  const c = useTheme();
  return <View style={[styles.row, { borderBottomColor: c.border, opacity: disabled ? 0.45 : 1 }]}>
    <Text style={[type.body, { color: c.text, flex: 1 }]}>{label}</Text>
    <View accessible accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ text: value }} accessibilityState={{ disabled }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => { if (!disabled) change(shiftTime(value, event.nativeEvent.actionName === 'increment' ? STEP : -STEP)); }}
      style={styles.stepper}>
      <IconButton label={`${label} earlier`} symbol={{ ios: 'minus', android: 'remove' }} size={16} disabled={disabled} onPress={() => change(shiftTime(value, -STEP))} />
      <Text style={[type.body, sans(600), { color: c.text, minWidth: 52, textAlign: 'center', fontVariant: ['tabular-nums'] }]}>{value}</Text>
      <IconButton label={`${label} later`} symbol={{ ios: 'plus', android: 'add' }} size={16} disabled={disabled} onPress={() => change(shiftTime(value, STEP))} />
    </View>
  </View>;
}

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed' | 'invalid';

export function NotificationSettings({ controller, offline, workspaceId }: {
  controller: Pick<NotificationController, 'loadWorkspaceSettings' | 'saveWorkspaceSettings'>;
  offline: boolean;
  workspaceId: string;
}) {
  const c = useTheme();
  const [state, setState] = useState<PushState>('loading');
  const [draft, setDraft] = useState<MobileNotificationPreferences | null>(null);
  const [save, setSave] = useState<SaveState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<MobileNotificationPreferences | null>(null);
  const revision = useRef(0);
  const loaded = useRef(false);
  const load = useCallback(async () => {
    const version = ++revision.current;
    setState('loading');
    const result = await controller.loadWorkspaceSettings(workspaceId);
    if (version !== revision.current) return;
    setState(result?.state ?? 'failed');
    loaded.current = Boolean(result?.preferences);
    setDraft(result?.preferences ?? null);
  }, [controller, workspaceId]);
  useEffect(() => {
    if (!offline && !loaded.current) void load();
  }, [load, offline]);
  useEffect(() => () => {
    revision.current++;
    clearTimeout(timer.current);
    if (pending.current) void controller.saveWorkspaceSettings(pending.current);
    pending.current = null;
  }, [controller]);

  const submit = async (next: MobileNotificationPreferences, requestPermission = false) => {
    const version = ++revision.current;
    clearTimeout(timer.current);
    pending.current = null;
    setSave('saving');
    const result = await controller.saveWorkspaceSettings(next, requestPermission);
    if (version !== revision.current) return;
    setSave(result?.preferences ? 'saved' : 'failed');
    if (result?.preferences) {
      setDraft(result.preferences);
      setState(result.state);
    }
  };
  const change = (next: MobileNotificationPreferences) => {
    revision.current++;
    setDraft(next);
    clearTimeout(timer.current);
    if (!validPreferences(next)) { pending.current = null; setSave('invalid'); return; }
    pending.current = next;
    setSave('pending');
    timer.current = setTimeout(() => { void submit(next); }, SAVE_DEBOUNCE);
  };
  const device = deviceTimezone();
  const disabled = offline || state === 'loading';
  const childDisabled = disabled || !draft?.enabled;
  return <View style={styles.content}>
    <Group title="Phone notifications" footer="Alerts show the session or pull request name and a short summary.">
      <View style={styles.block}>
        {offline ? <Status message="You are offline. Notification settings need an internet connection." /> :
          <Status message={messages[state]} loading={state === 'loading'} tone={state === 'ready' ? 'success' : ['denied', 'unavailable', 'failed'].includes(state) ? 'warning' : 'information'} />}
        {state === 'denied' ? <Button variant="secondary" size="sm" title="Open device notification settings" onPress={() => { void Linking.openSettings().catch(() => {}); }} /> : null}
        {draft && state !== 'ready' ? <Button size="sm" title="Enable notifications on this device" disabled={disabled || save === 'saving'}
          onPress={() => { void submit({ ...draft, enabled: true }, true); }} /> : null}
        {!draft && state === 'failed' ? <Button variant="secondary" size="sm" title="Retry notification settings" disabled={offline} onPress={() => { void load(); }} /> : null}
      </View>
    </Group>
    {draft ? <>
      <Group title="Workspace defaults" footer="Team spaces can override each alert type.">
        <Toggle label="Enable workspace notifications" value={draft.enabled} disabled={disabled} change={(enabled) => change({ ...draft, enabled })} />
        {MOBILE_NOTIFICATION_CATEGORIES.map((category, index) => <Toggle key={category} label={notificationLabels[category]} value={draft.categories[category]}
          disabled={childDisabled} last={index === MOBILE_NOTIFICATION_CATEGORIES.length - 1}
          change={(value) => change({ ...draft, categories: { ...draft.categories, [category]: value } })} />)}
      </Group>
      <Group title="Delivery" footer="Talyn on your computer shows the alert instead while you are using it.">
        <Toggle label="Only when I'm away from my computer" value={draft.onlyWhenAway} disabled={childDisabled} last
          change={(onlyWhenAway) => change({ ...draft, onlyWhenAway })} />
      </Group>
      <Group title="Quiet hours" footer={`Times use ${draft.timezone}.`}>
        <Toggle label="Quiet hours" value={draft.quietHours.enabled} disabled={childDisabled}
          change={(enabled) => change({ ...draft, quietHours: { ...draft.quietHours, enabled },
            // A schedule left on the server default reads in this device's timezone.
            ...(enabled && draft.timezone === 'UTC' && device !== 'UTC' ? { timezone: device } : {}) })} />
        <TimeStepper label="Quiet hours start" value={draft.quietHours.start} disabled={childDisabled || !draft.quietHours.enabled}
          change={(start) => change({ ...draft, quietHours: { ...draft.quietHours, start } })} />
        <TimeStepper label="Quiet hours end" value={draft.quietHours.end} disabled={childDisabled || !draft.quietHours.enabled}
          change={(end) => change({ ...draft, quietHours: { ...draft.quietHours, end } })} />
        <View style={[styles.row, { borderBottomColor: 'transparent', opacity: childDisabled ? 0.45 : 1 }]}>
          <View style={{ flex: 1 }}><Text style={[type.body, { color: c.text }]}>Timezone</Text>
            <AppText variant="meta" tone="muted" accessibilityLabel={`Notification timezone ${draft.timezone}`}>{draft.timezone}</AppText></View>
          {draft.timezone !== device ? <Button variant="quiet" size="sm" title="Use this device" accessibilityLabel={`Use this device's timezone, ${device}`}
            disabled={childDisabled} onPress={() => change({ ...draft, timezone: device })} /> : null}
        </View>
      </Group>
      {save === 'invalid' ? <Status message="Use a valid timezone and times in HH:MM format." /> : null}
      {save === 'failed' ? <>
        <Status message="Settings could not be saved." tone="warning" />
        <Button title="Retry save" variant="secondary" size="sm" disabled={disabled} onPress={() => { void submit(draft); }} />
      </> : null}
      {save === 'pending' || save === 'saving' || save === 'saved' ? <AppText variant="meta" tone="muted" accessibilityLiveRegion="polite" style={{ paddingHorizontal: 4 }}>
        {save === 'saved' ? 'Saved.' : 'Saving…'}</AppText> : null}
    </> : null}
  </View>;
}
const styles = StyleSheet.create({
  content: { gap: 16 },
  block: { gap: 10, paddingVertical: 12 },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 4 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 2 },
});
