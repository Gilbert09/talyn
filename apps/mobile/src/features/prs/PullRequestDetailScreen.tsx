import type { MergeQueueTimelineEvent, pullRequests } from '@talyn/client/native';
import { useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';

import { useNetwork } from '../../auth/AuthProvider';
import { ScreenContainer } from '../../components/ScreenContainer';
import { PrPill, PrReviewPill, PrStatusPill } from '../../components/Status';
import { AppText, Button, EmptyState, Group, Pill, Row, SectionLabel } from '../../components/UI';
import { Heading, NativeText, openExternal, safeExternalUrl, StateNotice, workflowStyles as styles } from '../../components/Workflow';
import { prStatus } from '../../lib/status';
import { longTime, relativeTimeLabel, shortTime, useNow } from '../../lib/time';
import { completeIntent } from '../../navigation/intents';
import { sessionRoute } from '../../navigation/routes';
import { useResource } from '../../workflow/hooks';
import { externalLabel, queueLabel, stackLabel } from '../../workflow/model';

type PrDetail = Awaited<ReturnType<typeof pullRequests.get>>;

function Fact({ label, value }: { label: string; value: string }) {
  return <Row title={label} divider trailing={<AppText variant="meta" tone="muted" numberOfLines={2} style={{ maxWidth: '60%', textAlign: 'right' }}>{value}</AppText>} />;
}

export function PullRequestDetailScreen() {
  const params = useLocalSearchParams(); const id = typeof params.id === 'string' ? params.id : '';
  const state = useResource<PrDetail>('pr', id, Boolean(id), true);
  const timeline = useResource<{ events: MergeQueueTimelineEvent[] }>('timeline', id, Boolean(state.data));
  const offline = useNetwork() === 'offline';
  const now = useNow();
  const row = state.data?.row;
  useEffect(() => { if (row) completeIntent(`/attention/${encodeURIComponent(id)}`); }, [row, id]);
  const summary = state.data?.fresh ?? row?.summary;
  const decision = summary ? summary.effectiveReviewDecision ?? summary.reviewDecision : undefined;
  // One answer for conflicts, checks and mergeability. Review has its own pill.
  const status = row && summary ? prStatus({ state: row.state, blockingReason: summary.blockingReason, checks: summary.checks,
    mergeStateStatus: summary.mergeStateStatus, ciStatus: summary.ciStatus, reviewDecision: decision, labels: summary.labels,
    externalQueueState: row.mergeQueue?.external?.state }) : null;
  const updated = summary?.updatedAt ?? row?.updatedAt;
  return <ScreenContainer>
    <FlatList data={row ? timeline.data?.events ?? [] : []} keyExtractor={(event, index) => `${event.at}:${event.trigger}:${index}`}
      accessibilityRole="list" accessibilityLabel="Pull request and merge queue timeline" initialNumToRender={12} maxToRenderPerBatch={10} windowSize={7}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={(state.refreshing || timeline.refreshing) && Boolean(row)} onRefresh={() => { void state.refresh(); void timeline.refresh(); }} />}
      ListHeaderComponent={<View style={local.header}>
        <StateNotice resource={state} offline={offline} refresh={state.refresh} />
        {row && summary && status ? <>
          <Heading size="heading">{summary.title || 'Pull request'}</Heading>
          <View style={local.meta}>
            <AppText variant="meta" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>{row.owner}/{row.repo}</AppText>
            <PrPill number={row.number} state={row.state} draft={summary.draft} />
            <AppText variant="meta" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>{summary.author || 'Unknown author'}</AppText>
            {updated ? <AppText variant="meta" tone="muted" accessibilityLabel={`Updated ${relativeTimeLabel(updated, now)}`}>· {shortTime(updated, now)}</AppText> : null}
          </View>
          <View style={local.pills}>
            <PrStatusPill variant={status} />
            <PrReviewPill decision={decision} state={row.state} />
            {summary.draft ? <Pill label="Draft" /> : null}
          </View>
          {summary.humanGates?.length ? <View style={local.pills}>{summary.humanGates.map((gate, index) =>
            <Pill key={`${gate.id}:${index}`} label={`Needs a person: ${gate.label || gate.name}`} tone="warning" />)}</View> : null}
          {row.autoMergeState?.needsHuman ? <NativeText text={row.autoMergeState.needsHuman.reason} /> : null}
          {!state.data?.fresh ? <AppText variant="meta" tone="muted">Provider detail is unavailable. The server snapshot is shown.</AppText> : null}
          <Group title="Merge">
            <Fact label="Status" value={status.label} />
            <Fact label="Stack" value={stackLabel(row)} />
            <Fact label="Queue" value={row.mergeQueued ? queueLabel(row.mergeQueue?.status) : row.mergeQueue === undefined ? 'Unknown' : 'Not queued'} />
            {row.mergeQueue ? <Fact label="Queue position" value={String(row.mergeQueue.position)} /> : null}
            {row.mergeQueue?.external?.state ? <Fact label="External queue" value={externalLabel(row.mergeQueue.external.state)} /> : null}
          </Group>
          {row.mergeQueue?.reason ? <NativeText text={row.mergeQueue.reason} /> : null}
          <View style={local.actions}>
            {row.session ? <Row title={`Session: ${row.session.name}`} href={sessionRoute(row.session.id)} chevron divider={false} /> : null}
            {safeExternalUrl(summary.url) ? <View style={{ alignSelf: 'flex-start' }}><Button variant="secondary" size="sm" title="Open on GitHub" accessibilityLabel="Open pull request website"
              icon={{ ios: 'safari', android: 'open_in_new' }} onPress={() => openExternal(summary.url)} /></View> : null}
          </View>
          <SectionLabel title="Merge queue timeline" />
          <StateNotice resource={timeline} offline={offline} refresh={timeline.refresh} refreshLabel="Refresh queue timeline" />
          {timeline.status === 'ready' && !timeline.data?.events.length ? <EmptyState title="No queue events" detail="This pull request has not been in the merge queue." /> : null}
        </> : state.status === 'deleted' || state.status === 'unauthorized'
          ? <Row title="Back to Attention" href="/attention" chevron divider={false} /> : null}
      </View>}
      renderItem={({ item, index }) => <Row title={queueLabel(item.toStatus)} divider={index < (timeline.data?.events.length ?? 0) - 1}
        accessibilityLabel={`${queueLabel(item.toStatus)}. ${longTime(item.at)}.`}
        trailing={<AppText variant="meta" tone="muted">{shortTime(item.at, now)}</AppText>}>
        {item.message ? <NativeText text={item.message} /> : null}
      </Row>} />
  </ScreenContainer>;
}

const local = StyleSheet.create({
  header: { gap: 10, marginBottom: 4 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  pills: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  actions: { gap: 8 },
});
