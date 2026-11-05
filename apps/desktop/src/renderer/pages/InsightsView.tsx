import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, BarChart3, Loader2, RotateCcw } from 'lucide-react';
import {
  INSIGHTS_RANGE_LABELS,
  INSIGHTS_RANGE_PRESETS,
  workbenchesOffered,
  type InsightsRangePreset,
  type InsightsResponseBySection,
  type InsightsSection,
} from '@talyn/shared';
import { insights } from '../lib/api';
import { trackEvent } from '../lib/analytics';
import {
  DEFAULT_INSIGHTS_RANGE,
  insightsRangeKey,
  insightsRangeQuery,
  utcDateString,
  validateCustomRange,
  type InsightsRangeChoice,
} from '../lib/insights';
import { useWorkspaceStore } from '../stores/workspace';
import { useNavigationStore } from '../stores/navigation';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { PageHeader } from '../components/ui/page-header';
import { Select } from '../components/ui/select';
import {
  AgentsSection,
  ComputeSection,
  OutputSection,
  SpeedSection,
  TopSection,
} from '../components/insights/InsightsSections';

type SectionState<S extends InsightsSection> =
  | { status: 'loading'; key: string }
  | { status: 'error'; key: string; message: string }
  | { status: 'ready'; key: string; data: InsightsResponseBySection[S] };

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Could not load this section.';
}

/**
 * One section's fetch. A response is kept with the workspace and range it
 * answered, so a slow answer for an old range is never drawn as the new one.
 * `insights_viewed` fires once per section, range and workspace, when its
 * data first draws.
 */
function useInsightsSection<S extends InsightsSection>(
  section: S,
  workspaceId: string | null,
  range: InsightsRangeChoice,
  tracked: Set<string>
) {
  const key = `${workspaceId ?? ''}|${insightsRangeKey(range)}`;
  const [state, setState] = useState<SectionState<S>>({ status: 'loading', key });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!workspaceId) return undefined;
    let active = true;
    const requestKey = `${workspaceId}|${insightsRangeKey(range)}`;
    setState({ status: 'loading', key: requestKey });
    insights.get(section, { workspaceId, ...insightsRangeQuery(range) }).then(
      (data) => {
        if (active) setState({ status: 'ready', key: requestKey, data: data as InsightsResponseBySection[S] });
      },
      (err: unknown) => {
        if (active) setState({ status: 'error', key: requestKey, message: errorMessage(err) });
      }
    );
    return () => {
      active = false;
    };
  }, [section, workspaceId, range, attempt]);

  const current: SectionState<S> = state.key === key ? state : { status: 'loading', key };

  useEffect(() => {
    if (current.status !== 'ready') return;
    const trackKey = `${section}|${current.key}`;
    if (tracked.has(trackKey)) return;
    tracked.add(trackKey);
    trackEvent('insights_viewed', { section, range: range.preset });
  }, [current.status, current.key, section, range.preset, tracked]);

  return { state: current, retry: () => setAttempt((n) => n + 1) };
}

/** Usage analytics for the active workspace: compute, agent tokens, output, speed and top lists. */
export function InsightsView() {
  const features = useWorkspaceStore((s) => s.features);
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.currentWorkspaceId)?.name);
  const navigate = useNavigationStore((s) => s.navigate);
  const [range, setRange] = useState<InsightsRangeChoice>(DEFAULT_INSIGHTS_RANGE);
  const tracked = useRef(new Set<string>()).current;

  const openSession = workbenchesOffered(features) ? (id: string) => navigate({ view: 'workbench', id }) : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="insights-view">
      <PageHeader title="Insights" icon={<BarChart3 className="h-4 w-4 text-muted-foreground" />} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-4 p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Usage in {workspaceName ? <span className="font-medium text-foreground">{workspaceName}</span> : 'this workspace'}.
              Days are in UTC.
            </p>
            <RangePicker range={range} onChange={setRange} />
          </div>
          <SectionShell title="Compute" section="compute" workspaceId={workspaceId} range={range} tracked={tracked}>
            {(data) => <ComputeSection data={data} />}
          </SectionShell>
          <SectionShell title="Agent usage" section="agents" workspaceId={workspaceId} range={range} tracked={tracked}>
            {(data) => <AgentsSection data={data} />}
          </SectionShell>
          <SectionShell title="Output" section="output" workspaceId={workspaceId} range={range} tracked={tracked}>
            {(data) => <OutputSection data={data} />}
          </SectionShell>
          <SectionShell title="Speed" section="speed" workspaceId={workspaceId} range={range} tracked={tracked}>
            {(data) => <SpeedSection data={data} />}
          </SectionShell>
          <SectionShell title="Top lists" section="top" workspaceId={workspaceId} range={range} tracked={tracked}>
            {(data) => <TopSection data={data} onOpenSession={openSession} />}
          </SectionShell>
        </div>
      </div>
    </div>
  );
}

function SectionShell<S extends InsightsSection>({
  title,
  section,
  workspaceId,
  range,
  tracked,
  children,
}: {
  title: string;
  section: S;
  workspaceId: string | null;
  range: InsightsRangeChoice;
  tracked: Set<string>;
  children: (data: InsightsResponseBySection[S]) => ReactNode;
}) {
  const { state, retry } = useInsightsSection(section, workspaceId, range, tracked);
  return (
    <section aria-labelledby={`insights-${section}-title`} data-testid={`insights-${section}`}>
      <h2 id={`insights-${section}-title`} className="mb-2 text-[13px] font-semibold">
        {title}
      </h2>
      <Card className="p-3">
        {state.status === 'loading' && (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground" role="status">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading {title.toLowerCase()}…
          </div>
        )}
        {state.status === 'error' && (
          <div className="flex flex-wrap items-center gap-2 py-2 text-xs text-destructive" role="alert">
            <AlertCircle className="h-3.5 w-3.5" />
            <span>{state.message}</span>
            <Button size="sm" variant="outline" className="ml-auto h-7" onClick={retry} data-attr={`insights-retry-${section}`}>
              <RotateCcw className="h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        )}
        {state.status === 'ready' && children(state.data)}
      </Card>
    </section>
  );
}

function RangePicker({ range, onChange }: { range: InsightsRangeChoice; onChange: (next: InsightsRangeChoice) => void }) {
  const [mode, setMode] = useState<InsightsRangePreset | 'custom'>(range.preset);
  const [from, setFrom] = useState(() => (range.preset === 'custom' ? range.from : utcDateString(new Date(), -30)));
  const [to, setTo] = useState(() => (range.preset === 'custom' ? range.to : utcDateString(new Date(), 1)));
  const error = mode === 'custom' ? validateCustomRange(from, to) : null;
  const applied = range.preset === 'custom' && range.from === from && range.to === to;

  const pick = (value: string) => {
    const next = value as InsightsRangePreset | 'custom';
    setMode(next);
    if (next !== 'custom') onChange({ preset: next });
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Range
        <Select value={mode} onChange={(e) => pick(e.target.value)} className="w-48" data-attr="insights-range">
          {[...INSIGHTS_RANGE_PRESETS, 'custom' as const].map((p) => (
            <option key={p} value={p}>
              {INSIGHTS_RANGE_LABELS[p]}
            </option>
          ))}
        </Select>
      </label>
      {mode === 'custom' && (
        <>
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-[13px] text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            To
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-8 rounded-md border border-input bg-background px-2 text-[13px] text-foreground"
            />
          </label>
          <Button
            size="sm"
            className="h-8"
            disabled={error !== null || applied}
            onClick={() => onChange({ preset: 'custom', from, to })}
            data-attr="insights-range-apply"
          >
            Apply
          </Button>
          {error && (
            <p className="w-full text-xs text-destructive" role="alert" data-testid="insights-range-error">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
