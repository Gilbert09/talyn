import { debugBus } from '../debugBus.js';
import { TickGuard } from '../tickGuard.js';
import { guardCrossReplica } from '../advisoryLock.js';
import { runWithoutScope } from '../../db/client.js';
import { scheduleReviewEvaluation } from './evaluator.js';
import {
  appendReviewEvent,
  loadOrphanedClaims,
  loadStaleReviews,
  settleRun,
  UNIT_HEARTBEAT_GRACE_MS,
  type RunRow,
} from './store.js';
import { CAPACITY_GAVE_UP_MESSAGE, dropUnitBox, resumeUnitWait } from './executor.js';
import { FLEET_CAPACITY_WAIT } from '../selfHosted/capacityWait.js';
import type { CodeReviewPhase } from '@talyn/shared';

/**
 * The safety net under the event-driven engine.
 *
 * Every advance a review makes is normally caused by something: a user pressing a
 * button, a unit settling, a webhook arriving. This sweep exists for the advances
 * whose cause was LOST — a pass killed mid-flight by a deploy, a replica that went
 * away, a dispatch whose sandbox never materialised. Without it those reviews sit
 * in a working phase for ever with nothing scheduled to move them.
 *
 * It schedules evaluations rather than performing them, so a review recovered here
 * goes through exactly the same decision path as one advancing normally. A second
 * code path for recovery is a second code path to be wrong.
 */

const INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 2 * 60_000;
const BATCH = 20;

/**
 * How long a unit with no sandbox may go unwritten before this sweep acts on
 * it. A dispatch in flight finishes inside it, and a unit that waits for a
 * runner renews its row well inside it.
 *
 * `dispatched_at IS NULL` is what makes this safe to do at all — it separates
 * "never got a runner" from "had one and it vanished", and the second case has its
 * own detection and its own failure code.
 */
const ORPHAN_GRACE_MS = UNIT_HEARTBEAT_GRACE_MS;

/** A wait for a runner that went quiet, still inside its 30-minute bound: it resumes. */
export function isResumableWait(run: RunRow, now = Date.now()): boolean {
  return (
    run.status === 'claimed' &&
    run.failureCode === 'capacity_deferred' &&
    run.capacityWaitSince !== null &&
    now - run.capacityWaitSince.getTime() < FLEET_CAPACITY_WAIT.maxMs
  );
}

class CodeReviewReconciler {
  private timer: NodeJS.Timeout | null = null;
  private readonly guard = new TickGuard('code_review_reconcile', 5 * 60_000);

  init(): void {
    if (this.timer) return;
    debugBus.registerPoller(
      'code_review_reconcile',
      INTERVAL_MS,
      'Re-schedules code reviews whose evaluation was lost to a deploy or a crash, and writes off units that never got a runner.'
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    // The sweep is cheap when there is nothing to do: one indexed lookup over
    // non-terminal reviews.
    if (!this.guard.tryBegin()) return;
    const started = Date.now();
    let ok = true;
    let error: unknown;
    try {
      await guardCrossReplica(
        'codeReview:reconcile',
        async () => {
          await this.reapOrphans();
          await this.rescheduleStale();
        },
        { maxHoldMs: this.guard.maxMs }
      );
    } catch (err) {
      ok = false;
      error = err;
    } finally {
      this.guard.end();
      debugBus.pollerTick('code_review_reconcile', {
        durationMs: Date.now() - started,
        ok,
        error,
      });
    }
  }

  /**
   * Units with no sandbox that nobody has written for a while.
   *
   * A unit that waits for a runner renews its row, so it is never here while
   * its wait runs. Three causes end up here:
   *
   * - A wait for a runner whose process died (a deploy). Inside its 30-minute
   *   bound it resumes, on the same sandbox id: the fleet still holds a queued
   *   box for it.
   * - A wait for a runner past its bound. It fails and says so.
   * - A dispatch that crashed between claiming and creating. It fails as lost.
   */
  private async reapOrphans(): Promise<void> {
    const orphans = await loadOrphanedClaims(new Date(Date.now() - ORPHAN_GRACE_MS), BATCH);
    for (const run of orphans) {
      if (isResumableWait(run)) {
        try {
          await resumeUnitWait(run);
        } catch (err) {
          console.warn(`[code-review] resuming the wait of ${run.id} failed:`, err);
        }
        continue;
      }
      const deferred = run.failureCode === 'capacity_deferred';
      const settled = await settleRun(run.id, {
        status: 'failed',
        failureCode: deferred ? 'capacity_deferred' : 'dispatch_lost',
      });
      if (!settled) continue;
      // A queued box the fleet still holds for it would run for nobody.
      if (deferred && run.sandboxId) await dropUnitBox(run.workspaceId, run.sandboxId);
      await appendReviewEvent(run.reviewId, {
        toPhase: 'reviewing' as CodeReviewPhase,
        trigger: 'reconcile',
        code: deferred ? 'capacity_gave_up' : 'dispatch_lost',
        message: deferred ? CAPACITY_GAVE_UP_MESSAGE : 'One part of this review never started.',
        detail: { kind: run.kind, lens: run.lens, chunkIndex: run.chunkIndex },
      });
      scheduleReviewEvaluation(run.reviewId, 'reconcile:orphan');
    }
  }

  private async rescheduleStale(): Promise<void> {
    const reviews = await loadStaleReviews(new Date(Date.now() - STALE_AFTER_MS), BATCH);
    for (const review of reviews) {
      scheduleReviewEvaluation(review.id, 'reconcile:stale');
    }
  }
}

export const codeReviewReconciler = new CodeReviewReconciler();

export function initCodeReviewReconciler(): void {
  runWithoutScope(() => codeReviewReconciler.init());
}
