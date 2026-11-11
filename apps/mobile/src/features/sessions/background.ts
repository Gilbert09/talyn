import type { WorkbenchBackground, WorkbenchBackgroundJob, WorkbenchWakeup } from '@talyn/shared';

import type { Tone } from '../../components/UI';

const at = (value: string | number) => typeof value === 'number' ? value : new Date(value).getTime();

/** "42s", "3m 05s", "2h 10m". Ports web `formatRunTime`. */
export function formatRunTime(startedAt: string, endedAt: string | null, now: number): string {
  const seconds = Math.max(0, Math.floor((at(endedAt ?? now) - at(startedAt)) / 1000));
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** "Keeps the box awake until 14:30", or null when the box may sleep. Ports web `keepAwakeLabel`. */
export function keepAwakeLabel(until: string | null, now: number): string | null {
  if (!until || at(until) <= now) return null;
  const date = new Date(until);
  return `Keeps the box awake until ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** "Wakes in 5 min". Ports web `formatCountdown`. */
export function formatCountdown(wakeAt: string, now: number): string {
  const remaining = at(wakeAt) - now;
  if (remaining < 60_000) return 'Wakes in less than a minute';
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `Wakes in ${minutes} min`;
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    return `Wakes in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  }
  const days = Math.ceil(minutes / 1440);
  return `Wakes in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** The status word and colour of a job, like web's status dot. */
/** When a scheduled wake-up fires. A CI wake-up fires when CI finishes, and its time is the latest. */
export function wakeupWhen(wakeup: Pick<WorkbenchWakeup, 'wakeAt' | 'ci'>, now: number): string[] {
  if (!wakeup.ci) return [formatCountdown(wakeup.wakeAt, now)];
  return [`Waits for CI on ${wakeup.ci.headSha.slice(0, 7)}`, `${formatCountdown(wakeup.wakeAt, now)} at the latest`];
}

export function jobStatus(job: Pick<WorkbenchBackgroundJob, 'status' | 'exitCode'>): { label: string; tone: Tone } {
  switch (job.status) {
    case 'running': return { label: 'Running', tone: 'success' };
    case 'exited': return job.exitCode === 0 ? { label: 'Exited', tone: 'muted' } : { label: `Failed (exit ${job.exitCode ?? 'unknown'})`, tone: 'destructive' };
    case 'lost': return { label: 'Lost', tone: 'warning' };
    default: return { label: 'Stopped', tone: 'muted' };
  }
}

export function runningJobs(background: WorkbenchBackground | null | undefined): number {
  return background?.jobs.filter((job) => job.status === 'running').length ?? 0;
}

/** Scheduled wake-ups first, soonest first; then the rest, newest first. Mirrors web `BackgroundTab`. */
export function sortWakeups(wakeups: readonly WorkbenchWakeup[]): WorkbenchWakeup[] {
  return [...wakeups].sort((a, b) => {
    if (a.status === 'scheduled' && b.status !== 'scheduled') return -1;
    if (b.status === 'scheduled' && a.status !== 'scheduled') return 1;
    return a.status === 'scheduled' ? a.wakeAt.localeCompare(b.wakeAt) : b.createdAt.localeCompare(a.createdAt);
  });
}
