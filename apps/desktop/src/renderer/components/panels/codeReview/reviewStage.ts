import {
  CODE_REVIEW_PHASE_AT_REST,
  type CodeReviewPhase,
  type TaskStatus,
} from '@talyn/shared';

/**
 * Where one review row stands, as ONE answer with one colour.
 *
 * The row used to say this in grey text, so a list of twenty reviews read as
 * twenty identical cards — you had to read each one to find the ones that
 * wanted you. Most-final first: a merged pull request is merged whatever its
 * findings say, and an agent at work matters more than the findings it is
 * about to change.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */
export type ReviewStage =
  | 'merged'
  | 'closed'
  | 'reviewing'
  | 'fixing'
  | 'failed'
  | 'stopped'
  | 'needs_fixes'
  | 'ready';

export type ReviewStageTone = 'purple' | 'grey' | 'blue' | 'indigo' | 'red' | 'amber' | 'green';

export interface ReviewStageView {
  stage: ReviewStage;
  label: string;
  tone: ReviewStageTone;
}

export function reviewStage(input: {
  prState: 'open' | 'closed' | 'merged';
  phase: CodeReviewPhase;
  openCount: number;
  blockers: number;
  /** The non-terminal task working this pull request, or null. */
  fixStatus: TaskStatus | null;
  /** The label the progress bar shows while the review runs. */
  progressLabel: string;
}): ReviewStageView {
  const { prState, phase, openCount, blockers, fixStatus, progressLabel } = input;
  if (prState === 'merged') return { stage: 'merged', label: 'Merged', tone: 'purple' };
  if (prState === 'closed') return { stage: 'closed', label: 'Closed', tone: 'grey' };
  if (phase === 'fixing' || fixStatus !== null) {
    return { stage: 'fixing', label: 'Fixing', tone: 'indigo' };
  }
  if (!CODE_REVIEW_PHASE_AT_REST[phase]) {
    return { stage: 'reviewing', label: progressLabel || 'Reviewing', tone: 'blue' };
  }
  if (phase === 'failed') return { stage: 'failed', label: 'Did not finish', tone: 'red' };
  if (phase === 'cancelled') return { stage: 'stopped', label: 'Stopped', tone: 'grey' };
  if (openCount > 0) {
    return {
      stage: 'needs_fixes',
      label: `${openCount} finding${openCount === 1 ? '' : 's'}`,
      tone: blockers > 0 ? 'red' : 'amber',
    };
  }
  return {
    stage: 'ready',
    label: phase === 'fixed' ? 'Fixed · ready for review' : 'Ready for review',
    tone: 'green',
  };
}

/** The chip's colours. */
export function reviewStageChipClass(tone: ReviewStageTone): string {
  switch (tone) {
    case 'purple':
      return 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-400';
    case 'blue':
      return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400';
    case 'indigo':
      return 'border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400';
    case 'red':
      return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400';
    case 'amber':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400';
    case 'green':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
    case 'grey':
    default:
      return 'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  }
}

/** The row's left edge, so the list can be scanned by colour alone. */
export function reviewStageEdgeClass(tone: ReviewStageTone): string {
  switch (tone) {
    case 'purple':
      return 'border-l-purple-500';
    case 'blue':
      return 'border-l-blue-500';
    case 'indigo':
      return 'border-l-indigo-500';
    case 'red':
      return 'border-l-red-500';
    case 'amber':
      return 'border-l-amber-500';
    case 'green':
      return 'border-l-emerald-500';
    case 'grey':
    default:
      return 'border-l-zinc-300 dark:border-l-zinc-600';
  }
}
