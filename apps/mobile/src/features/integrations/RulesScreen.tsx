import type { LoopRunStatus, LoopWithStats, WorkflowIntegration, WorkflowRunStatus, WorkflowWithStats } from '@talyn/shared';
import { Switch, View } from 'react-native';

import { useNetwork } from '../../auth/AuthProvider';
import { AppText, EmptyState, Group, Pill, Row, ui } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { shortTime, useNow } from '../../lib/time';
import { useTheme } from '../../theme/tokens';
import { Loading, Page, WebRow } from '../more/Page';
import { integrationRuleRoute } from '../more/routes';
import type { Remote } from '../more/useRemote';
import { useLoopList, useToggle, useWorkflowList } from '../automations/data';
import {
  loopDisabledText, loopRunBadge, loopSummary, nextRunText, problemsText, workflowRunBadge, workflowSummary, type AutomationKind,
} from '../automations/model';

export function RulesScreen({ kind, integration = 'github' }: { kind: AutomationKind; integration?: WorkflowIntegration }) {
  const workflowList = useWorkflowList(integration, kind === 'workflow');
  const loopList = useLoopList(kind === 'loop');
  const list = kind === 'workflow' ? workflowList : loopList;
  return <Page refreshing={list.refreshing && list.data !== undefined} onRefresh={() => { void list.refresh(); }}>
    {kind === 'workflow'
      ? <AutomationList kind="workflow" integration={integration} list={workflowList} />
      : <AutomationList kind="loop" list={loopList} />}
    <Group footer={kind === 'loop' ? 'Create and edit scheduled rules in Talyn on the web.'
      : integration === 'slack' ? 'Create and edit Slack rules in Talyn on the web.' : 'Create and edit rules in Talyn on the web.'}>
      <WebRow title="Edit on the web" path={`/integrations/${kind === 'loop' ? 'schedule' : integration}`} />
    </Group>
  </Page>;
}

function AutomationList<T extends WorkflowWithStats | LoopWithStats>({ kind, integration = 'github', list }: {
  kind: AutomationKind; integration?: WorkflowIntegration; list: Remote<T[]>;
}) {
  const offline = useNetwork() === 'offline';
  const { toggle, busy } = useToggle(kind, list);
  const items = list.data;
  return <>
    {items === undefined && list.status === 'loading' ? <Loading /> : <StateNotice resource={list} offline={offline} refresh={() => { void list.refresh(); }} />}
    {items?.length === 0 ? <EmptyState title={kind === 'loop' ? 'No scheduled rules yet' : integration === 'slack' ? 'No Slack rules yet' : 'No rules yet'}
      detail={kind === 'loop' ? 'A scheduled rule runs the same prompt on a repository on a schedule.'
        : integration === 'slack' ? 'A Slack rule starts a session or replies when a message arrives in a channel.'
          : 'A workflow acts on pull requests for you, for example adding labels when one opens.'} /> : null}
    {items?.length ? <Group>
      {items.map((item, index) => <AutomationRow key={item.id} kind={kind} integration={integration} item={item} divider={index < items.length - 1}
        disabled={offline || Boolean(busy[item.id])} onToggle={(enabled) => { void toggle(item, enabled); }} />)}
    </Group> : null}
  </>;
}

function AutomationRow({ kind, integration, item, divider, disabled, onToggle }: {
  kind: AutomationKind; integration: WorkflowIntegration; item: WorkflowWithStats | LoopWithStats; divider: boolean; disabled: boolean; onToggle(enabled: boolean): void;
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
  return <Row title={item.name} subtitle={summary} href={integrationRuleRoute(kind, item.id, integration)} divider={divider}
    accessibilityLabel={`${item.name}. ${item.enabled ? 'On' : 'Off'}. ${summary}`}
    trailing={<Switch value={item.enabled} disabled={disabled} onValueChange={onToggle}
      accessibilityLabel={`${item.name} ${kind === 'workflow' ? 'workflow rule' : 'scheduled rule'}`} accessibilityHint={item.enabled ? 'Turns it off.' : 'Turns it on.'}
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
