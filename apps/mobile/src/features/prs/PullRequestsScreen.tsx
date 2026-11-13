import type { MergeQueuePublic, PRRow } from '@talyn/client/native';
import { reviewPriorityOffered, type PRFilterDefinition, type Workspace } from '@talyn/shared';
import { Stack } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, SectionList, StyleSheet, View } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { PickerSheet, type PickerSection } from '../../components/PickerSheet';
import { ScreenContainer } from '../../components/ScreenContainer';
import { AppText, Button, EmptyState, SectionLabel, type SheetAction } from '../../components/UI';
import { StateNotice, workflowStyles as styles } from '../../components/Workflow';
import { useFeatures } from '../../lib/features';
import { useNow } from '../../lib/time';
import { useTheme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { FilterBar, FilterChip } from './FilterBar';
import { effectiveReviewSort, filterMine, filterQueue, filterReviews, filtersActive, liveFilters, MINE_CHIPS, mineChipCounts,
  NO_FILTERS, repoChoices, requestedViaOptions, reviewSortModes, SORT_LABEL, toggled, type PrFilters } from './filters';
import { buildQueueGroups, hiddenReviewCohort, mineCohort, PULLS_TITLES, queueCohort, queueParentStatus, reviewCohort,
  type PullsTab, type ReviewSortMode, type SortDir } from './lists';
import { PrRow, type PrRowVariant } from './PrRow';
import { QUEUE_ICON, QueueSwipeRow } from './QueueSwipeRow';
import { useReviewSortMode } from './reviewSort';
import { prLinkTarget, usePrLinkMenu } from './usePrLinkMenu';
import { useQueueToggle } from './useQueueToggle';

interface QueueSection { key: string; title: string; detail?: string; warning?: string; data: PRRow[] }

const EMPTY: Record<PullsTab, { title: string; detail: string }> = {
  mine: { title: 'No open pull requests', detail: 'Pull requests you open or watch show here.' },
  reviews: { title: 'Nothing to review', detail: 'Pull requests where someone asks for your review show here.' },
  queue: { title: 'The merge queue is empty.', detail: 'Swipe a pull request in My PRs, or queue it from its page. It merges by itself when it is clean. Conflicts get fixed on the way.' },
};
const NO_MATCH = 'No pull requests match these filters.';
const SORT_DETAIL: Record<ReviewSortMode, string> = {
  newest: 'Newest first, by the date it was opened',
  oldest: 'Oldest first, by the date it was opened',
  priority: 'By state, size and how long it has waited',
};
const NO_DEFINITIONS: PRFilterDefinition[] = [];

type Picker = 'sort' | 'repo' | 'requested' | 'saved';

/** The merge queue's groups, one per repository and base and one per stack. Pure, so the order is testable. */
export function queueSections(rows: PRRow[]): QueueSection[] {
  return buildQueueGroups(rows).map((group) => ({
    key: group.key, title: `${group.owner}/${group.repo} → ${group.base || 'default'}`, data: group.rows,
    detail: group.kind === 'stack' ? `Stack of ${group.size}` : undefined,
    warning: group.kind === 'stack' && group.stalledAt ? `Stalled at #${group.stalledAt.number}` : undefined,
  }));
}

/**
 * One page of pull requests: My PRs, Review requests or the merge queue. All
 * three read the same live list of open PRs, as on web, and filter it here.
 * My PRs and Review requests are one flat list under a filter bar.
 */
export function PullRequestsScreen({ tab }: { tab: PullsTab }) {
  const state = useResource<PRRow[]>('attention');
  const workspace = useResource<Workspace>('workspace', '', tab !== 'queue');
  const offline = useNetwork() === 'offline';
  const { workflow } = useMobileRuntime();
  const features = useFeatures();
  const colors = useTheme();
  const links = usePrLinkMenu();
  const queueToggle = useQueueToggle();
  const now = useNow();
  const [showHidden, setShowHidden] = useState(false);
  // True while a pull to refresh asks GitHub. That takes seconds, before the list itself reloads.
  const [pulling, setPulling] = useState(false);
  const onPull = () => {
    setPulling(true);
    void workflow.refreshPullRequests().finally(() => setPulling(false));
  };
  const [filters, setFilters] = useState<PrFilters>(NO_FILTERS);
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [reviewMode, setReviewMode] = useReviewSortMode();
  const [picker, setPicker] = useState<Picker | null>(null);
  const [repoQuery, setRepoQuery] = useState('');
  const priorityOffered = reviewPriorityOffered(features);
  const mode = effectiveReviewSort(reviewMode, priorityOffered);

  const rows = state.data;
  const definitions = workspace.data?.settings?.prFilters ?? NO_DEFINITIONS;
  const requestedOptions = useMemo(() => tab === 'reviews' ? requestedViaOptions(rows ?? []) : [], [tab, rows]);
  const live = useMemo(() => liveFilters(filters, { savedIds: definitions.map((item) => item.id), requestedVia: requestedOptions }),
    [filters, definitions, requestedOptions]);
  const active = filtersActive(live);
  const cohort = useMemo(() => (tab === 'mine' ? mineCohort : tab === 'reviews' ? reviewCohort : queueCohort)(rows ?? []), [tab, rows]);
  const counts = useMemo(() => mineChipCounts(rows ?? []), [rows]);
  const repos = useMemo(() => repoChoices(cohort), [cohort]);
  const mine = useMemo(() => tab === 'mine' ? filterMine(rows ?? [], live, definitions, sortDir) : null, [tab, rows, live, definitions, sortDir]);
  // The review order is computed when the rows change, never on the clock, so the list does not move under a finger.
  const reviews = useMemo(() => tab === 'reviews' ? filterReviews(rows ?? [], live, definitions, { mode, now: Date.now() }) : null,
    [tab, rows, live, definitions, mode]);
  const queue = useMemo(() => tab === 'queue' ? queueSections(filterQueue(rows ?? [], live.search)) : null, [tab, rows, live.search]);
  const hidden = useMemo(() => tab === 'reviews' ? hiddenReviewCohort(rows ?? []) : [], [tab, rows]);
  const hiddenCount = hidden.length;
  const parents = useMemo(() => tab === 'queue' ? queueParentStatus(queueCohort(rows ?? [])) : null, [tab, rows]);
  const listKey = `list:pulls:${tab}`;
  // Read once. A changed `contentOffset` prop moves the list, so a later render must not hand back an older position.
  const [initialOffset] = useState(() => workflow.local(listKey).offset);
  const clear = () => setFilters(NO_FILTERS);
  const patch = (next: Partial<PrFilters>) => setFilters((current) => ({ ...current, ...next }));

  const sortLabel = tab === 'mine' ? SORT_LABEL[sortDir === 'desc' ? 'newest' : 'oldest'] : SORT_LABEL[mode];
  const selectedSaved = definitions.filter((item) => live.saved.includes(item.id));
  const requestedLabel = requestedOptions.find((option) => option.value === live.requestedVia)?.label;
  const header = <View>
    <StateNotice resource={state} offline={offline} refresh={state.refresh} />
    {cohort.length > 0 || active ? <FilterBar search={filters.search} onSearch={(search) => patch({ search })}>
      {tab === 'queue' ? null : <>
        <FilterChip label={sortLabel} menu accessibilityLabel={`Sort: ${sortLabel}`} onPress={() => setPicker('sort')} />
        <FilterChip label={live.repo?.name ?? 'All repos'} menu active={Boolean(live.repo)}
          accessibilityLabel={`Repository: ${live.repo?.name ?? 'All repos'}`} onPress={() => { setRepoQuery(''); setPicker('repo'); }} />
        {tab === 'mine' ? MINE_CHIPS.map((chip) => <FilterChip key={chip.key} label={chip.label} count={counts[chip.key]}
          active={live.chips.includes(chip.key)} onPress={() => patch({ chips: toggled(live.chips, chip.key) })} />) : null}
        {tab === 'reviews' && requestedOptions.length > 0 ? <FilterChip label={requestedLabel ?? 'Requested via'} menu
          active={Boolean(requestedLabel)} accessibilityLabel={`Requested via: ${requestedLabel ?? 'Any requested'}`}
          onPress={() => setPicker('requested')} /> : null}
        {definitions.length > 0 ? <FilterChip menu active={selectedSaved.length > 0}
          label={selectedSaved.length === 0 ? 'Saved filters' : selectedSaved.length === 1 ? selectedSaved[0].name : `${selectedSaved.length} saved filters`}
          onPress={() => setPicker('saved')} /> : null}
        {active ? <FilterChip label="Clear" icon="clear" accessibilityLabel="Clear all filters" onPress={clear} /> : null}
      </>}
    </FilterBar> : null}
  </View>;

  const sheet = pickerSheet(picker, {
    tab, sortDir, mode, priorityOffered, repos, repoQuery, live, requestedOptions, definitions,
    setSortDir, setReviewMode, setRepoQuery, patch,
  });

  const empty = state.status !== 'ready' ? undefined : cohort.length > 0 || active
    ? <EmptyState title={NO_MATCH}><View style={{ paddingTop: 6 }}><Button variant="secondary" size="sm" title="Clear filters" onPress={clear} /></View></EmptyState>
    : tab === 'reviews' && hiddenCount
      ? <EmptyState title={`Nothing to review. ${hiddenCount} hidden ${hiddenCount === 1 ? 'PR is' : 'PRs are'} below.`} />
      : <EmptyState title={EMPTY[tab].title} detail={EMPTY[tab].detail} />;

  const common = {
    accessibilityRole: 'list' as const, accessibilityLabel: PULLS_TITLES[tab], initialNumToRender: 14, maxToRenderPerBatch: 10, windowSize: 7,
    contentContainerStyle: styles.content, keyboardShouldPersistTaps: 'handled' as const, keyboardDismissMode: 'on-drag' as const,
    contentOffset: { x: 0, y: initialOffset }, scrollEventThrottle: 150,
    onScroll: (event: { nativeEvent: { contentOffset: { y: number } } }) => workflow.rememberOffset(listKey, event.nativeEvent.contentOffset.y),
    refreshControl: <RefreshControl refreshing={pulling || (state.refreshing && state.data !== undefined)} onRefresh={onPull}
      tintColor={colors.muted} colors={[colors.primaryAction]} progressBackgroundColor={colors.elevated} />,
    ListHeaderComponent: header, ListEmptyComponent: empty,
  };
  const onQueue = useStableHandler((pr: PRRow) => { void queueToggle.toggle(pr, !(tab === 'queue' || pr.mergeQueued)); });
  const onLongPress = useStableHandler((pr: PRRow) => {
    const extra: SheetAction[] = queueToggle.canQueue(pr) ? [{
      label: tab === 'queue' || pr.mergeQueued ? 'Leave merge queue' : 'Add to merge queue', icon: QUEUE_ICON,
      disabled: queueToggle.busyId === pr.id, onPress: () => onQueue(pr),
    }] : [];
    links.open(prLinkTarget(pr), extra);
  });
  const drawRow = (item: PRRow, variant: PrRowVariant, divider: boolean, extra: { stackedOn?: number | null; parentStatus?: MergeQueuePublic['status'] } = {}) =>
    <PullRequestListRow row={item} now={now} variant={variant} divider={divider} stackedOn={extra.stackedOn} parentStatus={extra.parentStatus}
      swipe={queueToggle.canQueue(item)} busy={queueToggle.busyId === item.id} onLongPress={onLongPress} onQueue={onQueue} />;

  return <ScreenContainer>
    <Stack.Screen options={{ title: PULLS_TITLES[tab] }} />
    {queue ? <SectionList {...common} sections={queue} keyExtractor={(item) => item.id} stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => <SectionLabel title={section.title} uppercase={false}
        trailing={<View style={local.sectionMeta}>
          {section.warning ? <AppText variant="caption" tone="warning">{section.warning}</AppText> : null}
          {section.detail ? <AppText variant="caption" tone="muted">{section.detail}</AppText> : null}
        </View>} />}
      renderItem={({ item, index, section }) => drawRow(item, 'queue', index < section.data.length - 1, { parentStatus: parents?.get(item.id) })} />
      : <FlatList {...common} data={mine?.rows ?? reviews ?? []} keyExtractor={(item) => item.id}
        // Hidden review requests sit under a toggle at the foot, like web. A short list, so it is not virtualized.
        ListFooterComponent={hiddenCount > 0 ? <View>
          <HiddenToggle count={hiddenCount} open={showHidden} onPress={() => setShowHidden(!showHidden)} />
          {showHidden ? hidden.map((row, index) => <PrRow key={row.id} row={row} now={now} variant="review" divider={index < hidden.length - 1}
            onLongPress={onLongPress} onQueue={queueToggle.canQueue(row) ? onQueue : undefined} />) : null}
        </View> : undefined}
        renderItem={({ item, index }) => drawRow(item, tab === 'mine' ? 'mine' : 'review',
          index < (mine?.rows ?? reviews ?? []).length - 1, { stackedOn: mine?.meta.get(item.id)?.parentNumber })} />}
    {sheet ? <PickerSheet visible onClose={() => setPicker(null)} {...sheet} /> : null}
    {links.toast}
    {queueToggle.toast}
    {links.sheet}
  </ScreenContainer>;
}

/** A function with a fixed identity that always calls the latest `handler`, so memoized rows keep their props. */
function useStableHandler<A extends unknown[]>(handler: (...args: A) => void): (...args: A) => void {
  const latest = useRef(handler);
  latest.current = handler;
  return useCallback((...args: A) => latest.current(...args), []);
}

type ListRowProps = {
  row: PRRow; now: number; variant: PrRowVariant; divider: boolean; stackedOn?: number | null; parentStatus?: MergeQueuePublic['status'];
  /** The row can join or leave the merge queue, so it gets the swipe action. */
  swipe: boolean; busy: boolean;
  onLongPress(row: PRRow): void; onQueue(row: PRRow): void;
};

/**
 * One list row. Memoized: a live update or a refetch re-renders only the rows
 * whose data changed, not every mounted row and its swipe handler.
 */
const PullRequestListRow = memo(function PullRequestListRow({ swipe, busy, ...props }: ListRowProps) {
  const content = <PrRow {...props} onQueue={swipe ? props.onQueue : undefined} />;
  return swipe ? <QueueSwipeRow row={props.row} queued={props.variant === 'queue' || props.row.mergeQueued} busy={busy}
    onQueue={props.onQueue}>{content}</QueueSwipeRow> : content;
});

/** The picker a menu chip opens. Saved filters stay open, so several can be ticked. */
function pickerSheet(picker: Picker | null, p: {
  tab: PullsTab; sortDir: SortDir; mode: ReviewSortMode; priorityOffered: boolean; repos: { id: string; name: string }[]; repoQuery: string;
  live: PrFilters; requestedOptions: { value: string; label: string }[]; definitions: PRFilterDefinition[];
  setSortDir(dir: SortDir): void; setReviewMode(mode: ReviewSortMode): void; setRepoQuery(value: string): void; patch(next: Partial<PrFilters>): void;
}): { title: string; sections: PickerSection[]; search?: { value: string; onChange(value: string): void; placeholder: string }; closeOnSelect?: boolean } | null {
  if (picker === 'sort') {
    const modes: ReviewSortMode[] = p.tab === 'mine' ? ['newest', 'oldest'] : reviewSortModes(p.priorityOffered);
    const current: ReviewSortMode = p.tab === 'mine' ? (p.sortDir === 'desc' ? 'newest' : 'oldest') : p.mode;
    return { title: 'Sort by', sections: [{ key: 'sort', items: modes.map((mode) => ({
      key: mode, label: SORT_LABEL[mode], detail: SORT_DETAIL[mode], selected: mode === current,
      onPress: () => { if (p.tab === 'mine') p.setSortDir(mode === 'oldest' ? 'asc' : 'desc'); else p.setReviewMode(mode); },
    })) }] };
  }
  if (picker === 'repo') {
    const q = p.repoQuery.trim().toLowerCase();
    const matches = p.repos.filter((repo) => !q || repo.name.toLowerCase().includes(q));
    return { title: 'Repository', search: { value: p.repoQuery, onChange: p.setRepoQuery, placeholder: 'Search repositories' },
      sections: [{ key: 'repos', note: matches.length || !q ? undefined : 'No repository matches.', items: [
        ...(q ? [] : [{ key: 'all', label: 'All repos', selected: !p.live.repo, onPress: () => p.patch({ repo: null }) }]),
        ...matches.map((repo) => ({ key: repo.id, label: repo.name, selected: p.live.repo?.id === repo.id, onPress: () => p.patch({ repo }) })),
      ] }] };
  }
  if (picker === 'requested') {
    return { title: 'Requested via', sections: [{ key: 'via', items: [
      { key: 'all', label: 'Any requested', selected: !p.live.requestedVia, onPress: () => p.patch({ requestedVia: null }) },
      ...p.requestedOptions.map((option) => ({ key: option.value, label: option.label, selected: p.live.requestedVia === option.value,
        onPress: () => p.patch({ requestedVia: option.value }) })),
    ] }] };
  }
  if (picker === 'saved') {
    return { title: 'Saved filters', closeOnSelect: false, sections: [{ key: 'saved',
      note: 'A pull request shows when it matches any ticked filter. Create and edit filters on the web.',
      items: p.definitions.map((definition) => ({ key: definition.id, label: definition.name, selected: p.live.saved.includes(definition.id),
        onPress: () => p.patch({ saved: toggled(p.live.saved, definition.id) }) })) }] };
  }
  return null;
}

function HiddenToggle({ count, open, onPress }: { count: number; open: boolean; onPress(): void }) {
  const c = useTheme();
  const label = `${open ? 'Hide' : 'Show'} ${count} hidden pull request${count === 1 ? '' : 's'}`;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }} onPress={onPress}
    style={[local.toggle, { borderTopColor: c.border }]}>
    <SymbolView name={open ? { ios: 'chevron.down', android: 'expand_more' } : { ios: 'chevron.right', android: 'chevron_right' }} size={14} tintColor={c.muted} />
    <AppText variant="meta" tone="muted">{label}</AppText>
  </Pressable>;
}

const local = StyleSheet.create({
  sectionMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 4, marginTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
});
