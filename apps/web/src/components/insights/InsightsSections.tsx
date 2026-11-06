import type { ReactNode } from 'react';
import {
  PLAN_TIER_LABELS,
  formatBoxHoursLabel,
  formatBoxHoursUsage,
  formatInsightsDuration,
  formatTokenCount,
  formatUsd,
  totalTokens,
  type InsightsAgentsResponse,
  type InsightsComputeResponse,
  type InsightsPercentiles,
  type InsightsResponseBySection,
  type InsightsSection,
  type InsightsSpeedResponse,
  type InsightsTopRepository,
  type InsightsTopResponse,
  type InsightsTopSession,
} from '@talyn/shared';
import {
  FINDING_SEVERITIES,
  FINDING_SEVERITY_LABELS,
  agentLabel,
  boxStartCauseLabel,
  groupFixRuns,
  kindLabel,
  modelLabel,
  sizeLabel,
  wakeSourceLabel,
} from '../../lib/insights';
import { formatShortDate } from '../../lib/usageBilling';
import { useNavigationStore } from '../../stores/navigation';
import { Badge } from '../ui/badge';
import { DayBars, HBars, Stat, StatGrid, SubHeading } from './InsightsCharts';

export interface SectionSpec<S extends InsightsSection> {
  title: string;
  description: string;
  emptyText: string;
  isEmpty: (data: InsightsResponseBySection[S]) => boolean;
  render: (data: InsightsResponseBySection[S]) => ReactNode;
}

const NOT_REPORTED = 'Not reported';

function costText(micros: number | null): string {
  return micros === null ? NOT_REPORTED : formatUsd(micros);
}

function count(n: number): string {
  return n.toLocaleString('en-US');
}

// ---------- Compute ----------

function PlanCard({ period }: { period: NonNullable<InsightsComputeResponse['period']> }) {
  const share = period.includedWsec > 0 ? Math.min(100, (period.usedWsec / period.includedWsec) * 100) : 0;
  return (
    <div className="space-y-2 rounded-md border p-3" data-attr="insights-plan-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Your plan: {PLAN_TIER_LABELS[period.tier]}</p>
        <p className="text-xs text-muted-foreground">
          {formatShortDate(period.periodStart)} to {formatShortDate(period.periodEnd)}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        This card covers your whole account, across all your workspaces. The figures above are for this workspace only.
      </p>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Included box-hours used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share)}
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
      </div>
      <p className="text-sm">{formatBoxHoursUsage(period.usedWsec, period.includedWsec)} used</p>
      <p className="text-sm text-muted-foreground">Credits spent this period: {formatUsd(period.creditMicrosUsed)}</p>
    </div>
  );
}

export const computeSection: SectionSpec<'compute'> = {
  title: 'Compute',
  description: 'Box time in this workspace, weighted by box size. One box-hour is one hour of a Standard box.',
  emptyText: 'No box time in this range.',
  isEmpty: (d) => d.totalWsec === 0 && d.boxes === 0,
  render: (d) => (
    <div className="space-y-4">
      <StatGrid>
        <Stat label="Box time" value={formatBoxHoursLabel(d.totalWsec)} dataAttr="insights-compute-total" />
        <Stat label="Box runs started" value={count(d.boxes)} />
      </StatGrid>
      <DayBars
        label="Box-hours per day (UTC)"
        days={d.days.map((day) => ({ date: day.date, value: day.wsec / 3600 }))}
        formatValue={(hours) => `${hours.toFixed(1)} box-hours`}
        dataAttr="insights-compute-days"
      />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <SubHeading>By kind</SubHeading>
          <HBars
            label="Box time by kind"
            rows={d.byKind.map((row) => ({
              key: row.kind,
              label: kindLabel(row.kind),
              labelText: kindLabel(row.kind),
              value: row.wsec,
              valueText: formatBoxHoursLabel(row.wsec),
              detail: `${count(row.boxes)} box run${row.boxes === 1 ? '' : 's'}`,
            }))}
          />
        </div>
        <div className="space-y-2">
          <SubHeading>By box size</SubHeading>
          <HBars
            label="Box time by size"
            rows={d.bySize.map((row) => ({
              key: row.size,
              label: sizeLabel(row.size),
              labelText: sizeLabel(row.size),
              value: row.wsec,
              valueText: formatBoxHoursLabel(row.wsec),
              detail: `${count(row.boxes)} box run${row.boxes === 1 ? '' : 's'}`,
            }))}
          />
        </div>
      </div>
    </div>
  ),
};

/** Shown even when the workspace used nothing: the plan is about the account. */
export function ComputeFooter({ data }: { data: InsightsComputeResponse }) {
  return data.period ? <PlanCard period={data.period} /> : null;
}

// ---------- Agents ----------

const TOKEN_KINDS = [
  { key: 'inputTokens', label: 'Input (not from cache)' },
  { key: 'outputTokens', label: 'Output' },
  { key: 'cacheReadTokens', label: 'Cache read' },
  { key: 'cacheWriteTokens', label: 'Cache write' },
] as const;

function costHint(d: InsightsAgentsResponse['totals']): string {
  if (d.costMicros === null) return 'The agents did not report a cost. Codex reports none.';
  if (d.turnsWithCost < d.turns) return `Cost estimate covers ${count(d.turnsWithCost)} of ${count(d.turns)} turns.`;
  return 'The agent\'s own estimate, not a bill.';
}

export const agentsSection: SectionSpec<'agents'> = {
  title: 'Agent usage',
  description:
    'Tokens and turns the agents reported in this workspace. Your workspace\'s own Claude or Codex subscription pays for these tokens, not Talyn.',
  emptyText: 'No agent turns in this range.',
  isEmpty: (d) => d.totals.turns === 0 && totalTokens(d.totals) === 0,
  render: (d) => (
    <div className="space-y-4">
      <StatGrid>
        <Stat label="Tokens" value={formatTokenCount(totalTokens(d.totals))} dataAttr="insights-agents-tokens" />
        <Stat
          label="Turns"
          value={count(d.totals.turns)}
          hint={d.totals.failedTurns > 0 ? `${count(d.totals.failedTurns)} failed` : undefined}
        />
        <Stat label="Agent steps" value={count(d.totals.agentSteps)} hint="Claude only" />
        <Stat
          label="Estimated cost at API prices"
          value={costText(d.totals.costMicros)}
          hint={costHint(d.totals)}
          dataAttr="insights-agents-cost"
        />
      </StatGrid>
      {d.turnDuration.count > 0 && (
        <p className="text-sm text-muted-foreground">
          Turn length: median {formatInsightsDuration(d.turnDuration.p50Ms)}, p90 {formatInsightsDuration(d.turnDuration.p90Ms)} (
          {sampleText(d.turnDuration.count)})
        </p>
      )}
      <DayBars
        label="Tokens per day (UTC)"
        days={d.days.map((day) => ({ date: day.date, value: totalTokens(day) }))}
        formatValue={(v) => `${count(v)} tokens`}
        dataAttr="insights-agents-days"
      />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <SubHeading>By token kind</SubHeading>
          <HBars
            label="Tokens by kind"
            rows={TOKEN_KINDS.map((kind) => ({
              key: kind.key,
              label: kind.label,
              labelText: kind.label,
              value: d.totals[kind.key],
              valueText: formatTokenCount(d.totals[kind.key]),
              tooltipValueText: `${count(d.totals[kind.key])} tokens`,
            }))}
          />
        </div>
        <div className="space-y-2">
          <SubHeading>By agent</SubHeading>
          <HBars
            label="Tokens by agent"
            rows={d.byAgent.map((row) => ({
              key: row.agent,
              label: agentLabel(row.agent),
              labelText: agentLabel(row.agent),
              value: totalTokens(row),
              valueText: formatTokenCount(totalTokens(row)),
              tooltipValueText: `${count(totalTokens(row))} tokens`,
              detail: `${count(row.turns)} turn${row.turns === 1 ? '' : 's'} · Estimated cost: ${costText(row.costMicros)}`,
            }))}
          />
        </div>
      </div>
      {d.byModel.length > 0 && (
        <div className="space-y-2">
          <SubHeading>By model</SubHeading>
          <HBars
            label="Tokens by model"
            dataAttr="insights-agents-models"
            rows={d.byModel.map((row) => ({
              key: `${row.agent}:${row.model}`,
              label: (
                <>
                  <span className="font-medium">{modelLabel(row.model)}</span>{' '}
                  <span className="text-muted-foreground">{agentLabel(row.agent)}</span>
                </>
              ),
              labelText: `${modelLabel(row.model)} (${agentLabel(row.agent)})`,
              value: totalTokens(row),
              valueText: formatTokenCount(totalTokens(row)),
              tooltipValueText: `${count(totalTokens(row))} tokens`,
              detail: `${count(row.turns)} turn${row.turns === 1 ? '' : 's'} · Estimated cost: ${costText(row.costMicros)}`,
            }))}
          />
        </div>
      )}
    </div>
  ),
};

// ---------- Output ----------

export const outputSection: SectionSpec<'output'> = {
  title: 'Output',
  description: 'What the work in this workspace produced.',
  emptyText: 'No output in this range.',
  isEmpty: (d) =>
    d.sessions.created === 0 &&
    d.sessions.withPullRequest === 0 &&
    d.sessions.pullRequestsMerged === 0 &&
    d.tasks.created === 0 &&
    d.tasks.completed === 0 &&
    d.tasks.failed === 0 &&
    d.fixRuns.every((r) => r.count === 0) &&
    d.mergeQueue.landed === 0 &&
    d.codeReview.reviews === 0 &&
    d.codeReview.findings.every((f) => f.count === 0),
  render: (d) => {
    const fixRuns = groupFixRuns(d.fixRuns).filter((r) => r.count > 0);
    const known = new Set<string>(FINDING_SEVERITIES);
    const findings = [
      ...FINDING_SEVERITIES.map((severity) => ({
        severity,
        label: FINDING_SEVERITY_LABELS[severity],
        count: d.codeReview.findings.find((f) => f.severity === severity)?.count ?? 0,
      })),
      ...d.codeReview.findings
        .filter((f) => !known.has(f.severity))
        .map((f) => ({ severity: f.severity, label: f.severity, count: f.count })),
    ];
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <SubHeading>Sessions</SubHeading>
          <StatGrid>
            <Stat label="Created" value={count(d.sessions.created)} dataAttr="insights-output-sessions-created" />
            <Stat label="With a pull request" value={count(d.sessions.withPullRequest)} />
            <Stat label="Pull requests merged" value={count(d.sessions.pullRequestsMerged)} />
          </StatGrid>
        </div>
        <div className="space-y-2">
          <SubHeading>Tasks</SubHeading>
          <StatGrid>
            <Stat label="Created" value={count(d.tasks.created)} />
            <Stat label="Completed" value={count(d.tasks.completed)} />
            <Stat label="Failed" value={count(d.tasks.failed)} />
            <Stat label="With a pull request" value={count(d.tasks.withPullRequest)} />
          </StatGrid>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <SubHeading>Fix runs</SubHeading>
            {fixRuns.length > 0 ? (
              <HBars
                label="Fix runs by source"
                dataAttr="insights-output-fix-runs"
                rows={fixRuns.map((r) => ({
                  key: r.label,
                  label: r.label,
                  labelText: r.label,
                  value: r.count,
                  valueText: count(r.count),
                }))}
              />
            ) : (
              <p className="text-sm text-muted-foreground">No fix runs.</p>
            )}
          </div>
          <div className="space-y-2">
            <SubHeading>Merge queue and code review</SubHeading>
            <StatGrid className="lg:grid-cols-2">
              <Stat label="Landed by the merge queue" value={count(d.mergeQueue.landed)} />
              <Stat label="Code reviews run" value={count(d.codeReview.reviews)} />
            </StatGrid>
            <HBars
              label="Findings by severity"
              dataAttr="insights-output-findings"
              rows={findings.map((f) => ({
                key: f.severity,
                label: f.label,
                labelText: `${f.label} findings`,
                value: f.count,
                valueText: count(f.count),
              }))}
            />
          </div>
        </div>
      </div>
    );
  },
};

// ---------- Speed ----------

function sampleText(n: number): string {
  return `${count(n)} sample${n === 1 ? '' : 's'}`;
}

function SpeedRow({
  label,
  description,
  value,
  children,
  dataAttr,
}: {
  label: string;
  description?: string;
  value: InsightsPercentiles;
  children?: ReactNode;
  dataAttr?: string;
}) {
  return (
    <li className="min-w-0 py-2" data-attr={dataAttr}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        <PercentileText value={value} />
      </div>
      {children}
    </li>
  );
}

function PercentileText({ value }: { value: InsightsPercentiles }) {
  return (
    <p className="text-sm tabular-nums">
      <span>Median {formatInsightsDuration(value.p50Ms)}</span>
      <span className="text-muted-foreground"> · p90 {formatInsightsDuration(value.p90Ms)} · {sampleText(value.count)}</span>
    </p>
  );
}

function Breakdown({ rows }: { rows: { key: string; label: string; value: InsightsPercentiles }[] }) {
  const shown = rows.filter((r) => r.value.count > 0);
  if (shown.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1 border-l pl-3">
      {shown.map((row) => (
        <li key={row.key} className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-muted-foreground">
          <span>{row.label}</span>
          <PercentileText value={row.value} />
        </li>
      ))}
    </ul>
  );
}

export const speedSection: SectionSpec<'speed'> = {
  title: 'Speed',
  description: 'How long people waited. Median and 90th percentile.',
  emptyText: 'No timing data in this range.',
  isEmpty: (d: InsightsSpeedResponse) =>
    d.boxStart.count === 0 &&
    d.wake.count === 0 &&
    d.firstReply.count === 0 &&
    d.firstReplyNewSession.count === 0 &&
    d.turnStart.count === 0,
  render: (d) => (
    <ul className="divide-y">
      <SpeedRow label="Box start" description="From the request to a box that is ready." value={d.boxStart} dataAttr="insights-speed-box-start">
        <Breakdown rows={d.boxStart.byCause.map((r) => ({ key: r.cause, label: boxStartCauseLabel(r.cause), value: r }))} />
      </SpeedRow>
      <SpeedRow label="Wake" description="Resume of a sleeping box." value={d.wake}>
        <Breakdown rows={d.wake.bySource.map((r) => ({ key: r.source, label: wakeSourceLabel(r.source), value: r }))} />
      </SpeedRow>
      <SpeedRow label="First reply" description="From a sent message to the agent's first reply." value={d.firstReply} />
      <SpeedRow
        label="First reply in a new session"
        description="The first message of a session. Includes the box start."
        value={d.firstReplyNewSession}
      />
      <SpeedRow label="Turn start" description="From a queued message to the agent starting." value={d.turnStart} />
    </ul>
  ),
};

// ---------- Top lists ----------

function RepoList({ title, rows, metric }: { title: string; rows: InsightsTopRepository[]; metric: 'wsec' | 'tokens' }) {
  return (
    <div className="min-w-0 space-y-2">
      <SubHeading>{title}</SubHeading>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing in this range.</p>
      ) : (
        <ol className="space-y-1 text-sm" aria-label={title}>
          {rows.map((row) => (
            <li key={row.repository} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 break-all">{row.repository}</span>
              <span className="shrink-0 tabular-nums">
                {metric === 'wsec' ? formatBoxHoursLabel(row.wsec) : `${formatTokenCount(row.tokens)} tokens`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function SessionName({ row }: { row: InsightsTopSession }) {
  const navigate = useNavigationStore((s) => s.navigate);
  if (row.title === null) return <span className="italic text-muted-foreground">Deleted session</span>;
  return (
    <button
      type="button"
      className="break-words text-left text-primary underline-offset-4 hover:underline"
      onClick={() => navigate({ view: 'workbench', id: row.workbenchId })}
    >
      {row.title}
    </button>
  );
}

function SessionList({ title, rows, metric }: { title: string; rows: InsightsTopSession[]; metric: 'wsec' | 'tokens' }) {
  return (
    <div className="min-w-0 space-y-2">
      <SubHeading>{title}</SubHeading>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing in this range.</p>
      ) : (
        <ol className="space-y-1.5 text-sm" aria-label={title}>
          {rows.map((row) => (
            <li key={row.workbenchId} className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <SessionName row={row} />
                  {row.archived && row.title !== null && <Badge variant="secondary">Archived</Badge>}
                </div>
                {row.repository && <p className="break-all text-xs text-muted-foreground">{row.repository}</p>}
              </div>
              <span className="shrink-0 tabular-nums">
                {metric === 'wsec' ? formatBoxHoursLabel(row.wsec) : `${formatTokenCount(row.tokens)} tokens`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export const topSection: SectionSpec<'top'> = {
  title: 'Top lists',
  description: 'The repositories and sessions that used the most.',
  emptyText: 'No usage in this range.',
  isEmpty: (d: InsightsTopResponse) =>
    d.repositoriesByHours.length === 0 &&
    d.repositoriesByTokens.length === 0 &&
    d.sessionsByHours.length === 0 &&
    d.sessionsByTokens.length === 0,
  render: (d) => (
    <div className="grid gap-6 md:grid-cols-2">
      <RepoList title="Repositories by box-hours" rows={d.repositoriesByHours} metric="wsec" />
      <RepoList title="Repositories by tokens" rows={d.repositoriesByTokens} metric="tokens" />
      <SessionList title="Sessions by box-hours" rows={d.sessionsByHours} metric="wsec" />
      <SessionList title="Sessions by tokens" rows={d.sessionsByTokens} metric="tokens" />
    </div>
  ),
};
