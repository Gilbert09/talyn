import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, BarChart3, Loader2, RotateCw } from 'lucide-react';
import {
  INSIGHTS_RANGE_LABELS,
  INSIGHTS_RANGE_PRESETS,
  type InsightsQuery,
  type InsightsResponseBySection,
  type InsightsSection,
} from '@talyn/shared';
import { insights } from '../lib/api';
import { trackEvent } from '../lib/analytics';
import {
  DEFAULT_INSIGHTS_RANGE,
  analyticsRange,
  customRangeError,
  rangeKey,
  rangeQuery,
  utcDateString,
  type InsightsRangeChoice,
} from '../lib/insights';
import { cn } from '../lib/utils';
import { useWorkspaceStore } from '../stores/workspace';
import { PageHeader } from '../components/ui/page-header';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import {
  ComputeFooter,
  agentsSection,
  computeSection,
  outputSection,
  speedSection,
  topSection,
  type SectionSpec,
} from '../components/insights/InsightsSections';

export function InsightsView() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.currentWorkspaceId)?.name);
  const [range, setRange] = useState<InsightsRangeChoice>(DEFAULT_INSIGHTS_RANGE);

  return (
    <div className="flex h-full min-h-0 flex-col" data-attr="insights-page">
      <PageHeader title="Insights" icon={<BarChart3 className="h-4 w-4" />} />
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {!workspaceId ? (
          <p className="p-6 text-sm text-muted-foreground">Pick a workspace to see its insights.</p>
        ) : (
          <div className="mx-auto w-full max-w-5xl space-y-4 p-3 sm:p-6">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">
                Usage for {workspaceName ? <span className="font-medium text-foreground">{workspaceName}</span> : 'this workspace'}.
                Days are in UTC.
              </p>
            </div>
            <RangePicker value={range} onChange={setRange} />
            <SectionCard section="compute" spec={computeSection} workspaceId={workspaceId} range={range} footer={(d) => <ComputeFooter data={d} />} />
            <SectionCard section="agents" spec={agentsSection} workspaceId={workspaceId} range={range} />
            <SectionCard section="output" spec={outputSection} workspaceId={workspaceId} range={range} />
            <SectionCard section="speed" spec={speedSection} workspaceId={workspaceId} range={range} />
            <SectionCard section="top" spec={topSection} workspaceId={workspaceId} range={range} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Range picker ----------

const DAY_MS = 86_400_000;

function defaultCustom(): { from: string; to: string } {
  const now = Date.now();
  return { from: utcDateString(now - 29 * DAY_MS), to: utcDateString(now) };
}

export function RangePicker({ value, onChange }: { value: InsightsRangeChoice; onChange: (next: InsightsRangeChoice) => void }) {
  const [customOpen, setCustomOpen] = useState(value.kind === 'custom');
  const [draft, setDraft] = useState(() => (value.kind === 'custom' ? { from: value.from, to: value.to } : defaultCustom()));
  const error = customOpen ? customRangeError(draft.from, draft.to) : null;
  const active = customOpen ? 'custom' : value.kind === 'preset' ? value.preset : 'custom';
  const applied = value.kind === 'custom' && value.from === draft.from && value.to === draft.to;

  const options = [...INSIGHTS_RANGE_PRESETS, 'custom' as const];

  return (
    <div className="space-y-2" data-attr="insights-range">
      <div role="radiogroup" aria-label="Date range" className="flex flex-wrap gap-1">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active === option}
            data-attr={`insights-range-${option}`}
            onClick={() => {
              if (option === 'custom') {
                setCustomOpen(true);
                return;
              }
              setCustomOpen(false);
              onChange({ kind: 'preset', preset: option });
            }}
            className={cn(
              'h-9 rounded-md border px-3 text-sm transition-colors',
              active === option ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-accent'
            )}
          >
            {INSIGHTS_RANGE_LABELS[option]}
          </button>
        ))}
      </div>
      {customOpen && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!error) onChange({ kind: 'custom', from: draft.from, to: draft.to });
          }}
        >
          <label className="flex min-w-[9rem] flex-1 flex-col gap-1 text-xs text-muted-foreground sm:flex-none">
            From
            <input
              type="date"
              value={draft.from}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            />
          </label>
          <label className="flex min-w-[9rem] flex-1 flex-col gap-1 text-xs text-muted-foreground sm:flex-none">
            To (included)
            <input
              type="date"
              value={draft.to}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            />
          </label>
          <Button type="submit" size="sm" disabled={Boolean(error) || applied}>
            {applied ? 'Applied' : 'Apply'}
          </Button>
          {error && (
            <p role="alert" className="w-full text-sm text-destructive" data-attr="insights-range-error">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

// ---------- Sections ----------

type SectionState<S extends InsightsSection> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: InsightsResponseBySection[S] };

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Could not load this section.';
}

/** One section's data. A response for an older query or workspace is dropped. */
function useInsightsSection<S extends InsightsSection>(section: S, query: InsightsQuery | null) {
  const [state, setState] = useState<SectionState<S>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);
  const key = query ? JSON.stringify(query) : null;

  useEffect(() => {
    if (!key) return;
    const id = ++latest.current;
    setState({ status: 'loading' });
    insights.get(section, JSON.parse(key) as InsightsQuery).then(
      (data) => {
        if (id === latest.current) setState({ status: 'ready', data });
      },
      (err: unknown) => {
        if (id === latest.current) setState({ status: 'error', message: errorText(err) });
      }
    );
  }, [section, key, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}

function SectionCard<S extends InsightsSection>({
  section,
  spec,
  workspaceId,
  range,
  footer,
}: {
  section: S;
  spec: SectionSpec<S>;
  workspaceId: string;
  range: InsightsRangeChoice;
  footer?: (data: InsightsResponseBySection[S]) => ReactNode;
}) {
  const fields = useMemo(() => rangeQuery(range), [range]);
  const query = useMemo<InsightsQuery | null>(() => (fields ? { workspaceId, ...fields } : null), [workspaceId, fields]);
  const { state, retry } = useInsightsSection(section, query);
  const currentRange = rangeKey(range);
  const tracked = useRef<string | null>(null);

  useEffect(() => {
    if (state.status !== 'ready' || tracked.current === currentRange) return;
    tracked.current = currentRange;
    trackEvent('insights_viewed', { section, range: analyticsRange(range) });
  }, [state.status, currentRange, section, range]);

  const headingId = `insights-${section}-title`;
  return (
    <Card className="min-w-0 overflow-hidden" aria-labelledby={headingId} role="region" data-attr={`insights-section-${section}`}>
      <div className="space-y-1 p-4 pb-3">
        <h2 id={headingId} className="text-base font-semibold">
          {spec.title}
        </h2>
        <p className="text-sm text-muted-foreground">{spec.description}</p>
      </div>
      <div className="min-w-0 p-4 pt-0">
        {state.status === 'loading' && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" aria-busy="true">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading
          </div>
        )}
        {state.status === 'error' && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3" role="alert">
            <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
            <p className="min-w-0 flex-1 text-sm">{state.message}</p>
            <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={retry}>
              <RotateCw className="h-3.5 w-3.5" />
              Retry
            </Button>
          </div>
        )}
        {state.status === 'ready' && (
          <div className="space-y-4">
            {spec.isEmpty(state.data) ? (
              <p className="py-4 text-sm text-muted-foreground" data-attr={`insights-${section}-empty`}>
                {spec.emptyText}
              </p>
            ) : (
              spec.render(state.data)
            )}
            {footer?.(state.data)}
          </div>
        )}
      </div>
    </Card>
  );
}
