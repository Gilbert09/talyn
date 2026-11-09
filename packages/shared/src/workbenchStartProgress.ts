/**
 * How far a session box's start has got: which step runs now, how long this
 * repository usually takes for that step, and, while git reports it, the real
 * percentage of the clone or fetch. The backend writes it on `Workbench`; the
 * front ends draw the bar from it with {@link startProgressFraction}.
 */

export type WorkbenchStartStep = 'sandbox' | 'code' | 'setup';

export interface WorkbenchStartProgress {
  step: WorkbenchStartStep;
  /** 0-based. */
  stepIndex: number;
  stepCount: number;
  stepStartedAt: string;
  /** This repository's median time for the step. Null: not enough history. */
  expectedMs: number | null;
  /** 0-100, git's own progress through the `code` step. Null: git has not said. */
  percent: number | null;
  /** What git is doing, e.g. "Receiving objects". */
  detail: string | null;
}

export const WORKBENCH_START_STEP_LABELS: Record<WorkbenchStartStep, string> = {
  sandbox: 'Starting the sandbox',
  code: 'Getting the code',
  setup: 'Running the setup script',
};

/** The estimate never claims more of a step than this before the step ends. */
export const START_ESTIMATE_CAP = 0.95;

/** Chosen so the estimate reaches 0.8 of the step at the median time. */
const ESTIMATE_RATE = Math.log(5);

/**
 * How far through its current step the start is, 0..1. Real git progress
 * wins; otherwise an estimate from the elapsed time and the median, which
 * slows as it nears the cap so a slow start never shows as done. Null: no
 * basis for a number, so the bar is indeterminate.
 */
export function startStepFraction(progress: WorkbenchStartProgress, nowMs: number): number | null {
  if (progress.percent !== null && Number.isFinite(progress.percent)) {
    return Math.max(0, Math.min(1, progress.percent / 100));
  }
  if (!progress.expectedMs || progress.expectedMs <= 0) return null;
  const started = Date.parse(progress.stepStartedAt);
  if (!Number.isFinite(started)) return null;
  const elapsed = Math.max(0, nowMs - started);
  return Math.min(START_ESTIMATE_CAP, 1 - Math.exp((-ESTIMATE_RATE * elapsed) / progress.expectedMs));
}

/** The whole start, 0..1, or null when the current step has no basis for a number. */
export function startProgressFraction(progress: WorkbenchStartProgress, nowMs: number): number | null {
  const step = startStepFraction(progress, nowMs);
  if (step === null || progress.stepCount <= 0) return null;
  const index = Math.max(0, Math.min(progress.stepIndex, progress.stepCount - 1));
  return (index + step) / progress.stepCount;
}
