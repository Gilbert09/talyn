import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, type ComponentRef } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { type Symbol } from '../../components/UI';
import { radius, type, useTheme } from '../../theme/tokens';

export const FIND_PARTIAL_HINT = 'Searches loaded messages';
export const FIND_PARTIAL_DETAIL = 'Only loaded messages are searched. Scroll up to load earlier ones.';

function BarButton({ label, symbol, disabled = false, onPress }: { label: string; symbol: Symbol; disabled?: boolean; onPress(): void }) {
  const c = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} hitSlop={4}
    onPress={onPress} style={({ pressed }) => [styles.button, { backgroundColor: pressed ? c.surface : 'transparent', opacity: disabled ? 0.4 : 1 }]}>
    <SymbolView name={symbol} size={16} tintColor={c.text} />
  </Pressable>;
}

/**
 * Find in the conversation, like the web find bar. Return goes to the next match.
 * `focusKey` changes each time the person asks for the bar, so the field takes focus again.
 */
export function FindBar({ query, onChangeQuery, count, label, partial, focusKey, onPrevious, onNext, onClose }: {
  query: string; onChangeQuery(text: string): void; count: number; label: string;
  /** Older messages are not loaded, so the search does not cover them. */
  partial: boolean; focusKey: number; onPrevious(): void; onNext(): void; onClose(): void;
}) {
  const c = useTheme();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  useEffect(() => { input.current?.focus(); }, [focusKey]);
  return <View style={[styles.wrap, { borderColor: c.border, backgroundColor: c.background }]}>
    <View style={styles.row}>
      <View style={[styles.field, { borderColor: c.border, backgroundColor: c.elevated }]}>
        <SymbolView name={{ ios: 'magnifyingglass', android: 'search' }} size={14} tintColor={c.muted} />
        <TextInput ref={input} value={query} onChangeText={onChangeQuery} autoCapitalize="none" autoCorrect={false}
          accessibilityLabel="Find in transcript" placeholder="Find in transcript" placeholderTextColor={c.muted} selectionColor={c.primary}
          returnKeyType="search" submitBehavior="submit" onSubmitEditing={onNext}
          onKeyPress={(event) => { if (event.nativeEvent.key === 'Escape') onClose(); }}
          style={[styles.input, { color: c.text }]} />
        {label ? <Text accessibilityLiveRegion="polite" style={[type.caption, { color: c.muted }]}>{label}</Text> : null}
      </View>
      <BarButton label="Previous match" symbol={{ ios: 'chevron.up', android: 'keyboard_arrow_up' }} disabled={!count} onPress={onPrevious} />
      <BarButton label="Next match" symbol={{ ios: 'chevron.down', android: 'keyboard_arrow_down' }} disabled={!count} onPress={onNext} />
      <BarButton label="Close find" symbol={{ ios: 'xmark', android: 'close' }} onPress={onClose} />
    </View>
    {partial ? <Text accessible accessibilityLabel={FIND_PARTIAL_DETAIL} style={[type.caption, styles.hint, { color: c.muted }]}>{FIND_PARTIAL_HINT}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 6, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  field: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 8, minHeight: 36, marginRight: 4 },
  input: { ...type.body, flex: 1, paddingVertical: 6, paddingHorizontal: 0 },
  button: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  hint: { paddingHorizontal: 4 },
});
