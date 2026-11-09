import type { WorkbenchStartProgress, WorkbenchStartStep } from '@talyn/shared';

/**
 * A sandbox start's progress. The step is stored on the row
 * (`workbenches.start_progress`): it changes a few times per start. Git's
 * percentage changes many times a second, so it stays here, in the process
 * that runs the clone, and is merged into the public row by
 * {@link publicStartProgress}. Another instance's broadcast carries no
 * percentage; the front ends never move a bar backwards, so that is harmless.
 */

export type StoredStartProgress = Omit<WorkbenchStartProgress, 'percent' | 'detail'>;

export const START_STEPS: readonly WorkbenchStartStep[] = ['sandbox', 'code', 'setup'];

/** A session's steps. A thread has only the box: it clones nothing and runs no setup. */
export function startStep(
  step: WorkbenchStartStep,
  opts: { thread: boolean; expectedMs: number | null; now?: Date },
): StoredStartProgress {
  return {
    step,
    stepIndex: opts.thread ? 0 : START_STEPS.indexOf(step),
    stepCount: opts.thread ? 1 : START_STEPS.length,
    stepStartedAt: (opts.now ?? new Date()).toISOString(),
    expectedMs: opts.expectedMs !== null && Number.isFinite(opts.expectedMs) && opts.expectedMs > 0 ? Math.round(opts.expectedMs) : null,
  };
}

interface LiveGitProgress {
  stepStartedAt: string;
  percent: number;
  detail: string | null;
}

const live = new Map<string, LiveGitProgress>();

/** Git's latest progress for the step that started at `stepStartedAt`. */
export function setLiveGitProgress(workbenchId: string, stepStartedAt: string, percent: number, detail: string | null): void {
  live.set(workbenchId, { stepStartedAt, percent, detail });
}

export function clearLiveStartProgress(workbenchId: string): void {
  live.delete(workbenchId);
}

function isStored(value: unknown): value is StoredStartProgress {
  const v = value as Partial<StoredStartProgress> | null;
  return !!v && typeof v === 'object' && START_STEPS.includes(v.step as WorkbenchStartStep)
    && typeof v.stepIndex === 'number' && typeof v.stepCount === 'number' && typeof v.stepStartedAt === 'string';
}

/**
 * The public progress of a row. Only a row still provisioning has one: a
 * value left by an older start or another path is never shown. The live git
 * percentage is merged only while it belongs to the stored step.
 */
export function publicStartProgress(row: { id: string; status: string; startProgress?: unknown }): WorkbenchStartProgress | null {
  if (row.status !== 'provisioning' || !isStored(row.startProgress)) return null;
  const stored = row.startProgress;
  const git = live.get(row.id);
  const current = git && git.stepStartedAt === stored.stepStartedAt ? git : null;
  return {
    step: stored.step,
    stepIndex: stored.stepIndex,
    stepCount: stored.stepCount,
    stepStartedAt: stored.stepStartedAt,
    expectedMs: typeof stored.expectedMs === 'number' ? stored.expectedMs : null,
    percent: current ? current.percent : null,
    detail: current ? current.detail : null,
  };
}

/**
 * Emits git progress at most once per `intervalMs`, and only when the whole
 * percentage changed. The last value always goes out, after the interval, so
 * 100% is not lost to the throttle. `stop` cancels a pending emit.
 */
export function createProgressThrottle(emit: () => Promise<void>, intervalMs = 1_000) {
  let lastEmitAt = -Infinity;
  let emitted: number | null = null;
  let pending: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const fire = () => {
    timer = null;
    if (stopped || pending === null || pending === emitted) return;
    emitted = pending;
    lastEmitAt = Date.now();
    void emit().catch((err) => console.warn('[workbench] emitting the start progress failed:', err));
  };

  return {
    note(percent: number): void {
      if (stopped) return;
      pending = Math.floor(percent);
      if (pending === emitted || timer) return;
      const wait = lastEmitAt + intervalMs - Date.now();
      if (wait <= 0) fire();
      else timer = setTimeout(fire, wait);
    },
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
