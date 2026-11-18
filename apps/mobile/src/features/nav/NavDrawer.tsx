import type { Workbench, WorkbenchTranscriptMatch } from '@talyn/shared';
import { useGlobalSearchParams, usePathname, useRouter, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useState } from 'react';
import { Animated, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Reanimated, { Easing, FadeIn, FadeInRight, FadeOut, FadeOutRight, LayoutAnimationConfig, withTiming, type EntryAnimationsValues, type ExitAnimationsValues }
  from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionStateIcon } from '../../components/Status';
import { AppText, IconButton, Row, Spinner } from '../../components/UI';
import { workbenchState } from '../../lib/status';
import { useNow } from '../../lib/time';
import { HOME, newWorkRoute, sessionRoute, threadRoute } from '../../navigation/routes';
import { radius, sans, type, useTheme } from '../../theme/tokens';
import { workbenchKind, workbenchTitle } from '../../workflow/model';
import { useSessionMenu } from '../sessions/SessionMenu';
import { WorkbenchRow } from '../sessions/WorkbenchRow';
import { useActiveContext } from '../spaces/context';
import { ContextSwitcher } from './ContextSwitcher';
import { DrawerBar, DrawerMenuButton, NEW_SESSION_CLEARANCE, NewSessionButton } from './DrawerBar';
import { GroupHeader, Heading } from './DrawerParts';
import { SessionStarters } from './SessionStarters';
import { SpaceDrawerList } from './SpaceDrawer';
import { useDrawerWork, usePlanState, useTranscriptMatches } from './data';
import { activeTarget, drawerEntries, toggled, withTranscriptMatches, type DrawerEntry } from './model';
import { usePullToSearch } from './pullToSearch';

const LIST_LINKS = new Set(['/sessions', '/threads']);

/**
 * The navigation drawer: the workspace with search and a menu with the other
 * pages and Settings, the session lists with a floating New session button,
 * then a bar with the pull request lists. A pull down at the top of the list opens search.
 */
export function NavDrawer({ close }: { close(): void }) {
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const { tab } = useGlobalSearchParams<{ tab?: string }>();
  const active = activeTarget(pathname, tab);
  const { features, offered, sessions, threads, personal, reasons } = useDrawerWork();
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedThreads, setCollapsedThreads] = useState<ReadonlySet<string>>(() => new Set());
  const place = useActiveContext();
  const space = place.active?.space ?? null;
  const { matches, loading } = useTranscriptMatches(query, offered && !space);
  const entries = useMemo(() => offered
    ? withTranscriptMatches(drawerEntries({ sessions: personal.sessions, threads: personal.threads, query, collapsedGroups, collapsedThreads, reasons }), matches, loading)
    : [], [offered, personal, reasons, query, collapsedGroups, collapsedThreads, matches, loading]);
  const now = useNow();
  const menu = useSessionMenu();
  const owned = useMemo(() => new Map([...(sessions.data ?? []), ...(threads.data ?? [])].map((item) => [item.id, item])),
    [sessions.data, threads.data]);

  // Leaving home closes the drawer, so Back comes back to the screen and not to the open drawer.
  // The old list links open the drawer themselves, so they must not close it.
  useEffect(() => { if (pathname !== HOME && !LIST_LINKS.has(pathname)) close(); }, [pathname, close]);

  const go = (href: Href) => router.push(href);
  const goHome = () => { if (pathname === HOME) close(); else router.navigate(HOME); };
  const openSearch = () => setSearching(true);
  const closeSearch = () => { setQuery(''); setSearching(false); Keyboard.dismiss(); };
  const pull = usePullToSearch(openSearch);

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
      case 'transcript': return <TranscriptMatchRow match={item.match} />;
      case 'notice': return <AppText variant="meta" tone="muted" style={styles.notice}>{item.text}</AppText>;
      case 'starters': return <SessionStarters />;
      case 'loading': return <View accessibilityState={{ busy: true }} style={styles.loading}><Spinner /></View>;
    }
  };

  return <View style={[styles.drawer, { backgroundColor: c.paper, paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 8) }]}>
    <View style={styles.top}>
      <LayoutAnimationConfig skipEntering>
        {offered && searching ? <SearchField key="search" value={query} onChange={setQuery} onCancel={closeSearch} />
          : <Reanimated.View key="header" entering={HEADER_IN} exiting={HEADER_OUT} style={styles.header}>
            <View style={styles.switcher}><ContextSwitcher state={place} /></View>
            {offered ? <IconButton label="Search" symbol={{ ios: 'magnifyingglass', android: 'search' }} onPress={openSearch} /> : null}
            <DrawerMenuButton active={active} go={go} history={offered} />
          </Reanimated.View>}
      </LayoutAnimationConfig>
    </View>
    <View style={{ flex: 1 }}>
      {features === null || place.context.kind === 'pending' ? <View style={[styles.loading, { flex: 1 }]}><Spinner /></View>
        : space ? <SpaceDrawerList key={space.id} space={space} owned={owned} query={query} pull={pull} onLongPress={menu.open}
          onNewThread={offered ? () => go(newWorkRoute('thread')) : undefined} />
        : !offered ? <View style={{ flex: 1 }} /> : <View style={{ flex: 1 }}>
          {pull.hint}
          <Animated.FlatList data={entries} keyExtractor={(entry) => entry.key} renderItem={render} style={{ flex: 1 }}
            accessibilityLabel="Sessions and threads" contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
            initialNumToRender={20} maxToRenderPerBatch={16} windowSize={9} {...pull.listProps} />
        </View>}
      {offered ? <NewSessionButton selected={active === 'home'} onPress={goHome} /> : null}
    </View>
    <DrawerBar active={active} go={go} />
    {menu.elements}
  </View>;
}

const SEARCH_MS = 240;
const SEARCH_EASING = Easing.bezier(0.2, 0.9, 0.3, 1);
/** The width of the search button. The field grows out of it and shrinks back into it. */
const SEARCH_BUTTON = 40;
const HEADER_IN = FadeIn.duration(180).delay(80);
const HEADER_OUT = FadeOut.duration(120);
const CANCEL_IN = FadeInRight.duration(SEARCH_MS).easing(SEARCH_EASING);
const CANCEL_OUT = FadeOutRight.duration(160);

/** The field opens from the right, where the search button was, to its full width. */
const searchGrow = (values: EntryAnimationsValues) => {
  'worklet';
  const timing = { duration: SEARCH_MS, easing: SEARCH_EASING };
  return {
    initialValues: { originX: values.targetOriginX + values.targetWidth - SEARCH_BUTTON, width: SEARCH_BUTTON, opacity: 0 },
    animations: { originX: withTiming(values.targetOriginX, timing), width: withTiming(values.targetWidth, timing), opacity: withTiming(1, timing) },
  };
};

/** On close, the field shrinks back to the right and fades out. */
const searchShrink = (values: ExitAnimationsValues) => {
  'worklet';
  const timing = { duration: 160, easing: Easing.in(Easing.quad) };
  return {
    initialValues: { originX: values.currentOriginX, width: values.currentWidth, opacity: 1 },
    animations: { originX: withTiming(values.currentOriginX + values.currentWidth - SEARCH_BUTTON, timing),
      width: withTiming(SEARCH_BUTTON, timing), opacity: withTiming(0, timing) },
  };
};

/**
 * The search field that takes the workspace row's place while search is open.
 * Cancel clears it and closes it. The field grows out of the search button and
 * Cancel slides in, while the workspace row fades out.
 */
function SearchField({ value, onChange, onCancel }: { value: string; onChange(value: string): void; onCancel(): void }) {
  const c = useTheme();
  return <View style={styles.header}>
    <Reanimated.View entering={searchGrow} exiting={searchShrink}
      style={[styles.search, { backgroundColor: c.background, borderColor: c.primary }]}>
      <SymbolView name={{ ios: 'magnifyingglass', android: 'search' }} size={16} tintColor={c.muted} />
      <TextInput accessibilityLabel="Search sessions and threads" placeholder="Search" placeholderTextColor={c.muted}
        selectionColor={c.primary} value={value} onChangeText={onChange} autoCapitalize="none" autoCorrect={false} returnKeyType="search" autoFocus
        style={[type.body, styles.searchInput, { color: c.text }]} />
      {value ? <Pressable accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={8} onPress={() => onChange('')}>
        <SymbolView name={{ ios: 'xmark.circle.fill', android: 'cancel' }} size={16} tintColor={c.muted} />
      </Pressable> : null}
    </Reanimated.View>
    <Reanimated.View entering={CANCEL_IN} exiting={CANCEL_OUT}>
      <Pressable accessibilityRole="button" accessibilityLabel="Cancel search" hitSlop={8} onPress={onCancel}>
        <Text style={[type.body, sans(500), { color: c.primary }]}>Cancel</Text>
      </Pressable>
    </Reanimated.View>
  </View>;
}

/** A session or thread whose transcript holds the search: its name, its repository, and the text around the match. */
function TranscriptMatchRow({ match }: { match: WorkbenchTranscriptMatch }) {
  const c = useTheme();
  const item = match.workbench;
  const title = workbenchTitle(item);
  const thread = workbenchKind(item) === 'thread';
  const place = thread ? 'Thread' : item.repoFullName;
  return <Row href={thread ? threadRoute(item.id) : sessionRoute(item.id)} title={title} titleLines={1} divider={false}
    subtitle={place || undefined} accessibilityLabel={[`${title}.`, place ? `${place}.` : '', item.archivedAt ? 'Archived.' : '', match.snippet]
      .filter(Boolean).join(' ')}
    leading={<SymbolView name={{ ios: 'text.bubble', android: 'chat' }} size={14} tintColor={c.muted} />}>
    <AppText variant="meta" tone="muted" numberOfLines={2}>{match.snippet}</AppText>
  </Row>;
}

/** A thread with how many of its sessions run, and a toggle for its sessions. */
function ThreadRow({ item, expanded, childCount, running, onToggle, onLongPress }: {
  item: Workbench; expanded: boolean; childCount: number; running: number; onToggle(): void; onLongPress(item: Workbench): void;
}) {
  const c = useTheme();
  const router = useRouter();
  const [pressed, setPressed] = useState(false);
  const title = workbenchTitle(item);
  const state = usePlanState(item.id, workbenchState(item));
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
  top: { paddingHorizontal: 12, paddingBottom: 4 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  switcher: { flex: 1, alignItems: 'flex-start' },
  search: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10 },
  searchInput: { flex: 1, paddingVertical: 8 },
  list: { paddingHorizontal: 12, paddingBottom: NEW_SESSION_CLEARANCE },
  indent: { paddingLeft: 18 },
  notice: { paddingHorizontal: 6, paddingVertical: 8 },
  loading: { alignItems: 'center', justifyContent: 'center', paddingVertical: 16 },
  threadRow: { flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, minHeight: 44 },
  threadMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingLeft: 4 },
  threadIcon: { width: 16, alignItems: 'center' },
  threadToggle: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
