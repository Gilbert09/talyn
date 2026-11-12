import type { LoopRunStatus, LoopWithStats, WorkflowIntegration, WorkflowRunStatus, WorkflowWithStats } from '@talyn/shared';
import { Switch, View } from 'react-native';

import { useNetwork } from '../../auth/AuthProvider';
import { AppText, Button, EmptyState, Group, Pill, Row, ui } from '../../components/UI';
import { openExternal, StateNotice } from '../../components/Workflow';
import { shortTime, useNow } from '../../lib/time';
import { useTheme } from '../../theme/tokens';
import { Loading, Page, WebRow, webUrl } from '../more/Page';
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
    <Group footer="Create and edit automations in Talyn on the web.">
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
    {items?.length === 0 ? <EmptyState title="No automations yet"
      detail={kind === 'loop' ? 'An automation runs on a schedule and starts a session or a task.'
        : integration === 'slack' ? 'An automation watches Slack messages and can start a session, reply or react.'
          : integration === 'webhook' ? 'An automation gets its own URL. A request to it starts a session or a task.'
            : 'An automation watches pull request events and can label, comment, request reviewers, start a session and more.'}>
      <Button title="Create an automation" onPress={() => openExternal(webUrl(`/integrations/${kind === 'loop' ? 'schedule' : integration}`))} />
    </EmptyState> : null}
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
      accessibilityLabel={`${item.name} automation`} accessibilityHint={item.enabled ? 'Turns it off.' : 'Turns it on.'}
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
