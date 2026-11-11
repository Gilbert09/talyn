import type { ReactNode } from 'react';
import { Clock, X } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { formatRunTime, wakeupTitle, wakeupWhen } from '../../lib/sessionBackground';
import { useNow } from '../../hooks/useSessionBackground';
import { useRunningJobs, useScheduledWakeupsForChat } from '../../stores/sessionBackground';
import { useWorkbenchStore } from '../../stores/workbenches';
import { toast } from '../../stores/toast';

const MAX_JOB_CHIPS = 3;

const CHIP = 'inline-flex max-w-full items-center gap-1.5 rounded-full border bg-muted/50 px-2 py-1 text-xs text-muted-foreground';
const OPENS = 'hover:bg-accent hover:text-foreground';

/**
 * Running background jobs of the session and scheduled wake-ups of this chat,
 * above the composer. When `canOpen`, a click opens the Background tab.
 */
export function BackgroundChips({ workbenchId, chatId, canOpen }: { workbenchId: string; chatId: string | null; canOpen: boolean }) {
  const jobs = useRunningJobs(workbenchId);
  const wakeups = useScheduledWakeupsForChat(workbenchId, chatId ?? '');
  const now = useNow(jobs.length ? 1000 : wakeups.length ? 15_000 : null);
  const setSideTab = useWorkbenchStore((s) => s.setSideTab);
  if (!jobs.length && !wakeups.length) return null;
  const open = canOpen ? () => setSideTab('background') : undefined;
  const hidden = jobs.length - MAX_JOB_CHIPS;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5" data-testid="background-chips">
      {jobs.slice(0, MAX_JOB_CHIPS).map((job) => (
        <OpenTarget key={job.id} open={open} testId="job-chip" label={`Background job ${job.name}: running for ${formatRunTime(job.startedAt, null, now)}`} title={job.command}>
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-500" aria-hidden />
          <span className="min-w-0 truncate text-foreground">{job.name}</span>
          <span className="shrink-0 tabular-nums">{formatRunTime(job.startedAt, null, now)}</span>
        </OpenTarget>
      ))}
      {hidden > 0 && (
        <OpenTarget open={open} testId="job-chip-more" label={`${hidden} more background ${hidden === 1 ? 'job' : 'jobs'}`}>
          +{hidden} more
        </OpenTarget>
      )}
      {wakeups.map((wakeup) => (
        <span key={wakeup.id} data-testid="wakeup-chip" className={cn(CHIP, 'gap-1 pr-1')} title={wakeupTitle(wakeup, now)}>
          {open ? (
            <button type="button" className="inline-flex min-w-0 items-center gap-1 hover:text-foreground" onClick={open}>
              <Clock className="h-3 w-3 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{wakeupWhen(wakeup, now)}: {wakeup.reason}</span>
            </button>
          ) : (
            <>
              <Clock className="h-3 w-3 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{wakeupWhen(wakeup, now)}: {wakeup.reason}</span>
            </>
          )}
          <button type="button" aria-label={`Cancel wake-up: ${wakeup.reason}`} className="rounded-full p-0.5 hover:bg-accent hover:text-foreground" onClick={() => {
            void api.workbenches.cancelWakeup(workbenchId, wakeup.id).catch((error: unknown) => toast.error('Could not cancel wake-up', error instanceof Error ? error.message : undefined));
          }}><X className="h-3 w-3" /></button>
        </span>
      ))}
    </div>
  );
}

function OpenTarget({ open, testId, label, title, children }: { open: (() => void) | undefined; testId: string; label: string; title?: string; children: ReactNode }) {
  if (!open) return <span data-testid={testId} className={CHIP} title={title ?? label}>{children}</span>;
  return (
    <button type="button" data-testid={testId} className={cn(CHIP, OPENS)} title={title ?? label} aria-label={`${label}. Open the Background tab`} onClick={open}>
      {children}
    </button>
  );
}
