import { workbenches, workspaces, type WatchedRepo } from '@talyn/client/native';
import {
  MEMORY_REVIEW_CADENCES, MEMORY_REVIEW_CADENCE_LABELS, memoryLimitMessage, memoryReviewCadenceOf,
  type MemoryEntrySummary, type MemoryReviewCadence, type MemoryReviewState, type Workspace, type WorkspaceSettings,
} from '@talyn/shared';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';

import { useMobileRuntime, useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, EmptyState, Group, Input, Pill, Row, SectionLabel, Toggle, useActionSheet, useToast } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { errorMessage } from '../../lib/errors';
import { useFeatures } from '../../lib/features';
import { threadRoute } from '../../navigation/routes';
import { useResource } from '../../workflow/hooks';
import { useRefreshOnFocus } from '../instructions/useRefreshOnFocus';
import { Intro, Loading, Page } from '../more/Page';
import { useRemote } from '../more/useRemote';
import {
  MEMORY_INTRO, MEMORY_REVIEW_DETAIL, MEMORY_TITLE_DESCRIPTION, MEMORY_TYPE_LABEL, SEARCH_DELAY_MS, SESSION_MEMORY_DETAIL, ago,
  emptyMemoryMessage, groupMemories, liveCountOf, memoryCount, memoryListQuery, memorySourceLabel, reviewLine, upsertSummary,
} from './model';

/** Settings → Memory. Mirrors web `MemorySection`. */
export function MemoryScreen() {
  const features = useFeatures();
  if (!features) return <Page><Loading /></Page>;
  if (features.workbenches !== true) return <Page><EmptyState title="Memory is not available" detail="Sessions are not available on this account." /></Page>;
  return <MemoryList />;
}

function MemoryList() {
  const router = useRouter();
  const { workflow } = useMobileRuntime();
  const offline = useNetwork() === 'offline';
  const workspaceId = useWorkspace().selected;
  const workspace = useResource<Workspace>('workspace');
  const repositories = useResource<WatchedRepo[]>('repositories');
  const repos = repositories.data ?? [];
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [showForgotten, setShowForgotten] = useState(false);
  const [liveCount, setLiveCount] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [justForgotten, setJustForgotten] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<Partial<WorkspaceSettings>>({});
  const [starting, setStarting] = useState(false);
  const menu = useActionSheet();
  const toast = useToast();

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const list = useRemote<MemoryEntrySummary[]>(workspaceId ? `memory:${workspaceId}:${showForgotten ? 1 : 0}:${search}` : null,
    async () => (await workbenches.memory.list(memoryListQuery(workspaceId ?? '', search, showForgotten))) as MemoryEntrySummary[]);
  const reviews = useRemote<MemoryReviewState>(workspaceId ? `memory-reviews:${workspaceId}` : null,
    () => workbenches.memory.reviews(workspaceId ?? ''));
  useEffect(() => { if (list.data && !search) setLiveCount(liveCountOf(list.data)); }, [list.data, search]);
  const refresh = () => { void list.refresh(); void reviews.refresh(); void workspace.refresh(); };
  useRefreshOnFocus(refresh);

  const settings = { ...workspace.data?.settings, ...pending } as WorkspaceSettings;
  const memoryOn = settings.sessionMemory !== false;
  const cadence = memoryReviewCadenceOf(settings);
  const saveSetting = async (patch: Partial<WorkspaceSettings>) => {
    if (!workspaceId) return;
    setPending((prev) => ({ ...prev, ...patch }));
    try {
      await workspaces.update(workspaceId, { settings: patch as WorkspaceSettings });
      await workflow.load('workspace').catch(() => undefined);
    } catch (error) {
      Alert.alert('Could not save this setting', errorMessage(error, 'Please try again.'));
    } finally {
      setPending({});
    }
  };
  const pickCadence = () => menu.open({ title: 'Memory review', message: MEMORY_REVIEW_DETAIL,
    actions: MEMORY_REVIEW_CADENCES.map((value: MemoryReviewCadence) => ({ label: MEMORY_REVIEW_CADENCE_LABELS[value], selected: value === cadence,
      onPress: () => { if (value !== cadence) void saveSetting({ memoryReview: value }); } })) });
  const reviewNow = async () => {
    if (!workspaceId) return;
    setStarting(true);
    try {
      await workbenches.memory.startReview(workspaceId);
      toast.show('Memory review started');
      await reviews.refresh();
    } catch (error) {
      Alert.alert('Could not start a memory review', errorMessage(error, 'Please try again.'));
    } finally {
      setStarting(false);
    }
  };

  const forget = async (entry: MemoryEntrySummary) => {
    setBusy(entry.id);
    try {
      const forgotten = await workbenches.memory.forget(entry.id);
      list.mutate((items) => upsertSummary(items, forgotten));
      setJustForgotten((set) => new Set(set).add(entry.id));
      setLiveCount((n) => n === null ? n : n - 1);
    } catch (error) {
      Alert.alert('Could not forget this memory', errorMessage(error, 'Please try again.'));
    } finally {
      setBusy(null);
    }
  };
  const restore = async (entry: MemoryEntrySummary) => {
    setBusy(entry.id);
    try {
      const restored = await workbenches.memory.restore(entry.id);
      list.mutate((items) => upsertSummary(items, restored));
      setJustForgotten((set) => { const next = new Set(set); next.delete(entry.id); return next; });
      setLiveCount((n) => n === null ? n : n + 1);
    } catch (error) {
      Alert.alert('Could not restore this memory', errorMessage(error, 'Please try again.'));
    } finally {
      setBusy(null);
    }
  };
  const open = (entry: MemoryEntrySummary) => router.push({ pathname: '/settings/memory/[id]', params: { id: entry.id } });
  const entryMenu = (entry: MemoryEntrySummary) => {
    const forgotten = Boolean(entry.forgottenAt);
    menu.open({ title: entry.name, message: entry.description, actions: forgotten
      ? [{ label: justForgotten.has(entry.id) ? 'Undo' : 'Restore', disabled: offline, onPress: () => { void restore(entry); } }]
      : [{ label: 'Edit', onPress: () => open(entry) },
        { label: 'Forget', destructive: true, disabled: offline, onPress: () => { void forget(entry); } }] });
  };

  const count = memoryCount(liveCount);
  const groups = groupMemories(list.data, repos);
  const line = reviewLine(reviews.data?.runs[0]);
  const writeDisabled = offline || !workspace.data;

  return <View style={{ flex: 1 }}>
    <Page refreshing={list.refreshing && list.data !== undefined} onRefresh={refresh}>
      <Intro>{MEMORY_TITLE_DESCRIPTION}</Intro>
      <Group>
        <Row title="Session memory" titleLines={2}
          subtitle={<AppText variant="meta" tone="muted">{SESSION_MEMORY_DETAIL}</AppText>}
          trailing={<Toggle accessibilityLabel="Session memory" value={memoryOn} disabled={writeDisabled || pending.sessionMemory !== undefined}
            onValueChange={(value) => { void saveSetting({ sessionMemory: value }); }} />} />
        <Row title="Memory review" chevron disabled={writeDisabled || pending.memoryReview !== undefined} onPress={pickCadence}
          accessibilityLabel={`Memory review. ${MEMORY_REVIEW_CADENCE_LABELS[cadence]}.`}
          subtitle={<AppText variant="meta" tone="muted">{MEMORY_REVIEW_DETAIL}</AppText>}
          trailing={<AppText variant="meta" tone="muted">{MEMORY_REVIEW_CADENCE_LABELS[cadence]}</AppText>} />
        <Row title="Review now" divider={false} disabled={starting || !memoryOn || offline} onPress={() => { void reviewNow(); }}
          subtitle={line ? <AppText variant="meta" tone="muted">{line.text}</AppText> : undefined}
          trailing={line?.workbenchId ? <AppText variant="meta" tone="primary" accessibilityRole="button"
            onPress={() => router.push(threadRoute(line.workbenchId!))}>Open thread</AppText> : undefined} />
      </Group>

      <Intro>{MEMORY_INTRO}</Intro>
      <Input accessibilityLabel="Search memory" placeholder="Search memory" value={query} onChangeText={setQuery}
        autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing" returnKeyType="search" />
      <Group footer={count?.full ? memoryLimitMessage() : undefined}>
        <Row title="Show forgotten" trailing={<Toggle accessibilityLabel="Show forgotten" value={showForgotten} onValueChange={setShowForgotten} />} />
        <Row title="Add memory" divider={false} disabled={list.data === undefined || Boolean(count?.full) || offline}
          onPress={() => router.push({ pathname: '/settings/memory/[id]', params: { id: 'new' } })}
          trailing={count ? <AppText variant="meta" tone={count.full ? 'destructive' : 'muted'} testID="memory-count">{count.label}</AppText> : undefined} />
      </Group>

      {list.data === undefined ? <StateNotice resource={list} offline={offline} refresh={() => { void list.refresh(); }} />
        : groups.length === 0 ? <EmptyState title={emptyMemoryMessage(search)} />
          : groups.map((group) => <View key={group.key}>
            <SectionLabel title={group.label} uppercase={!group.mono} />
            <Group>
              {group.entries.map((entry, index) => {
                const forgotten = Boolean(entry.forgottenAt);
                return <Row key={entry.id} title={entry.name} divider={index < group.entries.length - 1} disabled={busy === entry.id}
                  accessibilityLabel={`${entry.name}${forgotten ? ', forgotten' : ''}`} chevron={!forgotten}
                  onPress={() => forgotten ? entryMenu(entry) : open(entry)} onLongPress={() => entryMenu(entry)}
                  trailing={forgotten ? <Pill label="Forgotten" tone="warning" />
                    : <Pill label={MEMORY_TYPE_LABEL[entry.type]} />}
                  subtitle={entry.description ? <AppText variant="meta" tone="muted" numberOfLines={2}>{entry.description}</AppText> : undefined}>
                  <AppText variant="meta" tone="muted">{`${memorySourceLabel(entry.source).text} · Updated ${ago(entry.updatedAt)}`}</AppText>
                </Row>;
              })}
            </Group>
          </View>)}
    </Page>
    {menu.sheet}
    {toast.element}
  </View>;
}
