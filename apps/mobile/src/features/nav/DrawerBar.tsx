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
const FAB_SIZE = 52;
const FAB_GAP = 12;
/** The space that a list under the New session button keeps free at its end, so its last row can scroll clear of the button. */
export const NEW_SESSION_CLEARANCE = FAB_SIZE + FAB_GAP * 2;

/** The drawer's bottom bar: the three pull request lists with their counts, across the full width. */
export function DrawerBar({ active, go }: { active: DrawerTarget; go(href: Href): void }) {
  const c = useTheme();
  const counts = usePrCounts();
  return <View style={[styles.bar, { borderTopColor: c.border }]}>
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
  </View>;
}

/** The gear button beside search. It opens a menu with the other pages and Settings. */
export function DrawerMenuButton({ active, go, history }: { active: DrawerTarget; go(href: Href): void; history: boolean }) {
  const c = useTheme();
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

  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="More pages and Settings" accessibilityState={{ selected: menuActive }}
      hitSlop={4} onPress={() => setMenu(true)}
      style={({ pressed }) => [styles.menuButton, { backgroundColor: menuActive || pressed ? c.surface : 'transparent' }]}>
      <SymbolView name={{ ios: 'gearshape', android: 'settings' }} size={20} tintColor={menuActive ? c.text : c.muted} />
    </Pressable>
    <PickerSheet visible={menu} title="More" onClose={() => setMenu(false)}
      sections={[{ key: 'pages', items: pages }, { key: 'settings', items: [settings] }].filter((section) => section.items.length)} />
  </>;
}

/** The New session button. It floats at the right, just above the bottom bar. */
export function NewSessionButton({ selected, onPress }: { selected: boolean; onPress(): void }) {
  const c = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel="New session" accessibilityState={{ selected }} onPress={onPress}
    style={({ pressed }) => [styles.fab, { backgroundColor: c.primaryAction, opacity: pressed ? 0.85 : 1 }]}>
    <SymbolView name={{ ios: 'square.and.pencil', android: 'edit_square' }} size={22} tintColor={c.primaryText} />
  </Pressable>;
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 8 },
  segments: { flexDirection: 'row', height: SIZE, padding: 3, gap: 2, borderRadius: radius.round, borderWidth: StyleSheet.hairlineWidth },
  segment: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: radius.round },
  count: { fontVariant: ['tabular-nums'] },
  menuButton: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  fab: { position: 'absolute', right: 16, bottom: FAB_GAP, width: FAB_SIZE, height: FAB_SIZE, borderRadius: radius.round,
    alignItems: 'center', justifyContent: 'center',
    elevation: 4, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } },
});
