import type { CloudProviderInfo, MergeQueueTimelineEvent, pullRequests } from '@talyn/client/native';
import { fixBlockedMessage, type CloudAgentChoice, type Environment, type Workspace } from '@talyn/shared';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { ScreenContainer } from '../../components/ScreenContainer';
import { PrPill, PrReviewPill, PrStatusPill } from '../../components/Status';
import { AppText, BottomBar, Button, Dot, Group, IconButton, Notice, Pill, Row, SectionLabel, useActionSheet } from '../../components/UI';
import { Heading, NativeText, openExternal, safeExternalUrl, StateNotice, workflowStyles as styles } from '../../components/Workflow';
import { errorMessage, showActionError } from '../../lib/errors';
import { prStatus } from '../../lib/status';
import { longTime, relativeTimeLabel, shortTime, useNow } from '../../lib/time';
import { completeIntent } from '../../navigation/intents';
import { sessionRoute } from '../../navigation/routes';
import { useTheme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { externalLabel, queueLabel, stackLabel } from '../../workflow/model';
import { WEB_APP_URL } from '../settings/about';
import { autoKeepLabel, checksLine, failingChecks, fixAgentChoices, mergeLine, prActions, queueStateLabel, startPrFix,
  type FixOutcome } from './actions';

type PrDetail = Awaited<ReturnType<typeof pullRequests.get>>;
type Busy = 'merge' | 'fix' | 'queue' | 'autoKeep' | 'resubmit' | null;
const TIMELINE_PREVIEW = 8;

function Timeline({ events, now }: { events: MergeQueueTimelineEvent[]; now: number }) {
  const c = useTheme();
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, TIMELINE_PREVIEW);
  return <View accessibilityRole="list" accessibilityLabel="Merge queue timeline">
    {shown.map((event, index) => <View key={`${event.at}:${event.trigger}:${index}`} style={local.event}
      accessible accessibilityLabel={`${queueLabel(event.toStatus)}. ${longTime(event.at)}.${event.message ? ` ${event.message}` : ''}`}>
      <View style={local.rail}>
        <Dot color={index === 0 ? c.primaryAction : c.muted} size={8} />
        {index < shown.length - 1 ? <View style={[local.line, { backgroundColor: c.border }]} /> : null}
      </View>
      <View style={{ flex: 1, gap: 2, paddingBottom: 12 }}>
        <View style={local.eventTitle}>
          <AppText variant="meta" style={{ flex: 1 }}>{queueLabel(event.toStatus)}</AppText>
          <AppText variant="caption" tone="muted">{shortTime(event.at, now)}</AppText>
        </View>
        {event.message ? <AppText variant="meta" tone="muted" numberOfLines={4}>{event.message}</AppText> : null}
      </View>
    </View>)}
    {events.length > TIMELINE_PREVIEW ? <View style={{ alignSelf: 'flex-start' }}>
      <Button variant="quiet" size="sm" title={all ? 'Show fewer' : `Show all ${events.length}`} onPress={() => setAll(!all)} />
    </View> : null}
  </View>;
}

export function PullRequestDetailScreen() {
  const params = useLocalSearchParams(); const id = typeof params.id === 'string' ? params.id : '';
  const { workflow } = useMobileRuntime();
  const state = useResource<PrDetail>('pr', id, Boolean(id), true);
  const row = state.data?.row;
  const queued = Boolean(row && (row.mergeQueued || row.mergeQueue));
  const timeline = useResource<{ events: MergeQueueTimelineEvent[] }>('timeline', id, queued);
  const writable = Boolean(row?.authored && row.state === 'open');
  const providers = useResource<CloudProviderInfo[]>('providers', '', writable);
  const workspace = useResource<Workspace>('workspace', '', writable);
  const environments = useResource<Environment[]>('environments', '', writable);
  const offline = useNetwork() === 'offline';
  const now = useNow();
  const colors = useTheme();
  const sheet = useActionSheet();
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<{ message: string; session?: { id: string; name: string } } | null>(null);
  useEffect(() => { if (row) completeIntent(`/attention/${encodeURIComponent(id)}`); }, [row, id]);
  useEffect(() => setNotice(null), [id]);

  const fresh = state.data?.fresh ?? null;
  const summary = fresh ?? row?.summary;
  const decision = summary ? summary.effectiveReviewDecision ?? summary.reviewDecision : undefined;
  const status = row && summary ? prStatus({ state: row.state, blockingReason: summary.blockingReason, checks: summary.checks,
    mergeStateStatus: summary.mergeStateStatus, ciStatus: summary.ciStatus, reviewDecision: decision, labels: summary.labels,
    externalQueueState: row.mergeQueue?.external?.state }) : null;
  const posthogConnected = (providers.data ?? []).some((provider) => provider.type === 'posthog_code' && provider.connected);
  const actions = row ? prActions(row, { posthogConnected }) : null;
  const updated = summary?.updatedAt ?? row?.updatedAt;
  const url = summary ? safeExternalUrl(summary.url) : null;
  const ref = row ? `#${row.number}` : '';

  const run = async (kind: Exclude<Busy, null>, title: string, action: () => Promise<void>) => {
    setBusy(kind);
    try { await action(); } catch (error) { showActionError(title, error); } finally { setBusy(null); }
  };
  const merge = () => {
    if (!row || !summary) return;
    Alert.alert(`Merge ${ref}?`, `Squash-merge "${summary.title}" into ${summary.baseBranch || 'its base branch'} on GitHub.`, [
      { text: 'Cancel', style: 'cancel', isPreferred: true },
      { text: 'Merge', onPress: () => void run('merge', `Could not merge ${ref}`, async () => {
        const result = await workflow.mergePr(row.id);
        if (result.submitted) setNotice({ message: `Submitted ${ref} to the merge queue. ${result.message}`.trim() });
        else if (result.alreadyTerminal) setNotice({ message: `${ref} was already ${result.merged ? 'merged' : 'closed'}.` });
        else if (!result.merged) throw new Error(result.message || 'GitHub did not merge the pull request.');
        else setNotice({ message: `Merged ${ref}.` });
      }) },
    ]);
  };
  const fix = (choice?: CloudAgentChoice) => {
    if (!row) return;
    void run('fix', `Could not start a run on ${ref}`, async () => {
      const outcome: FixOutcome = await startPrFix(workflow, row, { providers: providers.data ?? [], environments: environments.data ?? [],
        workspace: workspace.data, choice });
      if (outcome.kind === 'blocked') Alert.alert('Nothing to hand to an agent', fixBlockedMessage(outcome.reason));
      else if (outcome.kind === 'no_agent') Alert.alert('Connect an agent', 'Connect your Claude or ChatGPT subscription in Talyn on the web, in Settings, Integrations.', [
        { text: 'Close', style: 'cancel' }, { text: 'Open Talyn on the web', onPress: () => openExternal(WEB_APP_URL) },
      ]);
      else if (outcome.kind === 'session') setNotice({ message: `Sent to the session ${outcome.name}.`, session: outcome });
      else setNotice({ message: 'An agent is working on this pull request.' });
    });
  };
  const pickAgent = () => {
    const choices = fixAgentChoices(providers.data ?? [], workspace.data);
    if (row?.session || !choices.length) { fix(); return; }
    sheet.open({ title: 'Fix with which agent?', actions: choices.map((choice) => ({
      label: choice.displayName, detail: choice.models.find((model) => model.id === choice.model)?.label, onPress: () => fix(choice),
    })) });
  };
  const toggleQueue = (enabled: boolean) => row && void run('queue', `Could not ${enabled ? 'queue' : 'dequeue'} ${ref}`,
    () => workflow.setMergeQueue(row.id, enabled));
  const toggleAutoKeep = (enabled: boolean) => row && void run('autoKeep', 'Could not change auto-keep',
    () => workflow.setAutoKeep(row.id, enabled));
  const resubmit = () => row && void run('resubmit', 'Could not re-submit to Trunk', async () => {
    try { await workflow.resubmitMergeQueue(row.id); setNotice({ message: 'Re-submitted to Trunk.' }); }
    catch (error) { throw new Error(errorMessage(error, 'Please try again.')); }
  });
  const requeue = () => row && void run('queue', `Could not requeue ${ref}`, () => workflow.setMergeQueue(row.id, true));

  const entry = row?.mergeQueue;
  const failing = failingChecks(fresh?.checkContexts);
  const checks = checksLine(summary?.checks);
  const stack = row ? stackLabel(row) : '';
  const busyAny = busy !== null || offline;

  return <ScreenContainer>
    <ScrollView contentContainerStyle={[styles.content, local.content]}
      refreshControl={<RefreshControl refreshing={(state.refreshing || timeline.refreshing) && Boolean(row)}
        onRefresh={() => { void state.refresh(); if (queued) void timeline.refresh(); }} tintColor={colors.muted} colors={[colors.primaryAction]} />}>
      <StateNotice resource={state} offline={offline} refresh={state.refresh} />
      {row && summary && status && actions ? <>
        <View style={local.header}>
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
          </View>
        </View>
        {notice ? <Notice message={notice.message} tone="success">
          {notice.session ? <Row title={`Open ${notice.session.name}`} href={sessionRoute(notice.session.id)} chevron divider={false} /> : null}
        </Notice> : null}

        <View style={local.block}>
          <AppText variant="body">{mergeLine(row, summary)}</AppText>
          {stack !== 'Standalone' && stack !== 'Unknown' ? <AppText variant="meta" tone="muted">Stack: {stack}</AppText> : null}
          {checks ? <AppText variant="meta" tone="muted">{checks}</AppText> : null}
          {failing.length ? <View style={{ gap: 2 }} accessibilityLabel="Failing checks">
            {failing.slice(0, 6).map((check) => <View key={check.name} style={local.check}>
              <Dot color={check.required === false ? colors.warning : colors.destructive} size={6} />
              <AppText variant="mono" numberOfLines={1} style={{ flex: 1 }}>{check.name}</AppText>
              {check.required === false ? <AppText variant="caption" tone="muted">Not required</AppText> : null}
            </View>)}
            {failing.length > 6 ? <AppText variant="caption" tone="muted">{`${failing.length - 6} more failing`}</AppText> : null}
          </View> : null}
          {summary.humanGates?.length ? <View style={local.pills}>{summary.humanGates.map((gate, index) =>
            <Pill key={`${gate.id}:${index}`} label={`Needs a person: ${gate.label || gate.name}`} tone="warning" />)}</View> : null}
          {row.autoMergeState?.needsHuman ? <NativeText text={row.autoMergeState.needsHuman.reason} /> : null}
          {!fresh && state.status === 'ready' ? <AppText variant="caption" tone="muted">Live detail from GitHub is unavailable. Showing the last saved state.</AppText> : null}
        </View>

        {actions.queue || actions.autoKeep ? <Group title="Automation">
          {actions.queue ? <Row title="Merge queue" subtitle={queueStateLabel(row)} divider={actions.autoKeep}
            trailing={<Switch accessibilityLabel="Merge queue" value={row.mergeQueued} disabled={busyAny}
              onValueChange={toggleQueue} trackColor={{ true: colors.primaryAction, false: colors.surface }} />} /> : null}
          {actions.autoKeep ? <Row title="Keep mergeable" subtitle={autoKeepLabel(row)} divider={false}
            trailing={<Switch accessibilityLabel="Keep mergeable" value={row.autoKeepMergeable} disabled={busyAny}
              onValueChange={toggleAutoKeep} trackColor={{ true: colors.primaryAction, false: colors.surface }} />} /> : null}
        </Group> : null}

        {queued ? <View style={{ gap: 8 }}>
          <SectionLabel title="Merge queue" />
          <AppText variant="meta">{[entry?.position ? `#${entry.position}` : '', entry ? queueLabel(entry.status) : 'Waiting',
            entry?.external?.state ? `External queue: ${externalLabel(entry.external.state)}` : ''].filter(Boolean).join(' · ')}</AppText>
          {entry?.reason ? <AppText variant="meta" tone="muted">{entry.reason}</AppText> : null}
          {actions.resubmit || actions.requeue ? <View style={{ alignSelf: 'flex-start' }}>
            {actions.resubmit ? <Button variant="secondary" size="sm" title="Re-submit to Trunk" loading={busy === 'resubmit'} disabled={busyAny} onPress={resubmit} />
              : <Button variant="secondary" size="sm" title="Requeue" loading={busy === 'queue'} disabled={busyAny} onPress={requeue} />}
          </View> : null}
          <StateNotice resource={timeline} offline={offline} refresh={timeline.refresh} refreshLabel="Refresh queue timeline" />
          {timeline.data?.events.length ? <Timeline events={timeline.data.events} now={now} />
            : timeline.status === 'ready' ? <AppText variant="meta" tone="muted">No queue events yet.</AppText> : null}
        </View> : null}

        {row.session ? <Group title="Session">
          <Row title={row.session.name} href={sessionRoute(row.session.id)} chevron divider={false} />
        </Group> : null}
      </> : state.status === 'deleted' || state.status === 'unauthorized'
        ? <Row title="Back to Attention" href="/attention" chevron divider={false} /> : null}
    </ScrollView>
    {row && actions ? <BottomBar>
      {actions.merge ? <View style={{ flex: 1 }}><Button title="Merge" icon={{ ios: 'arrow.triangle.merge', android: 'merge' }}
        loading={busy === 'merge'} disabled={busyAny} onPress={merge} /></View> : null}
      {actions.fix ? <View style={{ flex: 1 }}><Button title="Fix with agent" variant={actions.merge || actions.fixBlocked ? 'secondary' : 'primary'}
        icon={{ ios: 'wand.and.stars', android: 'auto_fix_high' }} loading={busy === 'fix'} disabled={busyAny}
        accessibilityLabel={actions.fixBlocked ? `Fix with agent. ${fixBlockedMessage(actions.fixBlocked)}` : 'Fix with agent'}
        onPress={() => actions.fixBlocked ? Alert.alert('Nothing to hand to an agent', fixBlockedMessage(actions.fixBlocked)) : pickAgent()} /></View> : null}
      {url ? actions.merge || actions.fix
        ? <IconButton label="Open pull request website" symbol={{ ios: 'safari', android: 'open_in_new' }} onPress={() => openExternal(url)} />
        : <View style={{ flex: 1 }}><Button variant="secondary" title="Open on GitHub" accessibilityLabel="Open pull request website"
          icon={{ ios: 'safari', android: 'open_in_new' }} onPress={() => openExternal(url)} /></View> : null}
    </BottomBar> : null}
    {sheet.sheet}
  </ScreenContainer>;
}

const local = StyleSheet.create({
  content: { gap: 16 },
  header: { gap: 8 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  pills: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  block: { gap: 6 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  event: { flexDirection: 'row', gap: 10 },
  rail: { width: 10, alignItems: 'center', paddingTop: 5 },
  line: { width: StyleSheet.hairlineWidth * 2, flex: 1, marginTop: 4 },
  eventTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
