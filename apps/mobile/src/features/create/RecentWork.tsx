import type { PRRow } from '@talyn/client/native';
import type { Workbench } from '@talyn/shared';
import { useRouter } from 'expo-router';
import { memo, useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { PrPill, SessionStateIcon } from '../../components/Status';
import { workbenchState, type SessionStateKind } from '../../lib/status';
import { relativeTimeLabel, shortTime, useNow } from '../../lib/time';
import { sessionRoute, threadRoute } from '../../navigation/routes';
import { mono, radius, sans, type, useTheme, type Theme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { workbenchKind, workbenchTitle } from '../../workflow/model';
import { useDrawerWork } from '../nav/data';
import { useSessionMenu } from '../sessions/SessionMenu';
import { branchChanges, recentWork, shortRepository } from './recent';

/**
 * Web's "Recent" list on the home composer: the newest sessions and threads,
 * one tap away. Rows read the live store lists, so their state, changes and
 * pull request follow socket events. A long press opens the session menu.
 */
export function RecentWork() {
  const { personal } = useDrawerWork();
  const items = useMemo(() => recentWork(personal.sessions, personal.threads), [personal.sessions, personal.threads]);
  // The open pull request rows carry CI and review, which the workbench's own summary does not. Shared with the PR pages.
  const prs = useResource<PRRow[]>('attention', '', items.some((item) => item.pullRequestId)).data;
  const byId = useMemo(() => new Map((prs ?? []).map((row) => [row.id, row])), [prs]);
  const menu = useSessionMenu();
  const now = useNow();
  const c = useTheme();
  if (!items.length) return null;
  return <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
    showsVerticalScrollIndicator={false}>
    <Text accessibilityRole="header" style={[styles.label, { color: c.muted }]}>Recent</Text>
    <View accessibilityRole="list" accessibilityLabel="Recent sessions"
      style={[styles.card, { backgroundColor: c.elevated, borderColor: c.border }]}>
      {items.map((item, index) => <Animated.View key={item.id} entering={FadeInDown.duration(220).delay(40 + index * 30)}>
        <RecentRow item={item} row={item.pullRequestId ? byId.get(item.pullRequestId) : undefined} now={now}
          divider={index < items.length - 1} onLongPress={menu.open} />
      </Animated.View>)}
    </View>
    {menu.elements}
  </ScrollView>;
}

const RecentRow = memo(function RecentRow({ item, row, now, divider, onLongPress }: {
  item: Workbench; row: PRRow | undefined; now: number; divider: boolean; onLongPress(item: Workbench): void;
}) {
  const c = useTheme();
  const router = useRouter();
  const thread = workbenchKind(item) === 'thread';
  const title = workbenchTitle(item);
  const state = workbenchState(item, row);
  const place = thread ? 'Thread' : shortRepository(item.repoFullName);
  const changes = thread ? null : branchChanges(item);
  const pr = row ?? item.pr ?? null;
  const updated = relativeTimeLabel(item.updatedAt, now);
  const label = [`${title}.`, `${state.label}.`, place ? `${place}.` : '',
    changes ? `${changes.added} lines added, ${changes.removed} removed.` : '', pr ? `Pull request ${pr.number}.` : '',
    updated ? `Updated ${updated}.` : ''].filter(Boolean).join(' ');
  return <Pressable accessibilityRole="link" accessibilityLabel={label}
    accessibilityActions={[{ name: 'longpress', label: `Actions for ${title}` }]}
    onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'longpress') onLongPress(item); }}
    onPress={() => router.push(thread ? threadRoute(item.id) : sessionRoute(item.id))} onLongPress={() => onLongPress(item)}
    style={({ pressed }) => [styles.row, { backgroundColor: pressed ? c.paper : 'transparent',
      borderBottomColor: divider ? c.border : 'transparent' }]}>
    <View style={styles.icon}><SessionStateIcon state={state} /></View>
    <View style={styles.main}>
      <View style={styles.line}>
        <Text numberOfLines={1} style={[styles.title, { color: c.text }]}>{title}</Text>
        <Text style={[styles.time, { color: c.muted }]}>{shortTime(item.updatedAt, now)}</Text>
      </View>
      <View style={styles.line}>
        <Text numberOfLines={1} style={[styles.meta, { color: c.muted }]}>
          <Text style={{ color: stateColor(state.kind, c) }}>{state.label}</Text>
          {place ? ` · ${place}` : ''}
        </Text>
        {changes ? <Text style={styles.changes}>
          <Text style={{ color: c.success }}>+{changes.added}</Text>
          <Text style={{ color: c.destructive }}> −{changes.removed}</Text>
        </Text> : null}
        {pr ? <PrPill number={pr.number} state={pr.state} draft={row?.summary.draft} /> : null}
      </View>
    </View>
  </Pressable>;
});

/** The state words take the icon's colour when the state asks for a look, and stay muted otherwise. */
function stateColor(kind: SessionStateKind, c: Theme): string {
  switch (kind) {
    case 'failed': case 'closed': return c.destructive;
    case 'working': case 'pr_attention': return c.warning;
    case 'starting': case 'needs_reply': return c.information;
    case 'ready_to_merge': return c.success;
    case 'merged': return c.merged;
    default: return c.muted;
  }
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: 12, paddingTop: 20, paddingBottom: 24, gap: 6, width: '100%', maxWidth: 760, alignSelf: 'center' },
  label: { ...type.section, fontSize: 11, paddingHorizontal: 6 },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10, minHeight: 56,
    borderBottomWidth: StyleSheet.hairlineWidth },
  icon: { width: 16, alignItems: 'center' },
  main: { flex: 1, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { ...type.rowTitle, fontSize: 14, lineHeight: 20, flex: 1 },
  time: { fontSize: 12, lineHeight: 16, ...sans(400), fontVariant: ['tabular-nums'] },
  meta: { fontSize: 12, lineHeight: 17, ...sans(400), flex: 1 },
  changes: { fontSize: 11, lineHeight: 16, ...mono(400) },
});
