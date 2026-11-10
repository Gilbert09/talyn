import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { IconButton } from '../../components/UI';
import { radius, sans, type, useTheme, withAlpha } from '../../theme/tokens';

export const SEARCH_PLACEHOLDER = 'Search title, repo or #number';

/**
 * One neutral chip style for the whole bar: an outline when off, a light
 * primary tint when on. A `menu` chip opens a picker and shows a chevron.
 */
export function FilterChip({ label, active = false, count, menu = false, icon, onPress, accessibilityLabel }: {
  label: string; active?: boolean; count?: number; menu?: boolean; icon?: 'clear'; onPress(): void; accessibilityLabel?: string;
}) {
  const c = useTheme();
  const foreground = active ? c.primaryAction : c.text;
  const shown = count !== undefined && count > 0 ? count : null;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? (shown !== null ? `${label}, ${shown}` : label)}
    accessibilityState={menu ? undefined : { selected: active }} onPress={onPress} hitSlop={4}
    style={({ pressed }) => [styles.chip, {
      borderColor: active ? withAlpha(c.primaryAction, 0.45) : c.border,
      backgroundColor: active ? withAlpha(c.primaryAction, c.mode === 'dark' ? 0.18 : 0.1) : pressed ? c.surface : 'transparent',
    }]}>
    {icon === 'clear' ? <SymbolView name={{ ios: 'xmark', android: 'close' }} size={11} tintColor={c.muted} /> : null}
    <Text numberOfLines={1} style={[styles.chipText, { color: foreground }]}>{label}</Text>
    {shown !== null ? <Text style={[styles.chipCount, { color: active ? c.primaryAction : c.muted }]}>{shown}</Text> : null}
    {menu ? <SymbolView name={{ ios: 'chevron.down', android: 'expand_more' }} size={11} tintColor={active ? c.primaryAction : c.muted} /> : null}
  </Pressable>;
}

/** A single-line search field with a clear button, then one row of chips that scrolls sideways. */
export function FilterBar({ search, onSearch, children }: { search: string; onSearch(value: string): void; children?: ReactNode }) {
  const c = useTheme();
  return <View style={styles.bar}>
    <View style={[styles.search, { backgroundColor: c.surface }]}>
      <SymbolView name={{ ios: 'magnifyingglass', android: 'search' }} size={15} tintColor={c.muted} />
      <TextInput value={search} onChangeText={onSearch} placeholder={SEARCH_PLACEHOLDER} accessibilityLabel={SEARCH_PLACEHOLDER}
        placeholderTextColor={c.muted} selectionColor={c.primary} autoCapitalize="none" autoCorrect={false} returnKeyType="search"
        style={[styles.searchInput, { color: c.text }]} />
      {search ? <IconButton label="Clear search" symbol={{ ios: 'xmark.circle.fill', android: 'cancel' }} size={15} tone="muted" onPress={() => onSearch('')} /> : null}
    </View>
    {children ? <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.chips}>{children}</ScrollView> : null}
  </View>;
}

const styles = StyleSheet.create({
  bar: { gap: 8, paddingBottom: 6 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 10, borderRadius: radius.pill, minHeight: 38 },
  searchInput: { flex: 1, ...type.meta, fontSize: 14, paddingVertical: 8 },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 4 },
  chip: { minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth, maxWidth: 220 },
  chipText: { fontSize: 13, lineHeight: 18, ...sans(500), flexShrink: 1 },
  chipCount: { fontSize: 12, lineHeight: 16, ...sans(500), fontVariant: ['tabular-nums'] },
});
