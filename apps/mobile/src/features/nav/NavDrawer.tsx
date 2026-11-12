import type { Workbench } from '@talyn/shared';
import { useGlobalSearchParams, usePathname, useRouter, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionStateIcon } from '../../components/Status';
import { AppText, IconButton, Spinner, type Symbol } from '../../components/UI';
import { workbenchState } from '../../lib/status';
import { useNow } from '../../lib/time';
import { HOME, newWorkRoute, threadRoute } from '../../navigation/routes';
import { radius, sans, type, useTheme } from '../../theme/tokens';
import { workbenchTitle } from '../../workflow/model';
import { useNavItems } from '../more/MoreScreen';
import { usePrCounts } from '../prs/counts';
import { pullsRoute, type PullsTab } from '../prs/lists';
import { useSessionMenu } from '../sessions/SessionMenu';
import { WorkbenchRow } from '../sessions/WorkbenchRow';
import { useActiveContext } from '../spaces/context';
import { ContextSwitcher } from './ContextSwitcher';
import { GroupHeader, Heading } from './DrawerParts';
import { SessionStarters } from './SessionStarters';
import { SpaceDrawerList } from './SpaceDrawer';
import { useDrawerWork } from './data';
import { activeTarget, badgeText, drawerEntries, toggled, type DrawerEntry, type DrawerTarget } from './model';

const LIST_LINKS = new Set(['/sessions', '/threads']);

const PR_LINKS: ReadonlyArray<{ tab: PullsTab; label: string; icon: Symbol }> = [
  { tab: 'mine', label: 'Pull requests', icon: { ios: 'arrow.triangle.pull', android: 'fork_right' } },
  { tab: 'reviews', label: 'Review requests', icon: { ios: 'eye', android: 'visibility' } },
  { tab: 'queue', label: 'Merge queue', icon: { ios: 'arrow.triangle.merge', android: 'merge' } },
];

/**
 * The navigation drawer, like web's sidebar: workspace, New session, search,
 * the session lists, then the app pages and Settings.
 */
export function NavDrawer({ close }: { close(): void }) {
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const { tab } = useGlobalSearchParams<{ tab?: string }>();
  const active = activeTarget(pathname, tab);
  const { features, offered, sessions, threads, personal } = useDrawerWork();
  const [query, setQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedThreads, setCollapsedThreads] = useState<ReadonlySet<string>>(() => new Set());
  const entries = useMemo(() => offered ? drawerEntries({ sessions: personal.sessions, threads: personal.threads, query, collapsedGroups, collapsedThreads }) : [],
    [offered, personal, query, collapsedGroups, collapsedThreads]);
  const now = useNow();
  const menu = useSessionMenu();
  const place = useActiveContext();
  const owned = useMemo(() => new Map([...(sessions.data ?? []), ...(threads.data ?? [])].map((item) => [item.id, item])),
    [sessions.data, threads.data]);

  // Leaving home closes the drawer, so Back comes back to the screen and not to the open drawer.
  // The old list links open the drawer themselves, so they must not close it.
  useEffect(() => { if (pathname !== HOME && !LIST_LINKS.has(pathname)) close(); }, [pathname, close]);

  const go = (href: Href) => router.push(href);
  const goHome = () => { if (pathname === HOME) close(); else router.navigate(HOME); };

  const render = ({ item }: { item: DrawerEntry }) => {
    switch (item.type) {
      case 'heading': return <Heading title={item.title}
        trailing={item.section === 'threads' ? <IconButton label="New thread" size={16} symbol={{ ios: 'plus', android: 'add' }}
          onPress={() => go(newWorkRoute('thread'))} /> : undefined} />;
      case 'group': return <GroupHeader repo={item.repo} expanded={item.expanded} hidden={item.hidden} attention={item.attention}
        onToggle={() => setCollapsedGroups((set) => toggled(set, item.repo))} />;
      case 'thread': return <ThreadRow item={item.item} expanded={item.expanded} childCount={item.childCount} running={item.running}
        onToggle={() => setCollapsedThreads((set) => toggled(set, item.item.id))} onLongPress={menu.open} />;
      case 'row': return <View style={item.indent ? styles.indent : undefined}>
        <WorkbenchRow item={item.item} now={now} divider={false} onLongPress={menu.open} />
      </View>;
      case 'notice': return <AppText variant="meta" tone="muted" style={styles.notice}>{item.text}</AppText>;
      case 'starters': return <SessionStarters />;
      case 'loading': return <View accessibilityState={{ busy: true }} style={styles.loading}><Spinner /></View>;
    }
  };

  const pages = <AppPages active={active} go={go} history={offered} />;
  // The pull request lists stay pinned. The other pages scroll after the lists, so a phone keeps room for sessions.
  // With no list to scroll (still loading, or no sessions on the account) every page stays pinned.
  const space = place.active?.space ?? null;
  const pinnedAll = features === null || place.context.kind === 'pending' || (!offered && !space);
  const footer = pinnedAll ? undefined : <View style={styles.footerPages}><AppPages active={active} go={go} history={offered} withPullRequests={false} /></View>;
  return <View style={[styles.drawer, { backgroundColor: c.paper, paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 8) }]}>
    <View style={styles.top}>
      <ContextSwitcher state={place} />
      {offered ? <NavRow label="New session" icon={{ ios: 'square.and.pencil', android: 'edit_square' }} active={active === 'home'} onPress={goHome} /> : null}
      {offered ? <SearchField value={query} onChange={setQuery} /> : null}
    </View>
    {features === null || place.context.kind === 'pending' ? <View style={[styles.loading, { flex: 1 }]}><Spinner /></View>
      : space ? <SpaceDrawerList key={space.id} space={space} owned={owned} query={query} onLongPress={menu.open} footer={footer}
        onNewThread={offered ? () => go(newWorkRoute('thread')) : undefined} />
      : !offered ? <View style={{ flex: 1 }} /> : <FlatList data={entries} keyExtractor={(entry) => entry.key} renderItem={render} style={{ flex: 1 }}
        accessibilityLabel="Sessions and threads" contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
        initialNumToRender={20} maxToRenderPerBatch={16} windowSize={9}
        ListFooterComponent={footer} />}
    <View style={[styles.pinned, { borderTopColor: c.border }]}>{pinnedAll ? pages : <PullRequestLinks active={active} go={go} />}</View>
    <View style={[styles.settings, { borderTopColor: c.border }]}>
      <NavRow label="Settings" icon={{ ios: 'gearshape', android: 'settings' }} active={active === 'settings'} onPress={() => go('/settings')} />
    </View>
    {menu.elements}
  </View>;
}

/** The app pages under the lists: the pull request lists with counts, then the pages the account may see. */
function AppPages({ active, go, history, withPullRequests = true }: { active: DrawerTarget; go(href: Href): void; history: boolean; withPullRequests?: boolean }) {
  const items = useNavItems();
  return <View style={styles.pages}>
    {withPullRequests ? <PullRequestLinks active={active} go={go} /> : null}
    {items.map((item) => <NavRow key={item.key} label={item.label} icon={item.icon} active={active === item.key} onPress={() => go(item.route)} />)}
    {history ? <NavRow label="History" icon={{ ios: 'clock.arrow.circlepath', android: 'history' }} active={active === 'history'} onPress={() => go('/history')} /> : null}
  </View>;
}

/** Pull requests, Review requests and Merge queue, each with its count. */
export function PullRequestLinks({ active, go }: { active: DrawerTarget; go(href: Href): void }) {
  const counts = usePrCounts();
  return <>
    {PR_LINKS.map((link) => <NavRow key={link.tab} label={link.label} icon={link.icon} badge={counts[link.tab]}
      active={active === `pulls:${link.tab}`} onPress={() => go(pullsRoute(link.tab))} />)}
  </>;
}

export function NavRow({ label, icon, badge, active = false, onPress }: { label: string; icon: Symbol; badge?: number | null; active?: boolean; onPress(): void }) {
  const c = useTheme();
  const [pressed, setPressed] = useState(false);
  const count = badgeText(badge);
  return <Pressable accessibilityRole="button" accessibilityLabel={count ? `${label}, ${count}` : label} accessibilityState={{ selected: active }}
    onPress={onPress} onPressIn={() => setPressed(true)} onPressOut={() => setPressed(false)}
    style={[styles.navRow, { backgroundColor: active ? c.surface : pressed ? c.surface : 'transparent' }]}>
    <SymbolView name={icon} size={18} tintColor={active ? c.text : c.muted} />
    <Text numberOfLines={1} style={[type.body, sans(active ? 600 : 500), { color: c.text, flex: 1 }]}>{label}</Text>
    {count ? <View style={[styles.badge, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text style={[type.caption, { color: c.text, fontVariant: ['tabular-nums'] }]}>{count}</Text>
    </View> : null}
  </Pressable>;
}

function SearchField({ value, onChange }: { value: string; onChange(value: string): void }) {
  const c = useTheme();
  return <View style={[styles.search, { backgroundColor: c.background, borderColor: c.border }]}>
    <SymbolView name={{ ios: 'magnifyingglass', android: 'search' }} size={16} tintColor={c.muted} />
    <TextInput accessibilityLabel="Search sessions and threads" placeholder="Search" placeholderTextColor={c.muted}
      selectionColor={c.primary} value={value} onChangeText={onChange} autoCapitalize="none" autoCorrect={false} returnKeyType="search"
      style={[type.body, styles.searchInput, { color: c.text }]} />
    {value ? <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={8} onPress={() => onChange('')}>
      <SymbolView name={{ ios: 'xmark.circle.fill', android: 'cancel' }} size={16} tintColor={c.muted} />
    </Pressable> : null}
  </View>;
}

/** A thread with how many of its sessions run, and a toggle for its sessions. */
function ThreadRow({ item, expanded, childCount, running, onToggle, onLongPress }: {
  item: Workbench; expanded: boolean; childCount: number; running: number; onToggle(): void; onLongPress(item: Workbench): void;
}) {
  const c = useTheme();
  const router = useRouter();
  const [pressed, setPressed] = useState(false);
  const title = workbenchTitle(item);
  const state = workbenchState(item);
  return <View style={[styles.threadRow, { backgroundColor: pressed ? c.surface : 'transparent' }]}>
    <Pressable accessibilityRole="link" accessibilityLabel={[`${title}.`, `${state.label}.`, running ? `${running} running.` : ''].filter(Boolean).join(' ')}
      accessibilityActions={[{ name: 'longpress', label: `Actions for ${title}` }]}
      onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'longpress') onLongPress(item); }}
      onPress={() => router.push(threadRoute(item.id))} onLongPress={() => onLongPress(item)}
      onPressIn={() => setPressed(true)} onPressOut={() => setPressed(false)} style={styles.threadMain}>
      <View style={styles.threadIcon}><SessionStateIcon state={state} /></View>
      <Text numberOfLines={1} style={[type.rowTitle, { color: c.text, flex: 1 }]}>{title}</Text>
      {running ? <AppText variant="meta" tone="muted">{running} running</AppText> : null}
    </Pressable>
    {childCount ? <Pressable accessibilityRole="button" accessibilityLabel={expanded ? `Hide sessions of ${title}` : `Show sessions of ${title}`}
      accessibilityState={{ expanded }} hitSlop={8} onPress={onToggle} style={styles.threadToggle}>
      <SymbolView name={expanded ? { ios: 'chevron.down', android: 'expand_more' } : { ios: 'chevron.right', android: 'chevron_right' }}
        size={14} tintColor={c.muted} />
    </Pressable> : null}
  </View>;
}

const styles = StyleSheet.create({
  drawer: { flex: 1 },
  top: { paddingHorizontal: 12, gap: 6, paddingBottom: 8 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, marginTop: 2 },
  searchInput: { flex: 1, paddingVertical: 8 },
  list: { paddingHorizontal: 12, paddingBottom: 16 },
  indent: { paddingLeft: 18 },
  notice: { paddingHorizontal: 6, paddingVertical: 8 },
  loading: { alignItems: 'center', justifyContent: 'center', paddingVertical: 16 },
  threadRow: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, minHeight: 44 },
  threadMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingLeft: 4 },
  threadIcon: { width: 16, alignItems: 'center' },
  threadToggle: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  footerPages: { paddingTop: 12 },
  pinned: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 6 },
  pages: { gap: 1 },
  settings: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 6 },
  navRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 40, borderRadius: radius.md, paddingHorizontal: 10 },
  badge: { minWidth: 24, paddingHorizontal: 6, borderRadius: radius.round, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
});
