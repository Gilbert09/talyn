import { useEffect, useState } from 'react';
import { ChevronDown, ExternalLink, Repeat, Workflow } from 'lucide-react';
import { sessionAutomation, type SessionOrigin, type WorkbenchSource } from '@talyn/shared';
import { api } from '../../lib/api';
import { automationsShown, openAutomation } from '../../lib/automationFocus';
import { openExternal } from '../../lib/openExternal';
import { fullTimeLabel, relativeTimeLabel } from '../../lib/relativeTime';
import { useWorkspaceStore } from '../../stores/workspace';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

type OriginState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; origin: SessionOrigin | null };

const TRIGGER_WORDS: Record<NonNullable<SessionOrigin['trigger']>, string> = {
  event: 'Fired',
  manual: 'Run by hand',
  schedule: 'Scheduled run',
};

/**
 * Header chip for a session an automation started. A click shows what started
 * the session (the rule, the event and its subject) and a link to the automation.
 */
export function AutomationChip({
  workbenchId,
  source,
}: {
  workbenchId: string;
  source: WorkbenchSource | null | undefined;
}) {
  const features = useWorkspaceStore((s) => s.features);
  const automation = sessionAutomation(source);
  const [open, setOpen] = useState(false);
  // The answer, keyed by session. A run never changes, so one load per session is enough.
  const [loaded, setLoaded] = useState<{ id: string; state: OriginState } | null>(null);
  const state: OriginState = loaded?.id === workbenchId ? loaded.state : { status: 'loading' };
  const settled = state.status === 'ready';

  useEffect(() => {
    if (!open || settled) return;
    let disposed = false;
    setLoaded({ id: workbenchId, state: { status: 'loading' } });
    api.workbenches
      .origin(workbenchId)
      .then((origin) => {
        if (!disposed) setLoaded({ id: workbenchId, state: { status: 'ready', origin } });
      })
      .catch(() => {
        if (!disposed) setLoaded({ id: workbenchId, state: { status: 'error' } });
      });
    return () => {
      disposed = true;
    };
  }, [open, settled, workbenchId]);

  if (!automation || !automationsShown(features, automation.kind)) return null;
  const Icon = automation.type === 'loop' ? Repeat : Workflow;
  const origin = state.status === 'ready' ? state.origin : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-attr="session-automation-chip"
          title={`Started by a ${automation.label} automation. Show details`}
          aria-label={`Show the ${automation.label} automation that started this session`}
          className="app-region-no-drag inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Icon className="h-3 w-3 shrink-0" />
          <span className="truncate">{automation.label}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-2 p-3 text-xs" data-testid="automation-origin">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Icon className="h-3 w-3 shrink-0" />
          Started by a {automation.label} automation
        </div>
        {state.status === 'loading' && <div className="text-muted-foreground">Loading…</div>}
        {state.status === 'error' && <div className="text-muted-foreground">Could not load the details.</div>}
        {state.status === 'ready' && origin && <OriginDetails origin={origin} />}
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            openAutomation({ type: automation.type, id: automation.id, kind: automation.kind });
          }}
          data-attr="session-open-automation"
          aria-label={`Open the ${automation.label} automation that started this session`}
          className="inline-flex w-full items-center justify-center gap-1 rounded border border-border px-2 py-1 text-xs font-medium hover:bg-accent"
        >
          Open automation
        </button>
      </PopoverContent>
    </Popover>
  );
}

function OriginDetails({ origin }: { origin: SessionOrigin }) {
  const when = origin.startedAt;
  const how = origin.trigger
    ? origin.trigger === 'manual' && origin.triggeredBy
      ? `Run by ${origin.triggeredBy}`
      : TRIGGER_WORDS[origin.trigger]
    : null;
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <div className="text-sm font-medium text-foreground" data-testid="automation-origin-name">
          {origin.automationName ?? 'Deleted automation'}
        </div>
        {(origin.event || how || when) && (
          <div className="text-muted-foreground">
            {[origin.event, how].filter(Boolean).join(' · ')}
            {when && (
              <>
                {origin.event || how ? ' · ' : ''}
                <time dateTime={when} title={fullTimeLabel(when)}>
                  {relativeTimeLabel(when)}
                </time>
              </>
            )}
          </div>
        )}
      </div>
      {origin.subject &&
        (origin.subject.url ? (
          <button
            type="button"
            onClick={() => void openExternal(origin.subject!.url!)}
            data-attr="session-origin-subject"
            title={origin.subject.url}
            className="flex w-full items-start gap-1 text-left font-medium text-foreground hover:underline"
          >
            <span className="line-clamp-2 min-w-0 flex-1">{origin.subject.label}</span>
            <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 opacity-60" aria-hidden />
          </button>
        ) : (
          <div className="line-clamp-2 font-medium text-foreground">{origin.subject.label}</div>
        ))}
      {origin.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {origin.facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className="min-w-0 truncate text-foreground" title={fact.value}>
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {origin.excerpt && (
        <blockquote className="line-clamp-4 border-l-2 border-border pl-2 text-muted-foreground">
          {origin.excerpt}
        </blockquote>
      )}
    </div>
  );
}
