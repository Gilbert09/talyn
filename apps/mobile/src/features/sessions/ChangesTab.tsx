import type { Workbench, WorkbenchChangedFile, WorkbenchDiffScope } from '@talyn/shared';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useNetwork } from '../../auth/AuthProvider';
import { AppText, Banner, Button, EmptyState, Spinner } from '../../components/UI';
import { errorMessage } from '../../lib/errors';
import { useNow } from '../../lib/time';
import { mono, sans, type, useTheme } from '../../theme/tokens';
import { changeGroups, FILE_STATUS_LETTER, fileLabel, groupTotals, splitPath, storedText } from './changes';
import { useChanges } from './data';
import { FileDiff } from './DiffView';
import { changesUnavailable } from './model';

function Counts({ added, removed, binary = false }: { added: number; removed: number; binary?: boolean }) {
  const c = useTheme();
  if (binary) return <Text style={[styles.count, { color: c.muted }]}>binary</Text>;
  return <Text style={styles.count}>
    {added > 0 ? <Text style={{ color: c.success }}>+{added}</Text> : null}
    {added > 0 && removed > 0 ? ' ' : null}
    {removed > 0 ? <Text style={{ color: c.destructive }}>−{removed}</Text> : null}
  </Text>;
}

function StatusLetter({ status }: { status: WorkbenchChangedFile['status'] }) {
  const c = useTheme();
  const color = status === 'added' ? c.success : status === 'deleted' ? c.destructive : status === 'renamed' ? c.information : c.warning;
  return <Text style={[styles.letter, { color }]}>{FILE_STATUS_LETTER[status]}</Text>;
}

function FileRow({ file, onPress, divider }: { file: WorkbenchChangedFile; onPress(): void; divider: boolean }) {
  const c = useTheme();
  const { dir, name } = splitPath(file.path);
  return <Pressable accessibilityRole="button" accessibilityLabel={fileLabel(file)} accessibilityHint="Shows the diff." onPress={onPress}
    style={({ pressed }) => [styles.file, { borderBottomColor: divider ? c.border : 'transparent', backgroundColor: pressed ? c.paper : 'transparent' }]}>
    <StatusLetter status={file.status} />
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={[styles.name, { color: c.text }]}>{name}</Text>
      {dir || file.oldPath ? <Text numberOfLines={1} ellipsizeMode="head" style={[styles.dir, { color: c.muted }]}>
        {file.oldPath ? `from ${file.oldPath}` : dir}</Text> : null}
    </View>
    <Counts added={file.added} removed={file.removed} binary={file.binary} />
  </Pressable>;
}

function GroupHeader({ label, files, expanded, onToggle }: { label: string; files: WorkbenchChangedFile[]; expanded: boolean; onToggle(): void }) {
  const c = useTheme();
  const totals = groupTotals(files);
  return <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
    accessibilityLabel={`${label}. ${files.length} ${files.length === 1 ? 'file' : 'files'}.`} onPress={onToggle} style={styles.group}>
    <SymbolView name={expanded ? { ios: 'chevron.down', android: 'expand_more' } : { ios: 'chevron.right', android: 'chevron_right' }} size={14} tintColor={c.muted} />
    <AppText variant="section" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>{label}</AppText>
    <AppText variant="caption" tone="muted">{`${files.length} ${files.length === 1 ? 'file' : 'files'}`}</AppText>
    <View style={{ flex: 1 }} />
    <Counts added={totals.added} removed={totals.removed} />
  </Pressable>;
}

/**
 * The Changes tab: the branch's changed files against its base, and a
 * unified diff of the chosen file. Read-only, like web `ChangesTab` without
 * line comments. A sleeping box answers with Talyn's stored copy; only pull
 * to refresh reads the box, which wakes it.
 */
export function ChangesTab({ item }: { item: Workbench }) {
  const c = useTheme();
  const now = useNow();
  const offline = useNetwork() === 'offline';
  const merged = item.pr?.state === 'merged';
  const [showMerged, setShowMerged] = useState(false);
  const blocked = changesUnavailable(item);
  const enabled = !blocked && (!merged || showMerged);
  const state = useChanges(item, enabled);
  const [selection, setSelection] = useState<{ path: string; scope: WorkbenchDiffScope } | null>(null);
  const [collapsed, setCollapsed] = useState<Partial<Record<WorkbenchDiffScope, boolean>>>({});
  useEffect(() => { setSelection(null); setCollapsed({}); setShowMerged(false); }, [item.id]);

  const changes = state.data?.changes ?? null;
  const groups = changes ? changeGroups(changes) : [];
  const selected = selection ? groups.find((group) => group.scope === selection.scope)?.files.find((file) => file.path === selection.path) ?? null : null;
  const stored = changes ? storedText(changes, now) : null;
  const refreshControl = enabled ? <RefreshControl refreshing={state.refreshing && state.data !== undefined}
    onRefresh={() => { void state.reload(!offline && Boolean(changes?.snapshotAt || state.data?.asleep)); }}
    tintColor={c.muted} colors={[c.primaryAction]} progressBackgroundColor={c.elevated} /> : undefined;

  let body: ReactNode;
  if (merged && !showMerged) {
    body = <View style={{ gap: 10 }}>
      <AppText variant="meta" tone="muted">{`PR #${item.pr?.number} merged. Its changes are in ${item.baseBranch}.`}</AppText>
      <View style={{ alignSelf: 'flex-start' }}><Button variant="secondary" size="sm" title="Show the branch diff anyway" onPress={() => setShowMerged(true)} /></View>
    </View>;
  } else if (blocked) {
    body = <AppText variant="meta" tone="muted">{blocked}</AppText>;
  } else if (selected && selection) {
    const { dir, name } = splitPath(selected.path);
    body = <View style={{ gap: 10 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="All changed files" onPress={() => setSelection(null)} hitSlop={6} style={styles.back}>
        <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back' }} size={14} tintColor={c.primaryAction} />
        <AppText variant="meta" style={[sans(600), { color: c.primaryAction }]}>All files</AppText>
      </Pressable>
      <View style={styles.fileHead}>
        <StatusLetter status={selected.status} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text selectable style={[styles.name, { color: c.text }]}>{name}</Text>
          {dir ? <Text selectable style={[styles.dir, { color: c.muted }]}>{dir}</Text> : null}
        </View>
        <Counts added={selected.added} removed={selected.removed} binary={selected.binary} />
      </View>
      <FileDiff key={`${selection.scope}:${selected.path}:${changes?.headSha ?? ''}`} workbenchId={item.id} file={selected} scope={selection.scope}
        revision={changes?.headSha ?? ''} tooLarge={Boolean(changes?.snapshotAt && changes.patch?.tooLarge)} />
    </View>;
  } else {
    body = <View style={{ gap: 4 }}>
      {state.status === 'error' || state.status === 'unauthorized' || state.status === 'deleted'
        ? <Banner tone="destructive" message={state.data ? 'Could not refresh. Showing earlier changes.' : errorMessage(state.error, 'Could not load the changes.')}
          action="Try again" onAction={() => { void state.reload(); }} actionDisabled={offline || state.refreshing} /> : null}
      {offline && !state.data ? <Banner message="You are offline. Connect to load the changes." /> : null}
      {state.data?.asleep && !changes ? <Banner tone="information" message="Sandbox is asleep. Talyn has no stored copy of its changes yet."
        action="Wake the sandbox" onAction={() => { void state.reload(true); }} actionDisabled={offline || state.refreshing} /> : null}
      {stored ? <Banner tone={changes?.stale ? 'warning' : 'information'} message={stored}
        action={changes?.storedReason === 'archived' ? undefined : 'Refresh from the sandbox'}
        onAction={() => { void state.reload(true); }} actionDisabled={offline || state.refreshing} /> : null}
      {!state.data && (state.status === 'loading' || state.status === 'idle') ? <View accessibilityState={{ busy: true }} style={styles.loading}>
        <Spinner /><AppText variant="meta" tone="muted">Loading changes</AppText></View> : null}
      {changes && changes.files.length === 0 && !changes.uncommitted?.length && !changes.committed?.length
        ? <EmptyState title="No changes yet" detail="Files the agent changes on this branch show here." />
        : groups.map((group) => {
          const open = !collapsed[group.scope];
          return <View key={group.scope}>
            <GroupHeader label={group.label} files={group.files} expanded={open}
              onToggle={() => setCollapsed((current) => ({ ...current, [group.scope]: !current[group.scope] }))} />
            {open ? group.files.length === 0
              ? <AppText variant="meta" tone="muted" style={styles.empty}>{group.empty}</AppText>
              : <View accessibilityRole="list">{group.files.map((file, index) => <FileRow key={file.path} file={file} divider={index < group.files.length - 1}
                onPress={() => setSelection({ path: file.path, scope: group.scope })} />)}</View> : null}
          </View>;
        })}
    </View>;
  }

  return <ScrollView contentContainerStyle={styles.content} refreshControl={refreshControl} keyboardShouldPersistTaps="handled">
    {body}
  </ScrollView>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 40, gap: 8 },
  group: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, paddingTop: 8 },
  file: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingVertical: 8, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  letter: { width: 14, textAlign: 'center', fontSize: 12, lineHeight: 16, ...mono(500) },
  name: { fontSize: 13, lineHeight: 18, ...mono(500) },
  dir: { fontSize: 12, lineHeight: 16, ...mono(400) },
  count: { ...type.caption, ...mono(400) },
  back: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', minHeight: 32 },
  fileHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  empty: { paddingHorizontal: 4, paddingBottom: 8 },
  loading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 24 },
});
