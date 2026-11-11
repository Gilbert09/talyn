import type { PRRow } from '@talyn/client/native';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Symbol } from '../../components/UI';
import { radius, sans, useTheme, withAlpha } from '../../theme/tokens';
import { autoKeepLabel, queueStateLabel } from './actions';

const QUEUE_ICON: Symbol = { ios: 'list.number', android: 'format_list_numbered' };
const KEEP_ICON: Symbol = { ios: 'shield.lefthalf.filled', android: 'shield' };
const ON_ICON: Symbol = { ios: 'checkmark', android: 'check' };

/** The text a toggle wears: its name when off, its state when on. */
export function queueToggleText(row: Pick<PRRow, 'mergeQueued' | 'mergeQueue'>): string {
  if (!row.mergeQueued) return 'Merge queue';
  const label = queueStateLabel(row);
  // "Fixing" alone does not say what is fixing; the queue labels already start with Queue.
  return /^Queue/.test(label) ? label : `Queue: ${label.toLowerCase()}`;
}
export function keepToggleText(row: Pick<PRRow, 'autoKeepMergeable' | 'autoMergeState'>): string {
  if (!row.autoKeepMergeable) return 'Keep mergeable';
  return autoKeepLabel(row) === 'On' ? 'Keeping mergeable' : 'Keep mergeable paused';
}

/**
 * A switch drawn as a button: an outline when off, a tinted fill with a check when on.
 * Two of these sit on one line instead of two full rows of title, state and switch.
 */
export function ToggleButton({ label, text, icon, value, disabled, onChange }: {
  label: string; text: string; icon: Symbol; value: boolean; disabled: boolean; onChange(next: boolean): void;
}) {
  const c = useTheme();
  const tint = value ? c.primaryAction : c.text;
  return <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityValue={{ text }}
    accessibilityState={{ checked: value, disabled }} disabled={disabled} onPress={() => onChange(!value)} hitSlop={4}
    style={({ pressed }) => [styles.button, {
      borderColor: value ? withAlpha(c.primaryAction, 0.45) : c.border,
      backgroundColor: value ? withAlpha(c.primaryAction, c.mode === 'dark' ? 0.18 : 0.1) : pressed ? c.surface : 'transparent',
      opacity: disabled ? 0.5 : 1,
    }]}>
    <SymbolView name={value ? ON_ICON : icon} size={14} tintColor={tint} />
    <Text numberOfLines={1} style={[styles.text, { color: tint }]}>{text}</Text>
  </Pressable>;
}

export function AutomationToggles({ row, queue, autoKeep, disabled, queueDisabled = disabled, onQueue, onAutoKeep }: {
  row: PRRow; queue: boolean; autoKeep: boolean; disabled: boolean; queueDisabled?: boolean;
  onQueue(next: boolean): void; onAutoKeep(next: boolean): void;
}) {
  if (!queue && !autoKeep) return null;
  return <View style={styles.row}>
    {queue ? <ToggleButton label="Merge queue" text={queueToggleText(row)} icon={QUEUE_ICON} value={row.mergeQueued}
      disabled={queueDisabled} onChange={onQueue} /> : null}
    {autoKeep ? <ToggleButton label="Keep mergeable" text={keepToggleText(row)} icon={KEEP_ICON} value={row.autoKeepMergeable}
      disabled={disabled} onChange={onAutoKeep} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth, maxWidth: '100%' },
  text: { fontSize: 14, lineHeight: 19, ...sans(500), flexShrink: 1 },
});
