import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  startProgressFraction,
  WORKBENCH_START_STEP_LABELS,
  type Workbench,
  type WorkbenchStartProgress,
} from '@talyn/shared';
import { Progress } from '../ui/progress';

/** Still being set up, and not failed. An error wins, as in the banner. */
export function isStarting(workbench: Workbench): boolean {
  if (workbench.status === 'error' || workbench.sandboxState === 'error') return false;
  return (
    workbench.status === 'provisioning' || workbench.sandboxState === 'creating' || workbench.sandboxState === 'lost'
  );
}

/** How often the estimate moves while git says nothing. */
export const START_PROGRESS_TICK_MS = 400;

/**
 * The bar's fill, 0..1, or null for an indeterminate bar. It never moves
 * backwards within a step: a broadcast from another server carries no git
 * percentage, and the estimate must not undo what git already said.
 */
export function useStartFraction(progress: WorkbenchStartProgress | null | undefined): number | null {
  const [, setTick] = useState(0);
  const held = useRef<{ key: string; value: number } | null>(null);
  // Only the estimate moves with the clock; git's percentage arrives with the row.
  const estimating = !!progress && progress.percent === null && !!progress.expectedMs;
  useEffect(() => {
    if (!estimating) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), START_PROGRESS_TICK_MS);
    return () => clearInterval(timer);
  }, [estimating]);
  if (!progress) return null;
  const key = `${progress.step}:${progress.stepStartedAt}`;
  const prior = held.current?.key === key ? held.current.value : null;
  const computed = startProgressFraction(progress, Date.now());
  if (computed === null) return prior;
  const value = prior === null ? computed : Math.max(prior, computed);
  held.current = { key, value };
  return value;
}

function StartBar({ progress }: { progress: WorkbenchStartProgress }) {
  const fraction = useStartFraction(progress);
  const name = WORKBENCH_START_STEP_LABELS[progress.step];
  const step = progress.stepCount > 1 ? `Step ${progress.stepIndex + 1} of ${progress.stepCount} · ${name}` : name;
  const git = progress.percent !== null ? `${progress.detail ?? 'Getting the code'} · ${Math.round(progress.percent)}%` : null;
  return (
    <div className="mb-1 flex w-56 max-w-full flex-col items-center gap-1.5" data-attr="workbench-start-progress">
      <Progress value={fraction} label={git ? `${step}. ${git}` : step} className="w-full" />
      <p className="text-[12px] font-medium text-foreground">{step}</p>
      {git && <p className="tabular-nums">{git}</p>}
    </div>
  );
}

/**
 * The empty chat while the session starts: what it is doing now, and what
 * happens to a message written meanwhile. "Send a message to start" was wrong
 * here, because a message sent now waits in the queue.
 */
export function StartingHint({ workbench, queued }: { workbench: Workbench; queued: number }) {
  const ready = 'the sandbox is ready';
  const progress = workbench.startProgress ?? null;
  return (
    <div className="flex max-w-sm flex-col items-center gap-1.5" data-attr="workbench-starting">
      {!progress && <Loader2 className="mb-1 h-4 w-4 animate-spin" />}
      <p className="text-[13px] font-medium text-foreground">
        {workbench.sandboxState === 'lost' ? 'Starting a new sandbox' : 'Starting the sandbox'}
      </p>
      {progress && <StartBar progress={progress} />}
      {workbench.statusMessage && <p>{workbench.statusMessage}</p>}
      <p>
        {queued === 0
          ? `You can write your first message now. It is sent when ${ready}.`
          : queued === 1
            ? `Your message is queued. It is sent when ${ready}.`
            : `${queued} messages are queued. They are sent in order when ${ready}.`}
      </p>
    </div>
  );
}
