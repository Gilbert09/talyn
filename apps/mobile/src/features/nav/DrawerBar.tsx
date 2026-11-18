import type { Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PickerSheet, type PickerItem } from '../../components/PickerSheet';
import type { Symbol } from '../../components/UI';
import { radius, sans, type, useTheme } from '../../theme/tokens';
import { useNavItems } from '../more/MoreScreen';
import { usePrCounts } from '../prs/counts';
import { pullsRoute, type PullsTab } from '../prs/lists';
import { badgeText, type DrawerTarget } from './model';

const PR_SEGMENTS: ReadonlyArray<{ tab: PullsTab; label: string; icon: Symbol }> = [
  { tab: 'mine', label: 'Pull requests', icon: { ios: 'arrow.triangle.pull', android: 'fork_right' } },
  { tab: 'reviews', label: 'Review requests', icon: { ios: 'eye', android: 'visibility' } },
  { tab: 'queue', label: 'Merge queue', icon: { ios: 'arrow.triangle.merge', android: 'merge' } },
];

const SIZE = 44;

/**
 * The drawer's bottom bar: New session, the three pull request lists with
 * their counts, and a menu with the other pages and Settings.
 */
export function DrawerBar({ active, go, onNewSession, history }: {
  active: DrawerTarget; go(href: Href): void; onNewSession?(): void; history: boolean;
}) {
  const c = useTheme();
  const counts = usePrCounts();
  const items = useNavItems();
  const [menu, setMenu] = useState(false);
  const pages: PickerItem[] = [
    ...items.map((item) => ({ key: item.key, label: item.label, icon: item.icon, selected: active === item.key, onPress: () => go(item.route) })),
    ...(history ? [{ key: 'history', label: 'History', icon: { ios: 'clock.arrow.circlepath', android: 'history' } as Symbol,
      selected: active === 'history', onPress: () => go('/history') }] : []),
  ];
  const settings: PickerItem = { key: 'settings', label: 'Settings', icon: { ios: 'gearshape', android: 'settings' },
    selected: active === 'settings', onPress: () => go('/settings') };
  const menuActive = active !== null && active !== 'home' && !active.startsWith('pulls:');

  return <View style={[styles.bar, { borderTopColor: c.border }]}>
    {onNewSession ? <Pressable accessibilityRole="button" accessibilityLabel="New session" accessibilityState={{ selected: active === 'home' }}
      onPress={onNewSession} style={({ pressed }) => [styles.round, { backgroundColor: c.primaryAction, opacity: pressed ? 0.8 : 1 }]}>
      <SymbolView name={{ ios: 'square.and.pencil', android: 'edit_square' }} size={18} tintColor={c.primaryText} />
    </Pressable> : null}
    <View style={[styles.segments, { backgroundColor: c.background, borderColor: c.border }]}>
      {PR_SEGMENTS.map((segment) => {
        const selected = active === `pulls:${segment.tab}`;
        const count = badgeText(counts[segment.tab]);
        return <Pressable key={segment.tab} accessibilityRole="button" accessibilityLabel={count ? `${segment.label}, ${count}` : segment.label}
          accessibilityState={{ selected }} onPress={() => go(pullsRoute(segment.tab))}
          style={({ pressed }) => [styles.segment, { backgroundColor: selected || pressed ? c.surface : 'transparent' }]}>
          <SymbolView name={segment.icon} size={16} tintColor={selected ? c.text : c.muted} />
          {count ? <Text style={[type.caption, sans(600), styles.count, { color: c.text }]}>{count}</Text> : null}
        </Pressable>;
      })}
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="More pages and Settings" accessibilityState={{ selected: menuActive }}
      onPress={() => setMenu(true)}
      style={({ pressed }) => [styles.round, { backgroundColor: menuActive || pressed ? c.surface : 'transparent' }]}>
      <SymbolView name={{ ios: 'gearshape', android: 'settings' }} size={20} tintColor={menuActive ? c.text : c.muted} />
    </Pressable>
    <PickerSheet visible={menu} title="More" onClose={() => setMenu(false)}
      sections={[{ key: 'pages', items: pages }, { key: 'settings', items: [settings] }].filter((section) => section.items.length)} />
  </View>;
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 8 },
  round: { width: SIZE, height: SIZE, borderRadius: radius.round, alignItems: 'center', justifyContent: 'center' },
  segments: { flex: 1, flexDirection: 'row', height: SIZE, padding: 3, gap: 2, borderRadius: radius.round, borderWidth: StyleSheet.hairlineWidth },
  segment: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: radius.round },
  count: { fontVariant: ['tabular-nums'] },
});
