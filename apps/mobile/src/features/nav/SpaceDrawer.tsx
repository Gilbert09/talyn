import type { Space, SpacePresenceMember, SpaceSessionRow, SpaceTaskRow, Workbench } from '@talyn/shared';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState, type ReactElement } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { useAuth, useWorkspace } from '../../auth/AuthProvider';
import { SessionStateIcon } from '../../components/Status';
import { AppText, IconButton, PrNumber, Row, Spinner } from '../../components/UI';
import { openExternal } from '../../components/Workflow';
import type { SessionState } from '../../lib/status';
import { shortTime, useNow } from '../../lib/time';
import { radius, type, useTheme } from '../../theme/tokens';
import { MemberAvatar } from '../spaces/Avatars';
import { useOpenSpaceRow } from '../spaces/context';
import { useSpaceEvents, useSpaceItems, useSpacePresence } from '../spaces/data';
import { spaceDrawerEntries, type SpaceDrawerEntry } from '../spaces/drawer';
import { memberName, presenceSentence } from '../spaces/model';
import { toggled } from './model';
import { GroupHeader, Heading } from './DrawerParts';

/**
 * The drawer's lists in a space, like web's `SpaceSidebar`: my threads, every
 * member's sessions, the space's tasks, and what I cannot see.
 */
export function SpaceDrawerList({ space, owned, query, onNewThread, onLongPress, footer }: {
  space: Space; owned: ReadonlyMap<string, Workbench>; query: string; onNewThread?(): void; onLongPress(item: Workbench): void;
  footer?: ReactElement;
}) {
  const c = useTheme();
  const self = useAuth().user?.id ?? null;
  const items = useSpaceItems(space.id);
  const presence = useSpacePresence(space.id);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedThreads, setCollapsedThreads] = useState<ReadonlySet<string>>(() => new Set());
  const ids = useMemo(() => new Set([...(items.data?.sessions.items ?? []).map((row) => row.id), ...(items.data?.tasks.items ?? []).map((row) => row.id)]),
    [items.data]);
  useSpaceEvents(ids, space.id, () => { void items.refresh(); });
  const failed = items.data === undefined && items.status !== 'loading' && items.status !== 'idle';
  const entries = useMemo(() => spaceDrawerEntries({ items: items.data, failed, owned, presence, self, query, collapsedGroups, collapsedThreads }),
    [items.data, failed, owned, presence, self, query, collapsedGroups, collapsedThreads]);
  const now = useNow();

  const render = ({ item }: { item: SpaceDrawerEntry }) => {
    switch (item.type) {
      case 'heading': return <Heading title={item.title}
        trailing={item.section === 'threads' && onNewThread ? <IconButton label="New thread" size={16} symbol={{ ios: 'plus', android: 'add' }}
          onPress={onNewThread} /> : undefined} />;
      case 'group': return <GroupHeader repo={item.repo} expanded={item.expanded} hidden={item.hidden} attention={item.attention}
        onToggle={() => setCollapsedGroups((set) => toggled(set, item.repo))} />;
      case 'thread': return <SpaceRow row={item.row} state={item.state} viewers={item.viewers} now={now} owned={owned} onLongPress={onLongPress}
        toggle={item.childCount ? { expanded: item.expanded, onPress: () => setCollapsedThreads((set) => toggled(set, item.row.id)) } : undefined}
        detail={item.running ? `${item.running} running` : undefined} />;
      case 'row': return <View style={item.indent ? styles.indent : undefined}>
        <SpaceRow row={item.row} state={item.state} viewers={item.viewers} now={now} owned={owned} onLongPress={onLongPress} />
      </View>;
      case 'task': return <TaskRow task={item.task} />;
      case 'notice': return <AppText variant="meta" tone="muted" style={styles.notice}>{item.text}</AppText>;
      case 'loading': return <View accessibilityState={{ busy: true }} accessibilityLabel="Loading the space" style={styles.loading}><Spinner /></View>;
    }
  };

  return <FlatList data={entries} keyExtractor={(entry) => entry.key} renderItem={render} style={{ flex: 1 }}
    accessibilityLabel={`Sessions and threads in ${space.name}`} contentContainerStyle={styles.list}
    keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" initialNumToRender={20} maxToRenderPerBatch={16} windowSize={9}
    refreshControl={<RefreshControl refreshing={items.refreshing && items.data !== undefined} onRefresh={() => { void items.refresh(); }}
      tintColor={c.muted} colors={[c.primaryAction]} progressBackgroundColor={c.elevated} />}
    ListFooterComponent={footer} />;
}

/** A space session or thread: state, title, who started it, who has it open, and when it last changed. */
function SpaceRow({ row, state, viewers, now, owned, onLongPress, toggle, detail }: {
  row: SpaceSessionRow; state: SessionState; viewers: SpacePresenceMember[]; now: number; owned: ReadonlyMap<string, Workbench>;
  onLongPress(item: Workbench): void; toggle?: { expanded: boolean; onPress(): void }; detail?: string;
}) {
  const c = useTheme();
  const open = useOpenSpaceRow();
  const workspace = useWorkspace();
  const name = row.title || row.name;
  const mine = owned.get(row.id);
  const elsewhere = row.workspaceId !== workspace.selected && !workspace.choices.some((choice) => choice.id === row.workspaceId);
  const owner = memberName(row.creator);
  const viewing = presenceSentence(viewers);
  const time = shortTime(row.lastActivityAt ?? row.updatedAt, now);
  const label = [`${name}.`, `${state.label}.`, `${owner}.`, detail ? `${detail}.` : '', viewing ? `${viewing}.` : '',
    elsewhere ? 'Opens on the web.' : ''].filter(Boolean).join(' ');
  const body = <Row title={name} titleLines={1} divider={false} accessibilityLabel={label} accessibilityRole="link"
    onPress={() => open(row)} onLongPress={mine ? () => onLongPress(mine) : undefined} longPressLabel={`Actions for ${name}`}
    leading={<SessionStateIcon state={state} />}
    trailing={<View style={styles.trailing}>
      {row.pullRequest ? <PrNumber number={row.pullRequest.number} /> : null}
      {detail ? <AppText variant="meta" tone="muted">{detail}</AppText> : null}
      <People creator={row.creator} viewers={viewers} />
      {time ? <AppText variant="meta" tone="muted">{time}</AppText> : null}
      {elsewhere ? <SymbolView name={{ ios: 'arrow.up.right', android: 'open_in_new' }} size={12} tintColor={c.muted} /> : null}
    </View>} />;
  if (!toggle) return body;
  return <View style={styles.threadRow}>
    <View style={{ flex: 1 }}>{body}</View>
    <Pressable accessibilityRole="button" accessibilityLabel={toggle.expanded ? `Hide sessions of ${name}` : `Show sessions of ${name}`}
      accessibilityState={{ expanded: toggle.expanded }} hitSlop={8} onPress={toggle.onPress} style={styles.threadToggle}>
      <SymbolView name={toggle.expanded ? { ios: 'chevron.down', android: 'expand_more' } : { ios: 'chevron.right', android: 'chevron_right' }}
        size={14} tintColor={c.muted} />
    </Pressable>
  </View>;
}

/** Who started it, then up to three teammates with it open now. */
function People({ creator, viewers }: { creator: SpaceSessionRow['creator']; viewers: SpacePresenceMember[] }) {
  const c = useTheme();
  const extra = viewers.length - 3;
  return <View style={styles.people} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <MemberAvatar member={creator} size={16} />
    {viewers.length ? <View style={styles.viewers}>
      {viewers.slice(0, 3).map((viewer) => <View key={viewer.userId} style={[styles.viewer, { borderColor: c.success }]}>
        <MemberAvatar member={viewer} size={14} />
      </View>)}
      {extra > 0 ? <Text style={[type.caption, { color: c.muted }]}>+{extra}</Text> : null}
    </View> : null}
  </View>;
}

function TaskRow({ task }: { task: SpaceTaskRow }) {
  const pr = task.pullRequest;
  const status = task.status.replace(/_/g, ' ');
  return <Row title={task.title} titleLines={1} divider={false} leading={<MemberAvatar member={task.creator} size={16} />}
    subtitle={[memberName(task.creator), status].join(' · ')}
    accessibilityLabel={`${task.title}. ${status}. ${memberName(task.creator)}.${pr ? ` Opens pull request ${pr.number} on GitHub.` : ''}`}
    onPress={pr ? () => openExternal(pr.url) : undefined}
    trailing={pr ? <PrNumber number={pr.number} /> : undefined} />;
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 12, paddingBottom: 16 },
  indent: { paddingLeft: 18 },
  notice: { paddingHorizontal: 6, paddingVertical: 8 },
  loading: { alignItems: 'center', justifyContent: 'center', paddingVertical: 16 },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  people: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  viewers: { flexDirection: 'row', alignItems: 'center' },
  viewer: { borderWidth: 1, borderRadius: radius.round, marginLeft: -4 },
  threadRow: { flexDirection: 'row', alignItems: 'center' },
  threadToggle: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
});
