import type { Workbench } from '@talyn/shared';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { ScreenContainer } from '../../components/ScreenContainer';
import { PrPill } from '../../components/Status';
import { AppText, EmptyState, IconButton, Input, Row, SectionLabel, Segmented, useActionSheet, type Symbol } from '../../components/UI';
import { StateNotice, workflowStyles as styles } from '../../components/Workflow';
import { showActionError } from '../../lib/errors';
import { shortTime, useNow } from '../../lib/time';
import { sessionRoute, threadRoute } from '../../navigation/routes';
import { mono, useTheme } from '../../theme/tokens';
import { workbenchTitle } from '../../workflow/model';
import { useLoad } from '../sessions/data';
import { archivedAtOf, archivedItems, emptyHistoryText, historyRows, type HistoryKind } from './model';

const RESTORE: Symbol = { ios: 'arrow.uturn.backward', android: 'unarchive' };
const KINDS = [{ value: 'session' as const, label: 'Sessions' }, { value: 'thread' as const, label: 'Threads' }];

const routeOf = (item: Workbench) => (item.kind ?? 'session') === 'thread' ? threadRoute(item.id) : sessionRoute(item.id);

function HistoryItem({ item, now, divider, busy, offline, onRestore, onLongPress }: {
  item: Workbench; now: number; divider: boolean; busy: boolean; offline: boolean; onRestore(): void; onLongPress(): void;
}) {
  const c = useTheme();
  const title = workbenchTitle(item);
  const at = shortTime(archivedAtOf(item), now);
  const session = (item.kind ?? 'session') === 'session';
  return <Row href={routeOf(item)} title={title} divider={divider} onLongPress={onLongPress} longPressLabel={`Actions for ${title}`}
    accessibilityLabel={[`${title}.`, 'Archived.', item.pr ? `Pull request ${item.pr.number}.` : '', at ? `Archived ${at}.` : ''].filter(Boolean).join(' ')}
    subtitle={session && item.branch ? <Text numberOfLines={1} style={[local.branch, { color: c.muted }]}>{`${item.branch} → ${item.baseBranch}`}</Text> : undefined}
    trailing={<View style={local.trailing}>
      {item.pr ? <PrPill number={item.pr.number} state={item.pr.state} /> : null}
      <AppText variant="meta" tone="muted">{at}</AppText>
      <IconButton label={`Restore ${title}`} symbol={RESTORE} size={18} disabled={busy || offline} onPress={onRestore} />
    </View>}>
    {item.status === 'archiveError' && item.statusMessage ? <AppText variant="meta" tone="destructive">{item.statusMessage}</AppText> : null}
  </Row>;
}

/**
 * Archived sessions and threads, newest first, with search and restore.
 * Mirrors web `HistoryView`; delete stays on the web.
 */
export function HistoryScreen() {
  const { workflow } = useMobileRuntime();
  const router = useRouter();
  const c = useTheme();
  const now = useNow();
  const offline = useNetwork() === 'offline';
  const workspace = workflow.getScope()?.workspace ?? null;
  const state = useLoad<Workbench[]>(workspace ? `history:${workspace}` : null, async () =>
    (await workflow.api.workbenches.list(workspace ?? '', { includeArchived: true, kinds: ['session', 'thread'] }))
      .filter((item) => item.workspaceId === workspace));
  const [kind, setKind] = useState<HistoryKind>('session');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const sheet = useActionSheet();
  const all = state.data;
  const items = useMemo(() => archivedItems(all ?? [], kind, query), [all, kind, query]);
  const total = useMemo(() => archivedItems(all ?? [], kind, '').length, [all, kind]);
  const rows = useMemo(() => historyRows(items, kind), [items, kind]);

  const restore = async (item: Workbench) => {
    setBusy(item.id);
    try {
      await workflow.restoreWorkbench(item.id);
      if (all) state.set(all.filter((value) => value.id !== item.id));
      router.push(routeOf(item));
    } catch (error) {
      showActionError(`Could not restore the ${(item.kind ?? 'session') === 'thread' ? 'thread' : 'session'}`, error);
    } finally {
      setBusy(null);
    }
  };
  const menu = (item: Workbench) => sheet.open({ title: workbenchTitle(item), actions: [
    { label: 'Open', icon: { ios: 'arrow.right.circle', android: 'open_in_full' }, onPress: () => router.push(routeOf(item)) },
    { label: 'Restore', icon: RESTORE, disabled: offline || busy !== null, detail: offline ? 'You are offline.' : undefined, onPress: () => { void restore(item); } },
  ] });
  const empty = emptyHistoryText(kind, total, query);

  return <ScreenContainer>
    <FlatList data={rows} keyExtractor={(row) => row.key} accessibilityRole="list" accessibilityLabel={kind === 'thread' ? 'Archived threads' : 'Archived sessions'}
      contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      refreshControl={<RefreshControl refreshing={state.refreshing && all !== undefined} onRefresh={() => { void state.refresh(); }}
        tintColor={c.muted} colors={[c.primaryAction]} progressBackgroundColor={c.elevated} />}
      ListHeaderComponent={<View style={local.header}>
        <Segmented<HistoryKind> options={KINDS} value={kind} onChange={setKind} accessibilityLabel="Archived work" />
        <Input value={query} onChangeText={setQuery} placeholder="Search name, branch or repo" accessibilityLabel="Search archived work"
          autoCapitalize="none" autoCorrect={false} returnKeyType="search" clearButtonMode="while-editing" />
        <StateNotice resource={state} offline={offline} refresh={() => { void state.refresh(); }} />
      </View>}
      ListEmptyComponent={state.status === 'ready' ? <EmptyState title={empty.title} detail={empty.detail} /> : undefined}
      renderItem={({ item: row }) => row.type === 'section' ? <SectionLabel title={row.repo} uppercase={false} />
        : <HistoryItem item={row.item} now={now} divider={!row.last} busy={busy === row.item.id} offline={offline}
          onRestore={() => { void restore(row.item); }} onLongPress={() => menu(row.item)} />} />
    {sheet.sheet}
  </ScreenContainer>;
}

const local = StyleSheet.create({
  header: { gap: 10, paddingBottom: 4 },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  branch: { fontSize: 12, lineHeight: 16, ...mono(400) },
});
