import type { WorkbenchBackground, WorkbenchWakeup } from '@talyn/shared';

function time(value: string | Date | number): number {
  return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(value).getTime();
}

export function formatRunTime(startedAt: string, endedAt: string | null, now: Date | number): string {
  const seconds = Math.max(0, Math.floor((time(endedAt ?? now) - time(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function formatCountdown(wakeAt: string, now: Date | number): string {
  const remaining = time(wakeAt) - time(now);
  if (remaining < 60_000) return 'Wakes in less than a minute';
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `Wakes in ${minutes} min`;
  if (minutes < 120) return `Wakes in 1 h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    return `Wakes in ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  }
  const days = Math.ceil(minutes / 1440);
  return `Wakes in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** When a scheduled wake-up fires, in words. A CI wake-up fires when CI finishes. */
export function wakeupWhen(wakeup: Pick<WorkbenchWakeup, 'wakeAt' | 'ci'>, now: Date | number): string {
  if (!wakeup.ci) return formatCountdown(wakeup.wakeAt, now);
  return `Waits for CI on ${wakeup.ci.headSha.slice(0, 7)}`;
}

/** The tooltip of a scheduled wake-up: a CI wake-up also says its latest time. */
export function wakeupTitle(wakeup: Pick<WorkbenchWakeup, 'wakeAt' | 'ci' | 'reason'>, now: Date | number): string {
  if (!wakeup.ci) return `${formatCountdown(wakeup.wakeAt, now)}: ${wakeup.reason}`;
  return `${wakeupWhen(wakeup, now)}. ${formatCountdown(wakeup.wakeAt, now)} at the latest: ${wakeup.reason}`;
}

export function wakeLaterPresets(now: Date): { id: string; label: string; delaySeconds: number }[] {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return [
    { id: '10m', label: '10 min', delaySeconds: 600 },
    { id: '30m', label: '30 min', delaySeconds: 1800 },
    { id: '1h', label: '1 h', delaySeconds: 3600 },
    { id: '3h', label: '3 h', delaySeconds: 10800 },
    { id: 'tomorrow', label: 'Tomorrow 09:00', delaySeconds: Math.ceil((tomorrow.getTime() - now.getTime()) / 1000) },
  ];
}

export function keepAwakeLabel(until: string | null, now: Date | number = Date.now()): string | null {
  if (!until || time(until) <= time(now)) return null;
  const date = new Date(until);
  return `Keeps the box awake until ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function isActiveBackground(bg: WorkbenchBackground | null | undefined): boolean {
  return Boolean(bg?.jobs.some((job) => job.status === 'running') || bg?.wakeups.some((wakeup) => wakeup.status === 'scheduled'));
}
