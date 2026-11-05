import type { ReactNode } from 'react';
import {
  PLAN_TIER_LABELS,
  SANDBOX_SIZES,
  formatBoxHours,
  formatBoxHoursLabel,
  formatBoxHoursUsage,
  formatInsightsDuration,
  formatTokenCount,
  formatUsd,
  totalTokens,
  usagePercent,
  type InsightsAgentsResponse,
  type InsightsComputeResponse,
  type InsightsOutputResponse,
  type InsightsPercentiles,
  type InsightsSpeedResponse,
  type InsightsTopResponse,
  type InsightsTopSession,
} from '@talyn/shared';
import { cn } from '../../lib/utils';
import { formatShortDate } from '../../lib/usageBilling';
import {
  BOX_START_CAUSE_LABELS,
  FINDING_SEVERITIES,
  FINDING_SEVERITY_LABELS,
  INSIGHTS_KIND_LABELS,
  WAKE_SOURCE_LABELS,
  agentLabel,
  groupFixRuns,
  modelLabel,
} from '../../lib/insights';
import { BreakdownBars, DayBars, StatTile, SubTitle } from './InsightsCharts';

const count = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;
const costText = (micros: number | null) => (micros === null ? 'Not reported' : formatUsd(micros));

// ---------- Compute ----------

export function computeIsEmpty(data: InsightsComputeResponse): boolean {
  return data.totalWsec === 0 && data.boxes === 0;
}

export function ComputeSection({ data }: { data: InsightsComputeResponse }) {
  const empty = computeIsEmpty(data);
  return (
    <div className="space-y-4">
      {empty ? (
        <EmptyLine>No box time in this range.</EmptyLine>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <StatTile label="Box-hours" value={formatBoxHours(data.totalWsec)} detail="Weighted by box size" testId="compute-total" />
            <StatTile label="Box runs started" value={count(data.boxes)} />
          </div>
          <div>
            <SubTitle>Box-hours per day (UTC)</SubTitle>
            <DayBars
              label="Box-hours per day"
              testId="compute-days"
              formatValue={(hours) => `${hours.toFixed(1)} box-hours`}
              points={data.days.map((d) => ({ date: d.date, value: d.wsec / 3600, valueText: formatBoxHoursLabel(d.wsec) }))}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <SubTitle>By box size</SubTitle>
              <BreakdownBars
                label="Box-hours by box size"
                rows={data.bySize.map((r) => ({
                  key: r.size,
                  label: SANDBOX_SIZES[r.size]?.label ?? r.size,
                  value: r.wsec,
                  valueText: formatBoxHoursLabel(r.wsec),
                  detail: plural(r.boxes, 'run', 'runs'),
                }))}
              />
            </div>
            <div>
              <SubTitle>By kind of work</SubTitle>
              <BreakdownBars
                label="Box-hours by kind of work"
                rows={data.byKind.map((r) => ({
                  key: r.kind,
                  label: INSIGHTS_KIND_LABELS[r.kind] ?? r.kind,
                  value: r.wsec,
                  valueText: formatBoxHoursLabel(r.wsec),
                  detail: plural(r.boxes, 'run', 'runs'),
                }))}
              />
            </div>
          </div>
        </>
      )}
      {data.period && <PlanPeriodCard period={data.period} />}
    </div>
  );
}

function PlanPeriodCard({ period }: { period: NonNullable<InsightsComputeResponse['period']> }) {
  const percent = Math.min(100, usagePercent(period.usedWsec, period.includedWsec));
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3" data-testid="compute-period">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13px] font-medium">{PLAN_TIER_LABELS[period.tier]} plan, this billing period</p>
        <span className="text-[11px] text-muted-foreground">
          {formatShortDate(period.periodStart)} to {formatShortDate(period.periodEnd)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">Account-wide: counts box time in every workspace you own, not only this one.</p>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label="Included box-hours used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">{formatBoxHoursUsage(period.usedWsec, period.includedWsec)} used</p>
      {period.creditMicrosUsed > 0 && (
        <p className="text-xs text-muted-foreground">Credits spent this period: {formatUsd(period.creditMicrosUsed)}</p>
      )}
    </div>
  );
}

// ---------- Agents ----------

export function agentsIsEmpty(data: InsightsAgentsResponse): boolean {
  return data.totals.turns === 0 && totalTokens(data.totals) === 0;
}

export function AgentsSection({ data }: { data: InsightsAgentsResponse }) {
  if (agentsIsEmpty(data)) return <EmptyLine>No agent turns in this range.</EmptyLine>;
  const { totals } = data;
  const costDetail =
    totals.costMicros === null
      ? 'The agents reported no cost. Codex does not report one.'
      : totals.turnsWithCost < totals.turns
        ? `Cost estimate covers ${count(totals.turnsWithCost)} of ${count(totals.turns)} turns.`
        : 'The agent reports this estimate at API prices.';
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Your own Claude or Codex subscription pays for these tokens, not Talyn. Costs are estimates.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Tokens" value={formatTokenCount(totalTokens(totals))} testId="agents-tokens" />
        <StatTile
          label="Turns"
          value={count(totals.turns)}
          detail={totals.failedTurns > 0 ? `${count(totals.failedTurns)} failed` : 'None failed'}
        />
        <StatTile label="Agent steps" value={count(totals.agentSteps)} detail="Claude reports these" />
        <StatTile label="Estimated cost at API prices" value={costText(totals.costMicros)} detail={costDetail} testId="agents-cost" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <SubTitle>Tokens by kind</SubTitle>
          <BreakdownBars
            label="Tokens by kind"
            rows={[
              { key: 'input', label: 'Input (not from cache)', value: totals.inputTokens, valueText: formatTokenCount(totals.inputTokens), tooltipValueText: `${count(totals.inputTokens)} tokens` },
              { key: 'output', label: 'Output', value: totals.outputTokens, valueText: formatTokenCount(totals.outputTokens), tooltipValueText: `${count(totals.outputTokens)} tokens` },
              { key: 'cacheRead', label: 'Cache read', value: totals.cacheReadTokens, valueText: formatTokenCount(totals.cacheReadTokens), tooltipValueText: `${count(totals.cacheReadTokens)} tokens` },
              { key: 'cacheWrite', label: 'Cache write', value: totals.cacheWriteTokens, valueText: formatTokenCount(totals.cacheWriteTokens), tooltipValueText: `${count(totals.cacheWriteTokens)} tokens` },
            ]}
          />
        </div>
        <div>
          <SubTitle>By agent</SubTitle>
          <BreakdownBars
            label="Tokens by agent"
            rows={data.byAgent.map((a) => ({
              key: a.agent,
              label: agentLabel(a.agent),
              value: totalTokens(a),
              valueText: `${formatTokenCount(totalTokens(a))} tokens`,
              tooltipValueText: `${count(totalTokens(a))} tokens`,
              detail: `${plural(a.turns, 'turn', 'turns')}, est. ${costText(a.costMicros)}`,
            }))}
          />
        </div>
      </div>
      <div>
        <SubTitle>Tokens per day (UTC)</SubTitle>
        <DayBars
          label="Tokens per day"
          testId="agents-days"
          formatValue={(tokens) => `${formatTokenCount(tokens)} tokens`}
          points={data.days.map((d) => ({
            date: d.date,
            value: totalTokens(d),
            valueText: `${formatTokenCount(totalTokens(d))} tokens, ${plural(d.turns, 'turn', 'turns')}`,
          }))}
        />
      </div>
      {data.byModel.length > 0 && (
        <div>
          <SubTitle>By model</SubTitle>
          <table className="w-full text-xs" data-testid="agents-models">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Model</th>
                <th className="py-1 pr-2 font-medium">Agent</th>
                <th className="py-1 pr-2 text-right font-medium">Turns</th>
                <th className="py-1 pr-2 text-right font-medium">Tokens</th>
                <th className="py-1 text-right font-medium">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {data.byModel.map((m) => (
                <tr key={`${m.agent}:${m.model}`} className="border-b last:border-0">
                  <td className="py-1 pr-2 font-mono">{modelLabel(m.model)}</td>
                  <td className="py-1 pr-2">{agentLabel(m.agent)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{count(m.turns)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{formatTokenCount(totalTokens(m))}</td>
                  <td className="py-1 text-right tabular-nums">{costText(m.costMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.turnDuration.count > 0 && (
        <p className="text-xs text-muted-foreground">
          Turn length: median {formatInsightsDuration(data.turnDuration.p50Ms)}, p90{' '}
          {formatInsightsDuration(data.turnDuration.p90Ms)} ({plural(data.turnDuration.count, 'turn', 'turns')}).
        </p>
      )}
    </div>
  );
}

// ---------- Output ----------

export function outputIsEmpty(data: InsightsOutputResponse): boolean {
  const { sessions, tasks } = data;
  return (
    sessions.created + sessions.withPullRequest + sessions.pullRequestsMerged === 0 &&
    tasks.created + tasks.completed + tasks.failed + tasks.withPullRequest === 0 &&
    data.fixRuns.every((r) => r.count === 0) &&
    data.mergeQueue.landed === 0 &&
    data.codeReview.reviews === 0 &&
    data.codeReview.findings.every((f) => f.count === 0)
  );
}

export function OutputSection({ data }: { data: InsightsOutputResponse }) {
  if (outputIsEmpty(data)) return <EmptyLine>No sessions, tasks or reviews in this range.</EmptyLine>;
  const fixRuns = groupFixRuns(data.fixRuns);
  const findings = new Map(data.codeReview.findings.map((f) => [f.severity, f.count]));
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <CountList
        title="Sessions"
        rows={[
          ['Created', data.sessions.created],
          ['With a pull request', data.sessions.withPullRequest],
          ['Pull requests merged', data.sessions.pullRequestsMerged],
        ]}
      />
      <CountList
        title="Tasks"
        rows={[
          ['Created', data.tasks.created],
          ['Completed', data.tasks.completed],
          ['Failed', data.tasks.failed],
          ['With a pull request', data.tasks.withPullRequest],
        ]}
      />
      <div>
        <SubTitle>Fix runs</SubTitle>
        {fixRuns.length === 0 ? (
          <p className="text-xs text-muted-foreground">No fix runs.</p>
        ) : (
          <BreakdownBars
            label="Fix runs by source"
            rows={fixRuns.map((r) => ({ key: r.label, label: r.label, value: r.count, valueText: count(r.count) }))}
          />
        )}
      </div>
      <div className="space-y-4">
        <CountList title="Merge queue" rows={[['Pull requests landed', data.mergeQueue.landed]]} />
        <CountList
          title="Code review"
          rows={[
            ['Reviews run', data.codeReview.reviews],
            ...FINDING_SEVERITIES.map((s): [string, number] => [`${FINDING_SEVERITY_LABELS[s]} findings`, findings.get(s) ?? 0]),
          ]}
        />
      </div>
    </div>
  );
}

function CountList({ title, rows }: { title: string; rows: [string, number][] }) {
  return (
    <div>
      <SubTitle>{title}</SubTitle>
      <dl className="space-y-1 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="tabular-nums">{count(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------- Speed ----------

export function speedIsEmpty(data: InsightsSpeedResponse): boolean {
  return [data.boxStart, data.wake, data.firstReply, data.firstReplyNewSession, data.turnStart].every((p) => p.count === 0);
}

export function SpeedSection({ data }: { data: InsightsSpeedResponse }) {
  if (speedIsEmpty(data)) return <EmptyLine>No timings in this range.</EmptyLine>;
  return (
    <table className="w-full text-xs" data-testid="speed-table">
      <thead>
        <tr className="border-b text-left text-muted-foreground">
          <th className="py-1 pr-2 font-medium">Measure</th>
          <th className="py-1 pr-2 text-right font-medium">Median</th>
          <th className="py-1 pr-2 text-right font-medium">p90</th>
          <th className="py-1 text-right font-medium">Samples</th>
        </tr>
      </thead>
      <tbody>
        <SpeedRow label="Box start" hint="From the request to a box that has run its setup" p={data.boxStart} />
        {data.boxStart.byCause.map((c) => (
          <SpeedRow key={`cause-${c.cause}`} label={BOX_START_CAUSE_LABELS[c.cause] ?? c.cause} p={c} nested />
        ))}
        <SpeedRow label="Wake" hint="Resume of a sleeping box" p={data.wake} />
        {data.wake.bySource.map((s) => (
          <SpeedRow key={`wake-${s.source}`} label={WAKE_SOURCE_LABELS[s.source] ?? s.source} p={s} nested />
        ))}
        <SpeedRow label="First reply" hint="From a sent message to the agent's first reply" p={data.firstReply} />
        <SpeedRow
          label="First reply in a new session"
          hint="The first message of each session. Includes the box start."
          p={data.firstReplyNewSession}
        />
        <SpeedRow label="Turn start" hint="From the queued message to the agent start" p={data.turnStart} />
      </tbody>
    </table>
  );
}

function SpeedRow({ label, hint, p, nested }: { label: string; hint?: string; p: InsightsPercentiles; nested?: boolean }) {
  return (
    <tr className="border-b last:border-0">
      <td className={cn('py-1 pr-2', nested && 'pl-4 text-muted-foreground')} title={hint}>
        {label}
      </td>
      <td className="py-1 pr-2 text-right tabular-nums">{formatInsightsDuration(p.p50Ms)}</td>
      <td className="py-1 pr-2 text-right tabular-nums">{formatInsightsDuration(p.p90Ms)}</td>
      <td className="py-1 text-right tabular-nums text-muted-foreground">{count(p.count)}</td>
    </tr>
  );
}

// ---------- Top lists ----------

export function topIsEmpty(data: InsightsTopResponse): boolean {
  return (
    data.repositoriesByHours.length +
      data.repositoriesByTokens.length +
      data.sessionsByHours.length +
      data.sessionsByTokens.length ===
    0
  );
}

export function TopSection({ data, onOpenSession }: { data: InsightsTopResponse; onOpenSession?: (id: string) => void }) {
  if (topIsEmpty(data)) return <EmptyLine>Nothing to rank in this range.</EmptyLine>;
  const hours = (wsec: number) => formatBoxHoursLabel(wsec);
  const tokens = (n: number) => `${formatTokenCount(n)} tokens`;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TopList title="Repositories by box-hours">
        <BreakdownBars
          label="Repositories by box-hours"
          rows={data.repositoriesByHours.map((r) => ({ key: r.repository, label: <span className="font-mono">{r.repository}</span>, labelText: r.repository, value: r.wsec, valueText: hours(r.wsec) }))}
        />
      </TopList>
      <TopList title="Repositories by tokens">
        <BreakdownBars
          label="Repositories by tokens"
          rows={data.repositoriesByTokens.map((r) => ({ key: r.repository, label: <span className="font-mono">{r.repository}</span>, labelText: r.repository, value: r.tokens, valueText: tokens(r.tokens), tooltipValueText: `${count(r.tokens)} tokens` }))}
        />
      </TopList>
      <TopList title="Sessions by box-hours">
        <BreakdownBars
          label="Sessions by box-hours"
          rows={data.sessionsByHours.map((s) => ({ key: s.workbenchId, label: <SessionLabel session={s} onOpen={onOpenSession} />, labelText: s.title ?? 'Deleted session', value: s.wsec, valueText: hours(s.wsec) }))}
        />
      </TopList>
      <TopList title="Sessions by tokens">
        <BreakdownBars
          label="Sessions by tokens"
          rows={data.sessionsByTokens.map((s) => ({ key: s.workbenchId, label: <SessionLabel session={s} onOpen={onOpenSession} />, labelText: s.title ?? 'Deleted session', value: s.tokens, valueText: tokens(s.tokens), tooltipValueText: `${count(s.tokens)} tokens` }))}
        />
      </TopList>
    </div>
  );
}

function TopList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <SubTitle>{title}</SubTitle>
      {children}
    </div>
  );
}

function SessionLabel({ session, onOpen }: { session: InsightsTopSession; onOpen?: (id: string) => void }) {
  const name = session.title ?? 'Deleted session';
  const canOpen = Boolean(onOpen) && session.title !== null && !session.archived;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {canOpen ? (
        <button
          type="button"
          className="min-w-0 truncate text-left hover:underline"
          onClick={() => onOpen?.(session.workbenchId)}
          data-attr="insights-open-session"
        >
          {name}
        </button>
      ) : (
        <span className={cn('min-w-0 truncate', session.title === null && 'italic text-muted-foreground')}>{name}</span>
      )}
      {session.archived && (
        <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">Archived</span>
      )}
      {session.repository && (
        <span className="hidden shrink-0 truncate font-mono text-[11px] text-muted-foreground sm:inline">{session.repository}</span>
      )}
    </span>
  );
}

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="py-4 text-center text-xs text-muted-foreground">{children}</p>;
}
