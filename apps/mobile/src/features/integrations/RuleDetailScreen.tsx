import {
  LOOP_TARGET_LABELS, describeSchedule, describeWorkflowActions, describeWorkflowTrigger,
  type LoopRun, type LoopWithStats, type WorkflowIntegration, type WorkflowRun, type WorkflowWithStats,
} from '@talyn/shared';
import { Stack } from 'expo-router';
import { View } from 'react-native';

import { useNetwork } from '../../auth/AuthProvider';
import { AppText, EmptyState, Group, Pill, PrNumber, Row, ui } from '../../components/UI';
import { openExternal, StateNotice } from '../../components/Workflow';
import { modelLabel } from '../../lib/models';
import { longTime, shortTime, useNow } from '../../lib/time';
import { sessionRoute } from '../../navigation/routes';
import { Fact, Loading, Page, WebRow } from '../more/Page';
import { useLoopList, useRuns, useWorkflowList } from '../automations/data';
import {
  loopDisabledText, loopRunBadge, loopRunText, nextRunText, problemsText, workflowRunBadge, workflowRunText, type AutomationKind, type Badge,
} from '../automations/model';

export function RuleDetailScreen({ kind, id, integration = 'github' }: { kind: AutomationKind; id: string; integration?: WorkflowIntegration }) {
  const offline = useNetwork() === 'offline';
  const workflowList = useWorkflowList(integration, kind === 'workflow');
  const loopList = useLoopList(kind === 'loop');
  const list = kind === 'workflow' ? workflowList : loopList;
  const item = (list.data as Array<WorkflowWithStats | LoopWithStats> | undefined)?.find((row) => row.id === id);
  const runs = useRuns(kind, id);
  const refresh = () => { void list.refresh(); void runs.refresh(); };
  const missing = list.status === 'ready' && !item;
  return <Page refreshing={(list.refreshing || runs.refreshing) && Boolean(item)} onRefresh={refresh}>
    {item ? <Stack.Screen options={{ title: item.name }} /> : null}
    {!item && list.status === 'loading' ? <Loading /> : <StateNotice resource={list} offline={offline} refresh={refresh} />}
    {missing ? <EmptyState title="Automation not found" detail="It may have been deleted." /> : null}
    {item ? <>
      {kind === 'workflow' ? <WorkflowFacts workflow={item as WorkflowWithStats} /> : <LoopFacts loop={item as LoopWithStats} />}
      <Group title="Recent runs">
        {runs.data === undefined ? runs.status === 'loading' ? <Loading /> : <StateNotice resource={runs} offline={offline} refresh={() => { void runs.refresh(); }} />
          : runs.data.length === 0 ? <Row title="No runs yet" divider={false} />
            : runs.data.map((run, index) => kind === 'workflow'
              ? <WorkflowRunRow key={run.id} run={run as WorkflowRun} divider={index < runs.data!.length - 1} />
              : <LoopRunRow key={run.id} run={run as LoopRun} divider={index < runs.data!.length - 1} />)}
      </Group>
      <Group>
        <WebRow title="Edit on the web" path={`/integrations/${kind === 'loop' ? 'schedule' : integration}`} />
      </Group>
    </> : null}
  </Page>;
}

function WorkflowFacts({ workflow }: { workflow: WorkflowWithStats }) {
  const problems = problemsText(workflow.stats.failures7d);
  return <Group title="Automation">
    <Fact label="Status" value={workflow.enabled ? 'On' : 'Off'} />
    <Fact label="When" value={describeWorkflowTrigger(workflow)} />
    <Fact label="Then" value={describeWorkflowActions(workflow) || 'Nothing'} />
    <Fact label="Runs" value={`${workflow.stats.runs24h} today · ${workflow.stats.runs7d} this week · ${workflow.stats.runsTotal} in all`} />
    <Fact label="Tasks started" value={String(workflow.stats.tasksStarted)} divider={Boolean(problems)} />
    {problems ? <Fact label="Problems" value={problems} tone="warning" divider={false} /> : null}
  </Group>;
}

function LoopFacts({ loop }: { loop: LoopWithStats }) {
  const now = useNow();
  const off = loopDisabledText(loop);
  const problems = problemsText(loop.stats.failures7d);
  return <Group title="Automation" footer={off ?? undefined}>
    <Fact label="Status" value={loop.enabled ? nextRunText(loop, now) : 'Off'} />
    <Fact label="Schedule" value={describeSchedule(loop.cron, loop.timezone)} />
    <Fact label="Repository" value={loop.repoFullName} />
    <Fact label="Starts" value={LOOP_TARGET_LABELS[loop.target] ?? loop.target} />
    <Fact label="Model" value={modelLabel(loop.model)} />
    <Fact label="Internet access" value={loop.internetAccess ? 'Allowed' : 'Repository only'} />
    <Fact label="Runs" value={`${loop.stats.runs7d} this week · ${loop.stats.runsTotal} in all`} divider={Boolean(problems)} />
    {problems ? <Fact label="Problems" value={problems} tone="warning" divider={false} /> : null}
  </Group>;
}

function WorkflowRunRow({ run, divider }: { run: WorkflowRun; divider: boolean }) {
  const now = useNow();
  const badge = workflowRunBadge(run.status);
  const text = workflowRunText(run);
  return <Row title={text.title} subtitle={text.detail} divider={divider} titleLines={1}
    onPress={run.prUrl ? () => openExternal(run.prUrl) : undefined} accessibilityRole={run.prUrl ? 'link' : undefined}
    accessibilityLabel={`${text.title}. ${badge.label}. ${longTime(run.createdAt)}`}
    trailing={<AppText variant="meta" tone="muted">{shortTime(run.createdAt, now)}</AppText>}>
    <RunPills badge={badge} number={run.prNumber} />
  </Row>;
}

function LoopRunRow({ run, divider }: { run: LoopRun; divider: boolean }) {
  const now = useNow();
  const badge = loopRunBadge(run.status);
  const text = loopRunText(run);
  const prUrl = run.task?.prUrl ?? null;
  const session = run.sessionId && !run.session?.archivedAt ? run.sessionId : null;
  const href = session ? sessionRoute(session) : undefined;
  return <Row title={text.title} subtitle={text.detail} divider={divider} titleLines={1} href={href}
    onPress={!href && prUrl ? () => openExternal(prUrl) : undefined}
    accessibilityLabel={`${text.title}. ${badge.label}. ${longTime(run.scheduledFor)}`}
    trailing={<AppText variant="meta" tone="muted">{shortTime(run.scheduledFor, now)}</AppText>}>
    <RunPills badge={badge} number={run.task?.prNumber ?? null} />
  </Row>;
}

function RunPills({ badge, number }: { badge: Badge; number: number | null }) {
  return <View style={ui.wrap}>
    <Pill label={badge.label} tone={badge.tone} accessibilityLabel={`Status: ${badge.label}`} />
    {number ? <PrNumber number={number} /> : null}
  </View>;
}
