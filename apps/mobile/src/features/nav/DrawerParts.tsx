import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppText } from '../../components/UI';
import { sans, type, useTheme } from '../../theme/tokens';

export function Heading({ title, trailing }: { title: string; trailing?: ReactNode }) {
  return <View style={partStyles.heading}>
    <AppText accessibilityRole="header" variant="section" tone="muted" style={{ flex: 1 }}>{title}</AppText>
    {trailing}
  </View>;
}

/** A repository's name. Tap it to hide or show its sessions. It goes bold when it hides one that needs the person. */
export function GroupHeader({ repo, expanded, hidden, attention, onToggle }: { repo: string; expanded: boolean; hidden: number; attention: boolean; onToggle(): void }) {
  const c = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={repo} accessibilityState={{ expanded }}
    accessibilityHint={expanded ? 'Hides the sessions of this repository.' : 'Shows the sessions of this repository.'}
    onPress={onToggle} style={partStyles.group}>
    <Text numberOfLines={1} style={[type.caption, sans(attention ? 600 : 500), { color: attention ? c.text : c.muted, flexShrink: 1 }]}>{repo}</Text>
    <SymbolView name={expanded ? { ios: 'chevron.down', android: 'expand_more' } : { ios: 'chevron.right', android: 'chevron_right' }}
      size={11} tintColor={c.muted} />
    <View style={{ flex: 1 }} />
    {hidden ? <Text style={[type.caption, { color: c.muted, fontVariant: ['tabular-nums'] }]}>{hidden}</Text> : null}
  </Pressable>;
}

export const partStyles = StyleSheet.create({
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32, paddingHorizontal: 6, paddingTop: 12 },
  group: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32, paddingHorizontal: 6, paddingTop: 6 },
});
