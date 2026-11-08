import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { WorkbenchBackgroundJob, WorkbenchWakeup } from '@talyn/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { formatCountdown, formatRunTime, keepAwakeLabel } from '../../lib/sessionBackground';
import { useNow } from '../../hooks/useSessionBackground';
import { useJobLogs } from '../../hooks/useJobLogs';
import { useBackground } from '../../stores/sessionBackground';
import { toast } from '../../stores/toast';

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export function BackgroundTab({ workbenchId }: { workbenchId: string }) {
  const background = useBackground(workbenchId);
  const now = useNow(15_000);
  const wakeups = [...(background?.wakeups ?? [])].sort((a, b) => {
    if (a.status === 'scheduled' && b.status !== 'scheduled') return -1;
    if (b.status === 'scheduled' && a.status !== 'scheduled') return 1;
    return a.status === 'scheduled' ? a.wakeAt.localeCompare(b.wakeAt) : b.createdAt.localeCompare(a.createdAt);
  });
  return (
    <div className="h-full overflow-auto px-3 py-3 text-xs">
      <section aria-label="Jobs">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Jobs</h3>
        {background?.jobs.length ? background.jobs.map((job) => <JobRow key={job.id} workbenchId={workbenchId} job={job} />) : <p className="py-2 text-muted-foreground">No background jobs yet.</p>}
      </section>
      <section aria-label="Wake-ups" className="mt-5">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Wake-ups</h3>
        {wakeups.length ? wakeups.map((wakeup) => <WakeupRow key={wakeup.id} workbenchId={workbenchId} wakeup={wakeup} now={now} />) : <p className="py-2 text-muted-foreground">No wake-ups yet.</p>}
      </section>
    </div>
  );
}

function JobRow({ workbenchId, job }: { workbenchId: string; job: WorkbenchBackgroundJob }) {
  const [expanded, setExpanded] = useState(false);
  const running = job.status === 'running';
  const now = useNow(running ? 1000 : null);
  const awake = keepAwakeLabel(job.keepAwakeUntil, now);
  const { logs, error, loading, wakeAndLoad } = useJobLogs(workbenchId, job.id, expanded, running);
  const logRef = useRef<HTMLPreElement>(null);
  const nearBottom = useRef(true);
  useEffect(() => {
    const element = logRef.current;
    if (element && nearBottom.current) element.scrollTop = element.scrollHeight;
  }, [logs?.lines]);

  const action = async (label: string, call: () => Promise<unknown>) => {
    try { await call(); } catch (cause) { toast.error(`Could not ${label}`, errorMessage(cause)); }
  };
  const statusColor = running ? 'bg-emerald-500 animate-pulse' : job.status === 'exited' ? job.exitCode === 0 ? 'bg-muted-foreground/50' : 'bg-destructive' : job.status === 'lost' ? 'bg-amber-500' : 'bg-muted-foreground/50';
  return (
    <div className="border-b py-2 last:border-b-0">
      <button type="button" className="flex w-full items-start gap-2 text-left" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className={cn('mt-1 h-2 w-2 shrink-0 rounded-full', statusColor)} aria-label={job.status} />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-foreground">{job.name}</span>
          <span className="block truncate font-mono text-[11px] text-muted-foreground" title={job.command}>{job.command}</span>
        </span>
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
      </button>
      <div className="ml-4 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        <span>{formatRunTime(job.startedAt, job.endedAt, now)}</span>
        {job.status === 'exited' && <span>Exit code {job.exitCode ?? 'unknown'}</span>}
        {(job.status === 'stopped' || job.status === 'lost') && job.detail && <span>{job.detail}</span>}
      </div>
      {running && (
        <div className="ml-4 mt-1 flex flex-wrap items-center gap-2 text-muted-foreground">
          {awake && <span>{awake}</span>}
          {awake && <button type="button" className="text-foreground hover:underline" onClick={() => void action('let the box sleep', () => api.workbenches.keepBackgroundJobAwake(workbenchId, job.id, 0))}>Let it sleep</button>}
          <button type="button" className="text-foreground hover:underline" onClick={() => void action('extend awake time', () => api.workbenches.keepBackgroundJobAwake(workbenchId, job.id, 3600))}>Extend 1h</button>
          <button type="button" className="text-destructive hover:underline" onClick={() => void action('stop the job', () => api.workbenches.stopBackgroundJob(workbenchId, job.id))}>Stop</button>
        </div>
      )}
      {expanded && (
        <div className="ml-4 mt-2">
          {logs?.asleep ? <div className="rounded bg-muted p-2 text-muted-foreground">The box is asleep <button type="button" className="ml-2 text-foreground hover:underline" onClick={wakeAndLoad}>Wake and load logs</button></div> : (
            <pre ref={logRef} onScroll={(event) => { const element = event.currentTarget; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32; }} className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px] text-foreground">{logs?.lines.join('\n') ?? (loading ? 'Loading logs…' : '')}</pre>
          )}
          {error && <p role="alert" className="mt-1 text-destructive">{error}</p>}
        </div>
      )}
    </div>
  );
}

function WakeupRow({ workbenchId, wakeup, now }: { workbenchId: string; wakeup: WorkbenchWakeup; now: number }) {
  const scheduled = wakeup.status === 'scheduled';
  return (
    <div className="border-b py-2 last:border-b-0">
      <p className={cn('break-words font-medium', scheduled ? 'text-foreground' : 'text-muted-foreground')}>{wakeup.reason}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        <span>{scheduled ? formatCountdown(wakeup.wakeAt, now) : wakeup.status[0].toUpperCase() + wakeup.status.slice(1)}</span>
        <span>{wakeup.createdBy === 'user' ? 'Set by you' : 'Set by the agent'}</span>
        {scheduled && <button type="button" className="text-foreground hover:underline" onClick={() => void api.workbenches.cancelWakeup(workbenchId, wakeup.id).catch((cause: unknown) => toast.error('Could not cancel wake-up', errorMessage(cause)))}>Cancel</button>}
      </div>
      {wakeup.status === 'failed' && wakeup.failureDetail && <p className="mt-1 text-destructive">{wakeup.failureDetail}</p>}
    </div>
  );
}
