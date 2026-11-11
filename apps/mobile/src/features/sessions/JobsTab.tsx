import type { WorkbenchBackground, WorkbenchBackgroundJob, WorkbenchWakeup } from '@talyn/shared';
import { SymbolView } from 'expo-symbols';
import { useRef, useState, type ComponentRef } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { AppText, Button, Dot, SectionLabel, toneColor } from '../../components/UI';
import { errorMessage, showActionError } from '../../lib/errors';
import { relativeTimeLabel, useNow } from '../../lib/time';
import { mono, useTheme } from '../../theme/tokens';
import { formatRunTime, jobStatus, keepAwakeLabel, sortWakeups, wakeupWhen } from './background';
import { useJobLogs, type Load } from './data';

function JobLogs({ workbenchId, job }: { workbenchId: string; job: WorkbenchBackgroundJob }) {
  const c = useTheme();
  const offline = useNetwork() === 'offline';
  const [live, setLive] = useState(false);
  const logs = useJobLogs(workbenchId, job.id, true, job.status === 'running', live);
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  if (logs.data?.asleep) {
    return <View style={[styles.logs, { backgroundColor: c.surface }]}>
      <AppText variant="meta" tone="muted">The box is asleep.</AppText>
      <View style={{ alignSelf: 'flex-start' }}><Button variant="quiet" size="sm" title="Wake and load logs" disabled={offline} onPress={() => setLive(true)} /></View>
    </View>;
  }
  const text = logs.data ? logs.data.lines.join('\n') : logs.status === 'loading' ? 'Loading logs' : '';
  return <View style={{ gap: 4 }}>
    <ScrollView ref={scroller} style={[styles.logs, { backgroundColor: c.surface }]} nestedScrollEnabled
      onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}>
      <Text selectable accessibilityLabel={`Output of ${job.name}`} style={[styles.logText, { color: logs.data ? c.text : c.muted }]}>
        {text || 'No output yet.'}</Text>
    </ScrollView>
    {logs.status === 'error' || logs.status === 'unauthorized' ? <AppText accessibilityRole="alert" variant="meta" tone="destructive">
      {errorMessage(logs.error, 'Could not load logs.')}</AppText> : null}
  </View>;
}

function JobRow({ workbenchId, job, divider, onStopped }: { workbenchId: string; job: WorkbenchBackgroundJob; divider: boolean; onStopped(job: WorkbenchBackgroundJob): void }) {
  const { workflow } = useMobileRuntime();
  const c = useTheme();
  const now = useNow();
  const offline = useNetwork() === 'offline';
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const running = job.status === 'running';
  const status = jobStatus(job);
  const awake = running ? keepAwakeLabel(job.keepAwakeUntil, now) : null;
  const started = relativeTimeLabel(job.startedAt, now);
  const stop = () => Alert.alert(`Stop ${job.name}?`, 'The job ends now. Its output so far stays.', [
    { text: 'Cancel', style: 'cancel', isPreferred: true },
    { text: 'Stop', style: 'destructive', onPress: () => {
      setStopping(true);
      workflow.api.workbenches.stopBackgroundJob(workbenchId, job.id).then(onStopped,
        (error: unknown) => showActionError('Could not stop the job', error)).finally(() => setStopping(false));
    } },
  ]);
  return <View style={[styles.job, { borderBottomColor: divider ? c.border : 'transparent' }]}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityHint={open ? 'Hides the output.' : 'Shows the output.'}
      accessibilityLabel={`${job.name}. ${status.label}. ${job.command}`} onPress={() => setOpen(!open)} style={styles.jobHead}>
      <View style={{ paddingTop: 6 }}><Dot color={toneColor(c, status.tone)} size={8} /></View>
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="rowTitle" numberOfLines={1}>{job.name}</AppText>
        <Text numberOfLines={open ? undefined : 1} style={[styles.command, { color: c.muted }]}>{job.command}</Text>
      </View>
      <SymbolView name={open ? { ios: 'chevron.down', android: 'expand_more' } : { ios: 'chevron.right', android: 'chevron_right' }} size={14} tintColor={c.muted} />
    </Pressable>
    <View style={styles.facts}>
      <AppText variant="caption" style={{ color: toneColor(c, status.tone) }}>{status.label}</AppText>
      <AppText variant="caption" tone="muted">{`${formatRunTime(job.startedAt, job.endedAt, now)}${started ? ` · started ${started}` : ''}`}</AppText>
      {(job.status === 'stopped' || job.status === 'lost') && job.detail ? <AppText variant="caption" tone="muted">{job.detail}</AppText> : null}
      {awake ? <AppText variant="caption" tone="muted">{awake}</AppText> : null}
    </View>
    {running ? <View style={{ alignSelf: 'flex-start', marginLeft: 16 }}>
      <Button variant="quiet" size="sm" title={stopping ? 'Stopping' : 'Stop'} loading={stopping} disabled={stopping || offline} onPress={stop} />
    </View> : null}
    {open ? <View style={{ marginLeft: 16 }}><JobLogs workbenchId={workbenchId} job={job} /></View> : null}
  </View>;
}

function WakeupRow({ wakeup, now, divider }: { wakeup: WorkbenchWakeup; now: number; divider: boolean }) {
  const c = useTheme();
  const scheduled = wakeup.status === 'scheduled';
  return <View style={[styles.wakeup, { borderBottomColor: divider ? c.border : 'transparent' }]}>
    <AppText variant="meta" tone={scheduled ? 'default' : 'muted'}>{wakeup.reason}</AppText>
    <AppText variant="caption" tone="muted">{[...(scheduled ? wakeupWhen(wakeup, now) : [wakeup.status[0].toUpperCase() + wakeup.status.slice(1)]),
      wakeup.createdBy === 'user' ? 'Set by you' : 'Set by the agent'].join(' · ')}</AppText>
    {wakeup.status === 'failed' && wakeup.failureDetail ? <AppText variant="caption" tone="destructive">{wakeup.failureDetail}</AppText> : null}
  </View>;
}

/** The Jobs tab: the session's background jobs with their output, and its wake-ups. Mirrors web `BackgroundTab`. */
export function JobsTab({ workbenchId, background }: { workbenchId: string; background: Load<WorkbenchBackground> }) {
  const c = useTheme();
  const now = useNow();
  const data = background.data;
  const jobs = data?.jobs ?? [];
  const wakeups = sortWakeups(data?.wakeups ?? []);
  const onStopped = (job: WorkbenchBackgroundJob) => {
    if (data) background.set({ ...data, jobs: data.jobs.map((item) => item.id === job.id ? job : item) });
  };
  return <ScrollView contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={background.refreshing && data !== undefined} onRefresh={() => { void background.refresh(); }}
      tintColor={c.muted} colors={[c.primaryAction]} progressBackgroundColor={c.elevated} />}>
    <SectionLabel title="Jobs" />
    {jobs.length ? <View accessibilityRole="list">{jobs.map((job, index) => <JobRow key={job.id} workbenchId={workbenchId} job={job}
      divider={index < jobs.length - 1} onStopped={onStopped} />)}</View>
      : <AppText variant="meta" tone="muted">No background jobs yet.</AppText>}
    {wakeups.length ? <>
      <SectionLabel title="Wake-ups" />
      <View accessibilityRole="list">{wakeups.map((wakeup, index) => <WakeupRow key={wakeup.id} wakeup={wakeup} now={now} divider={index < wakeups.length - 1} />)}</View>
    </> : null}
  </ScrollView>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingBottom: 40 },
  job: { paddingVertical: 10, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  jobHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, minHeight: 40 },
  command: { fontSize: 12, lineHeight: 16, ...mono(400) },
  facts: { marginLeft: 16, flexDirection: 'row', flexWrap: 'wrap', columnGap: 10, rowGap: 2 },
  logs: { maxHeight: 280, borderRadius: 6, padding: 8 },
  logText: { fontSize: 11, lineHeight: 16, ...mono(400) },
  wakeup: { paddingVertical: 10, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth },
});
