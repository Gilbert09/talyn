import { runWithoutScope } from '../../db/client.js';
import { decide } from './decide.js';
import { applyActions, readCapacity } from './executor.js';
import { getPrForReview, getReview, touchEvaluated } from './store.js';
import { runsForCycle } from './store.js';
import { broadcastReview } from './broadcast.js';

/**
 * Deciding and acting on one review, with the passes coalesced.
 *
 * # Why coalescing rather than a queue
 *
 * A review's triggers arrive in bursts: five units settle within a second of each
 * other, a webhook lands while the poller is mid-tick, a user presses re-review
 * twice. Running an evaluation per trigger would mean five passes that each read
 * the same rows and four of which decide nothing.
 *
 * So a trigger for a review already being evaluated marks it DIRTY and the pass
 * re-runs once at the end. A burst costs one extra pass rather than N, and the
 * final pass sees the settled state rather than a partial one.
 *
 * # Why there is no lock
 *
 * The same reasoning `mergeQueue/evaluator.ts` records. A per-review lock would be
 * a pool transaction spanning fleet creates and GitHub reads — tens of seconds,
 * review after review — which is the shape that starved the pooler. Correctness
 * comes from two places that need no lock: every phase write is a CAS on the
 * review's version, so a losing pass stops; and every unit dispatch is an
 * insert-as-claim, so a losing dispatch boots nothing. Two replicas overlapping
 * during a deploy waste reads, never a microVM.
 */

interface Slot {
  running: boolean;
  dirty: boolean;
  triggers: Set<string>;
}

const slots = new Map<string, Slot>();

/** A pass may not hold a review for longer than this. */
const PASS_TIMEOUT_MS = 30_000;

/** How many decide→act rounds one pass may take before it yields. */
const MAX_ROUNDS = 8;

export function scheduleReviewEvaluation(reviewId: string, trigger: string): void {
  const slot = slots.get(reviewId);
  if (slot) {
    slot.dirty = true;
    slot.triggers.add(trigger);
    return;
  }
  const fresh: Slot = { running: true, dirty: false, triggers: new Set([trigger]) };
  slots.set(reviewId, fresh);
  // `runWithoutScope` because this is called from request handlers as well as
  // from the poller: without it a detached pass inherits the request's
  // transaction, which is dead by the time it runs.
  void runWithoutScope(() => drain(reviewId, fresh));
}

async function drain(reviewId: string, slot: Slot): Promise<void> {
  try {
    for (;;) {
      slot.dirty = false;
      const triggers = [...slot.triggers];
      slot.triggers.clear();
      try {
        await withTimeout(evaluateOnce(reviewId, triggers.join(',') || 'unknown'), PASS_TIMEOUT_MS);
      } catch (err) {
        console.warn(`[code-review] evaluating ${reviewId} failed:`, err);
      }
      if (!slot.dirty) break;
    }
  } finally {
    slots.delete(reviewId);
  }
}

/**
 * One pass: decide, act, and repeat while the acting changed something.
 *
 * Bounded by `MAX_ROUNDS` so a decision that keeps producing actions cannot spin.
 * `applyActions` returns true only when it dispatched and left the review row
 * alone, which is the one case where looking again immediately is worth it — units
 * may already have settled.
 */
async function evaluateOnce(reviewId: string, trigger: string): Promise<void> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const review = await getReview(reviewId);
    if (!review) return;

    const [pr, runs, capacity] = await Promise.all([
      getPrForReview(review.pullRequestId),
      runsForCycle(review.id, review.cycle),
      readCapacity(review.workspaceId),
    ]);

    const actions = decide({
      phase: review.phase as Parameters<typeof decide>[0]['phase'],
      cycle: review.cycle,
      preset: review.preset as Parameters<typeof decide>[0]['preset'],
      lensKeys: (review.lensKeys as string[]) ?? [],
      sweep: review.sweep,
      validate: review.validate,
      chunkTotal: review.chunkTotal,
      runs,
      unitsAllowed: capacity.unitsAllowed,
      prOpen: pr?.state === 'open',
    });

    await touchEvaluated(review.id);

    if (!actions.length) {
      await broadcastReview(review.id);
      return;
    }

    const onlyDispatched = await applyActions(review, actions);
    await broadcastReview(review.id);
    if (!onlyDispatched) return;
  }
  console.warn(
    `[code-review] ${reviewId} still had work after ${MAX_ROUNDS} rounds (trigger: ${trigger})`
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`evaluation exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Test seam: how many reviews are mid-pass right now. */
export function _evaluatorInFlight(): number {
  return slots.size;
}
