import type { LoopRunStatus, LoopWithStats, WorkflowRunStatus, WorkflowWithStats } from '@talyn/shared';
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { useNetwork } from '../../auth/AuthProvider';
import { AppText, EmptyState, Group, Pill, Row, Segmented, ui } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { useFeatures } from '../../lib/features';
import { shortTime, useNow } from '../../lib/time';
import { useTheme } from '../../theme/tokens';
import { automationTabs, type AutomationTab } from '../more/navItems';
import { Loading, Page, WebRow } from '../more/Page';
import { automationRoute } from '../more/routes';
import type { Remote } from '../more/useRemote';
import { useLoopList, useToggle, useWorkflowList } from './data';
import {
  loopDisabledText, loopRunBadge, loopSummary, nextRunText, problemsText, workflowRunBadge, workflowSummary, type AutomationKind,
} from './model';

const LABEL: Record<AutomationTab, string> = { workflows: 'Workflows', loops: 'Loops' };

export function AutomationsScreen() {
  const features = useFeatures();
  const tabs = automationTabs(features);
  const [picked, setPicked] = useState<AutomationTab | null>(null);
  const tab = picked && tabs.includes(picked) ? picked : tabs[0] ?? null;
  const workflowList = useWorkflowList(tab === 'workflows');
  const loopList = useLoopList(tab === 'loops');
  if (features === null) return <Page><Loading /></Page>;
  if (!tab) return <Page><EmptyState title="Automations are not available" detail="Your account does not have workflows or loops." /></Page>;
  const list = tab === 'workflows' ? workflowList : loopList;
  return <Page refreshing={list.refreshing && list.data !== undefined} onRefresh={() => { void list.refresh(); }}>
    {tabs.length > 1 ? <Segmented accessibilityLabel="Automations" value={tab} onChange={(value: AutomationTab) => setPicked(value)}
      options={tabs.map((value) => ({ value, label: LABEL[value] }))} /> : null}
    {tab === 'workflows'
      ? <AutomationList kind="workflow" list={workflowList} />
      : <AutomationList kind="loop" list={loopList} />}
    <Group footer={tab === 'workflows' ? 'Create and edit workflows in Talyn on the web.' : 'Create, edit and run loops in Talyn on the web.'}>
      <WebRow title="Edit on the web" path={tab === 'workflows' ? '/workflows' : '/loops'} />
    </Group>
  </Page>;
}

function AutomationList<T extends WorkflowWithStats | LoopWithStats>({ kind, list }: { kind: AutomationKind; list: Remote<T[]> }) {
  const offline = useNetwork() === 'offline';
  const { toggle, busy } = useToggle(kind, list);
  const items = list.data;
  return <>
    {items === undefined && list.status === 'loading' ? <Loading /> : <StateNotice resource={list} offline={offline} refresh={() => { void list.refresh(); }} />}
    {items?.length === 0 ? <EmptyState title={kind === 'workflow' ? 'No workflows yet' : 'No loops yet'}
      detail={kind === 'workflow' ? 'A workflow acts on pull requests for you, for example adding labels when one opens.'
        : 'A loop runs the same prompt on a repository on a schedule.'} /> : null}
    {items?.length ? <Group>
      {items.map((item, index) => <AutomationRow key={item.id} kind={kind} item={item} divider={index < items.length - 1}
        disabled={offline || Boolean(busy[item.id])} onToggle={(enabled) => { void toggle(item, enabled); }} />)}
    </Group> : null}
  </>;
}

function AutomationRow({ kind, item, divider, disabled, onToggle }: {
  kind: AutomationKind; item: WorkflowWithStats | LoopWithStats; divider: boolean; disabled: boolean; onToggle(enabled: boolean): void;
}) {
  const c = useTheme();
  const now = useNow();
  const summary = kind === 'workflow' ? workflowSummary(item as WorkflowWithStats) : loopSummary(item as LoopWithStats);
  const last = item.stats.lastStatus
    ? kind === 'workflow' ? workflowRunBadge(item.stats.lastStatus as WorkflowRunStatus) : loopRunBadge(item.stats.lastStatus as LoopRunStatus)
    : null;
  const problems = problemsText(item.stats.failures7d);
  const off = kind === 'loop' ? loopDisabledText(item as LoopWithStats) : null;
  const when = shortTime(item.stats.lastRunAt, now);
  return <Row title={item.name} subtitle={summary} href={automationRoute(kind, item.id)} divider={divider}
    accessibilityLabel={`${item.name}. ${item.enabled ? 'On' : 'Off'}. ${summary}`}
    trailing={<Switch value={item.enabled} disabled={disabled} onValueChange={onToggle}
      accessibilityLabel={`${item.name} ${kind === 'workflow' ? 'workflow' : 'loop'}`} accessibilityHint={item.enabled ? 'Turns it off.' : 'Turns it on.'}
      trackColor={{ false: c.surface, true: c.primaryAction }} thumbColor={c.elevated} ios_backgroundColor={c.surface} />}>
    <View style={ui.wrap}>
      {last ? <Pill label={when ? `${last.label} ${when}` : last.label} tone={last.tone} accessibilityLabel={`Last run: ${last.label}`} />
        : <Pill label="No runs yet" />}
      {kind === 'loop' ? <AppText variant="caption" tone="muted">{nextRunText(item as LoopWithStats, now)}</AppText> : null}
      {problems ? <Pill label={problems} tone="warning" /> : null}
    </View>
    {off ? <AppText variant="meta" tone="warning">{off}</AppText> : null}
  </Row>;
}
