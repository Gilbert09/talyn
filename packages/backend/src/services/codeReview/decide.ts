import type { CodeReviewPhase, CodeReviewPreset } from '@talyn/shared';
import type { RunKind, RunRow, RunStatus } from './store.js';

/**
 * What to do next with a review, as a pure function of its state.
 *
 * Pure on purpose, and the merge queue's `decide.ts` is the precedent: the phase
 * graph is the part most likely to be wrong and the part hardest to test through
 * a database. Everything here is decided from a review row, its units and a
 * capacity number; nothing reads, writes, or dispatches.
 *
 * The executor performs what comes back and then calls this again, so a pass that
 * dispatches two units and then discovers the phase should advance does both in
 * one visit rather than waiting for the next tick.
 */

export type UnitKey = {
  kind: RunKind;
  /** '' for anything but a lens. Never null — see the claim index. */
  lens: string;
  chunkIndex: number;
};

export type Action =
  /** Read the pull request and work out the cycle's shape. */
  | { type: 'prepare' }
  /** Boot one agent run. */
  | { type: 'dispatch'; unit: UnitKey }
  /** Move the review on. */
  | { type: 'phase'; to: CodeReviewPhase; code: string; message?: string }
  /** Finish the cycle: stale what went away, then rest at `ready`. */
  | { type: 'finish' }
  /** Give up on the cycle, with a reason a person can read. */
  | { type: 'fail'; code: string; message: string };

export interface DecideState {
  phase: CodeReviewPhase;
  cycle: number;
  preset: CodeReviewPreset;
  /** Resolved at cycle start and frozen — never re-derived from the preset here. */
  lensKeys: string[];
  sweep: boolean;
  validate: boolean;
  chunkTotal: number;
  runs: RunRow[];
  /** How many more units this pass may fire. Zero means "not now", not "never". */
  unitsAllowed: number;
  /** A closed pull request stops being worth reviewing. */
  prOpen: boolean;
}


/**
 * What every reviewer died of, when they all died of the same thing.
 *
 * Returns null the moment the causes disagree — a mixed bag is not a diagnosis,
 * and claiming one would be worse than the generic message it replaces.
 */
function sharedFailureCode(state: DecideState): keyof typeof CYCLE_FAILURE_MESSAGES | null {
  const settled = state.runs.filter((r) => r.cycle === state.cycle && isSettled(r));
  if (!settled.length) return null;
  const codes = new Set(settled.map((r) => r.failureCode ?? ''));
  if (codes.size !== 1) return null;
  const only = [...codes][0]!;
  return only in CYCLE_FAILURE_MESSAGES
    ? (only as keyof typeof CYCLE_FAILURE_MESSAGES)
    : null;
}

/**
 * What a cycle says when every reviewer failed the same way.
 *
 * Each of these is a cause a person can act on, or one we have told them is
 * ours. None of them says "try again" unless trying again would actually help.
 */
const CYCLE_FAILURE_MESSAGES = {
  prompt_too_large:
    'This change was too large to send to a reviewer in one piece. Talyn now sends less ' +
    'of the diff inline and asks the reviewer to read the rest from the checkout, so ' +
    'reviewing again should work.',
  runner_out_of_space:
    'The machine running the review ran out of disk, so no reviewer could start. This ' +
    'is ours to fix rather than yours.',
  runner_out_of_memory:
    'The machine running the review ran out of memory, so no reviewer could start. ' +
    'This is ours to fix rather than yours.',
  no_provider:
    'No agent is connected for this workspace, so there was nothing to review with. ' +
    'Connect one in Settings.',
  timeout:
    'Every reviewer ran out of time before finishing. A smaller change, or a lighter ' +
    'review depth, will usually get through.',
} as const;

const SETTLED: RunStatus[] = ['succeeded', 'failed', 'cancelled', 'skipped'];

function isSettled(run: RunRow): boolean {
  return SETTLED.includes(run.status as RunStatus);
}

/** Every unit a phase needs, whether or not it exists yet. */
function plannedUnits(state: DecideState, phase: 'reviewing' | 'sweeping' | 'validating'): UnitKey[] {
  if (phase === 'reviewing') {
    const units: UnitKey[] = [];
    for (let chunk = 0; chunk < Math.max(1, state.chunkTotal); chunk++) {
      for (const lens of state.lensKeys) units.push({ kind: 'lens', lens, chunkIndex: chunk });
    }
    return units;
  }
  if (phase === 'sweeping') {
    return Array.from({ length: Math.max(1, state.chunkTotal) }, (_, chunk) => ({
      kind: 'sweep' as RunKind,
      lens: '',
      chunkIndex: chunk,
    }));
  }
  return [{ kind: 'validate', lens: '', chunkIndex: 0 }];
}

function runFor(state: DecideState, unit: UnitKey): RunRow | undefined {
  return state.runs.find(
    (r) =>
      r.cycle === state.cycle &&
      r.kind === unit.kind &&
      r.lens === unit.lens &&
      r.chunkIndex === unit.chunkIndex
  );
}

/** The phase that follows this one, given what the preset asked for. */
function nextPhaseAfter(
  state: DecideState,
  phase: 'reviewing' | 'sweeping' | 'validating'
): CodeReviewPhase {
  if (phase === 'reviewing' && state.sweep) return 'sweeping';
  if (phase !== 'validating' && state.validate) return 'validating';
  return 'ready';
}

/**
 * Work out the next actions for one phase of agent units.
 *
 * Three outcomes: fire what is missing and still allowed, wait for what is in
 * flight, or move on because everything settled.
 *
 * **A partial phase still advances.** If some units succeeded and others failed,
 * the review goes on with what it has — a review missing one lens is a smaller
 * review, and a review that refuses to show four good findings because a fifth
 * agent died is worse than useless. The cycle only fails when the phase produced
 * NOTHING, which is the case where continuing would show the user an empty list
 * and call it a clean bill of health.
 */
function decideUnitPhase(
  state: DecideState,
  phase: 'reviewing' | 'sweeping' | 'validating'
): Action[] {
  const planned = plannedUnits(state, phase);
  const existing = planned.map((unit) => ({ unit, run: runFor(state, unit) }));

  const missing = existing.filter((e) => !e.run).map((e) => e.unit);
  const inFlight = existing.filter((e) => e.run && !isSettled(e.run));
  const settled = existing.filter((e) => e.run && isSettled(e.run)).map((e) => e.run!);

  // Fire what we can, bounded by what the pacing allows. The remainder is not
  // lost: it has no row yet, so the next pass finds it missing again.
  if (missing.length && state.unitsAllowed > 0) {
    return missing.slice(0, state.unitsAllowed).map((unit) => ({ type: 'dispatch', unit }));
  }

  // Something is still running, or we are out of slots this pass. Either way
  // there is nothing to decide until a unit settles or a slot frees.
  if (inFlight.length || missing.length) return [];

  const succeeded = settled.filter((r) => r.status === 'succeeded');
  if (!succeeded.length) {
    // Nobody got anywhere. For the reviewing phase that is fatal to the cycle;
    // for the sweep or the judge it is a degradation we can live with, because
    // the lenses' findings are already recorded.
    if (phase === 'reviewing') {
      // "Try again" is the right advice only when the failure was transient. It
      // is actively misleading when every reviewer died for the same structural
      // reason — a prompt too large to spawn will be too large next time too —
      // so when the units agree on a cause, the cycle reports THAT.
      const shared = sharedFailureCode(state);
      return [
        {
          type: 'fail',
          code: shared ?? 'no_reviewer_finished',
          message: shared
            ? CYCLE_FAILURE_MESSAGES[shared]
            : 'No reviewer finished, so there is nothing to show yet. Try again.',
        },
      ];
    }
    const to = nextPhaseAfter(state, phase);
    return [
      {
        type: 'phase',
        to,
        code: phase === 'sweeping' ? 'sweep_failed' : 'judge_failed',
        message: 'Continuing with what the reviewers found.',
      },
      ...(to === 'ready' ? [{ type: 'finish' } as Action] : []),
    ];
  }

  const to = nextPhaseAfter(state, phase);
  return [
    { type: 'phase', to, code: `${phase}_done` },
    ...(to === 'ready' ? [{ type: 'finish' } as Action] : []),
  ];
}

/**
 * The whole decision. Returns an empty array when there is nothing to do, which
 * is the common case and must stay cheap.
 */
export function decide(state: DecideState): Action[] {
  // A closed pull request is not worth reviewing, and a review already resting
  // is not worth disturbing. Checked first so neither costs a phase walk.
  if (!state.prOpen && state.phase !== 'idle') {
    return state.phase === 'ready' || state.phase === 'failed' || state.phase === 'cancelled'
      ? []
      : [
          {
            type: 'fail',
            code: 'pr_closed',
            message: 'The pull request was closed while the review was running.',
          },
        ];
  }

  switch (state.phase) {
    case 'idle':
    case 'ready':
    case 'fixed':
    case 'failed':
    case 'cancelled':
      // At rest. A new cycle is started by a trigger, not by this function —
      // deciding to start one here would make an evaluation pass able to spend
      // money nobody asked it to.
      return [];

    case 'queued':
      return [{ type: 'phase', to: 'preparing', code: 'preparing' }];

    case 'preparing':
      return [{ type: 'prepare' }];

    case 'reviewing':
      return decideUnitPhase(state, 'reviewing');

    case 'sweeping':
      return decideUnitPhase(state, 'sweeping');

    case 'validating':
      return decideUnitPhase(state, 'validating');

    case 'fixing':
      // Driven entirely by the fix task's own status, which arrives as a
      // `task:status` domain event. Nothing to poll and nothing to dispatch.
      return [];
  }
}

/** How many units of this cycle have settled — the progress numerator. */
export function settledUnitCount(runs: RunRow[], cycle: number): number {
  return runs.filter((r) => r.cycle === cycle && isSettled(r)).length;
}

/** Whether any unit of this cycle is still waiting for a runner. */
export function hasDeferredUnit(runs: RunRow[], cycle: number): boolean {
  return runs.some(
    (r) => r.cycle === cycle && r.status === 'claimed' && r.dispatchedAt === null
  );
}
