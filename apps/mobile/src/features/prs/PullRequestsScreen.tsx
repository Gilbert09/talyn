import type { PRRow } from '@talyn/client/native';
import { reviewPriorityOffered } from '@talyn/shared';
import { Stack } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, SectionList, StyleSheet, View } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { ScreenContainer } from '../../components/ScreenContainer';
import { AppText, EmptyState, SectionLabel } from '../../components/UI';
import { StateNotice, workflowStyles as styles } from '../../components/Workflow';
import { useFeatures } from '../../lib/features';
import { useNow } from '../../lib/time';
import { useTheme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { buildQueueGroups, hiddenReviewCohort, mineSections, PULLS_TITLES, queueCohort, queueParentStatus, reviewCohort,
  sortReviews, type PullsTab } from './lists';
import { PrRow, type PrRowVariant } from './PrRow';

interface ListSection { key: string; title: string; detail?: string; warning?: string; data: PRRow[] }

const EMPTY: Record<PullsTab, { title: string; detail: string }> = {
  mine: { title: 'No open pull requests', detail: 'Pull requests you open or watch show here.' },
  reviews: { title: 'Nothing to review', detail: 'Pull requests where someone asks for your review show here.' },
  queue: { title: 'The merge queue is empty.', detail: 'Queue a pull request from its page and it merges by itself when it is clean. Conflicts get fixed on the way.' },
};
const VARIANT: Record<PullsTab, PrRowVariant> = { mine: 'mine', reviews: 'review', queue: 'queue' };

/** The sections one page draws. Pure, so the order is testable. */
export function pullsSections(tab: PullsTab, rows: PRRow[], options: { priority: boolean; now: number }): ListSection[] {
  if (tab === 'mine') return mineSections(rows).map(({ key, title, rows: data }) => ({ key, title, data }));
  if (tab === 'reviews') {
    const visible = sortReviews(reviewCohort(rows), options);
    return visible.length ? [{ key: 'requested', title: '', data: visible }] : [];
  }
  return buildQueueGroups(queueCohort(rows)).map((group) => ({
    key: group.key, title: `${group.owner}/${group.repo} → ${group.base || 'default'}`, data: group.rows,
    detail: group.kind === 'stack' ? `Stack of ${group.size}` : undefined,
    warning: group.kind === 'stack' && group.stalledAt ? `Stalled at #${group.stalledAt.number}` : undefined,
  }));
}

/**
 * One page of pull requests: My PRs, Review requests or the merge queue. All
 * three read the same live list of open PRs, as on web, and filter it here.
 */
export function PullRequestsScreen({ tab }: { tab: PullsTab }) {
  const state = useResource<PRRow[]>('attention');
  const offline = useNetwork() === 'offline';
  const { workflow } = useMobileRuntime();
  const features = useFeatures();
  const colors = useTheme();
  const now = useNow();
  const [showHidden, setShowHidden] = useState(false);
  const priority = reviewPriorityOffered(features);
  // The review order is computed when the rows change, never on the clock, so the list does not move under a finger.
  const sections = useMemo(() => pullsSections(tab, state.data ?? [], { priority, now: Date.now() }), [tab, state.data, priority]);
  const hidden = useMemo(() => tab === 'reviews' ? hiddenReviewCohort(state.data ?? []) : [], [tab, state.data]);
  const hiddenCount = hidden.length;
  const parents = useMemo(() => tab === 'queue' ? queueParentStatus(queueCohort(state.data ?? [])) : null, [tab, state.data]);
  const empty = EMPTY[tab];
  const listKey = `list:pulls:${tab}`;
  return <ScreenContainer>
    <Stack.Screen options={{ title: PULLS_TITLES[tab] }} />
    <SectionList sections={sections} keyExtractor={(item) => item.id} accessibilityRole="list" accessibilityLabel={PULLS_TITLES[tab]}
      initialNumToRender={14} maxToRenderPerBatch={10} windowSize={7} contentContainerStyle={styles.content} stickySectionHeadersEnabled={false}
      contentOffset={{ x: 0, y: workflow.local(listKey).offset }} scrollEventThrottle={150}
      onScroll={(event) => workflow.updateLocal(listKey, { offset: event.nativeEvent.contentOffset.y })}
      refreshControl={<RefreshControl refreshing={state.refreshing && state.data !== undefined} onRefresh={() => { void state.refresh(); }}
        tintColor={colors.muted} colors={[colors.primaryAction]} progressBackgroundColor={colors.elevated} />}
      ListHeaderComponent={<StateNotice resource={state} offline={offline} refresh={state.refresh} />}
      renderSectionHeader={({ section }) => section.title ? <SectionLabel title={section.title} uppercase={tab !== 'queue'}
        trailing={<View style={local.sectionMeta}>
          {section.warning ? <AppText variant="caption" tone="warning">{section.warning}</AppText> : null}
          {section.detail ? <AppText variant="caption" tone="muted">{section.detail}</AppText> : null}
          {tab === 'mine' ? <AppText variant="caption" tone="muted">{section.data.length}</AppText> : null}
        </View>} /> : null}
      ListEmptyComponent={state.status === 'ready' ? <EmptyState title={tab === 'reviews' && hiddenCount
        ? `Nothing to review. ${hiddenCount} hidden ${hiddenCount === 1 ? 'PR is' : 'PRs are'} below.` : empty.title}
        detail={tab === 'reviews' && hiddenCount ? undefined : empty.detail} /> : undefined}
      // Hidden review requests sit under a toggle at the foot, like web. A short list, so it is not virtualized.
      ListFooterComponent={hiddenCount > 0 ? <View>
        <HiddenToggle count={hiddenCount} open={showHidden} onPress={() => setShowHidden(!showHidden)} />
        {showHidden ? hidden.map((row, index) => <PrRow key={row.id} row={row} now={now} variant="review" divider={index < hidden.length - 1} />) : null}
      </View> : undefined}
      renderItem={({ item, index, section }) => <PrRow row={item} now={now} variant={VARIANT[tab]} parentStatus={parents?.get(item.id)}
        divider={index < section.data.length - 1} />} />
  </ScreenContainer>;
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
