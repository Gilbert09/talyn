import { SymbolView } from 'expo-symbols';
import { useContext, useSyncExternalStore, type PropsWithChildren } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { sans, type, useTheme, withAlpha } from '../theme/tokens';
import type { BackendHealth, BackendHealthSnapshot } from '../workflow/backendHealth';

const OK: BackendHealthSnapshot = { state: 'ok', checking: false, since: null };
const noop = () => () => {};

/** Web `SystemStatusBanner` copy, for a phone. */
export function healthCopy(state: BackendHealthSnapshot['state']): { title: string; detail: string } | null {
  if (state === 'unreachable') return { title: "Can't reach Talyn", detail: 'Retrying. What you see may be out of date.' };
  if (state === 'degraded') return { title: 'Talyn is having trouble on our side', detail: 'Retrying. Nothing for you to do.' };
  return null;
}

export function useBackendHealth(health: BackendHealth | undefined): BackendHealthSnapshot {
  return useSyncExternalStore(health?.subscribe ?? noop, health?.getSnapshot ?? (() => OK), health?.getSnapshot ?? (() => OK));
}

/**
 * The app-wide banner above every screen while the backend is down. It takes the top safe area itself
 * and hands the screens a top inset of zero, so the header below does not add a second status bar gap.
 */
export function BackendHealthFrame({ health, children }: PropsWithChildren<{ health: BackendHealth | undefined }>) {
  const snapshot = useBackendHealth(health);
  const insets = useContext(SafeAreaInsetsContext);
  const c = useTheme();
  const copy = healthCopy(snapshot.state);
  if (!copy || !insets) return <>{children}</>;
  const tint = snapshot.state === 'degraded' ? c.warning : c.muted;
  return <View style={styles.frame}>
    <View accessibilityRole="alert" accessibilityLiveRegion="polite"
      style={[styles.banner, { paddingTop: insets.top + 8, backgroundColor: snapshot.state === 'degraded' ? withAlpha(c.warning, 0.12) : c.surface,
        borderBottomColor: c.border }]}>
      <SymbolView name={snapshot.state === 'degraded' ? { ios: 'exclamationmark.icloud', android: 'sync_problem' } : { ios: 'icloud.slash', android: 'cloud_off' }}
        size={18} tintColor={tint} />
      <View style={styles.text}>
        <Text style={[type.body, sans(600), { color: c.text }]}>{copy.title}</Text>
        <Text style={[type.meta, { color: c.muted }]}>{copy.detail}</Text>
      </View>
      {snapshot.checking ? <ActivityIndicator size="small" color={c.muted} accessibilityLabel="Checking" />
        : <Pressable accessibilityRole="button" accessibilityLabel="Try now" onPress={() => health?.checkNow()} hitSlop={8}
          style={({ pressed }) => [styles.action, { borderColor: c.border, backgroundColor: pressed ? c.elevated : 'transparent' }]}>
          <Text style={[type.meta, sans(600), { color: c.text }]}>Try now</Text>
        </Pressable>}
    </View>
    <SafeAreaInsetsContext.Provider value={{ ...insets, top: 0 }}>{children}</SafeAreaInsetsContext.Provider>
  </View>;
}

const styles = StyleSheet.create({
  frame: { flex: 1 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth },
  text: { flex: 1, gap: 1 },
  action: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
});
