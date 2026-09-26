import { debugBus } from '../debugBus.js';
import { TickGuard } from '../tickGuard.js';
import { guardCrossReplica } from '../advisoryLock.js';
import { runWithoutScope } from '../../db/client.js';
import { codeReviewKillSwitchPulled } from '../codeReviewAccess.js';
import { scheduleReviewEvaluation } from './evaluator.js';
import { appendReviewEvent, loadOrphanedClaims, loadStaleReviews, settleRun } from './store.js';
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
 * How long a claim may sit with no sandbox before it is written off.
 *
 * Five minutes, matching the task path's dispatch grace: long enough that no
 * dispatch in flight could still be inside it, short enough that a unit nobody
 * will ever run stops holding a slot in the workspace's ceiling.
 *
 * `dispatched_at IS NULL` is what makes this safe to do at all — it separates
 * "never got a runner" from "had one and it vanished", and the second case has its
 * own detection and its own failure code.
 */
const ORPHAN_GRACE_MS = 5 * 60_000;

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
    // The cheap, subject-free check first: with the deployment switched off there
    // is no account to ask about and no row worth reading.
    if (codeReviewKillSwitchPulled()) return;
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
   * Claims that never became a sandbox.
   *
   * Two quite different causes end up here and both are handled the same way: a
   * dispatch that crashed between claiming and creating, and a unit deferred for
   * capacity that never found room. The second is much the commoner, which is why
   * the event says so rather than reporting a fault.
   */
  private async reapOrphans(): Promise<void> {
    const orphans = await loadOrphanedClaims(new Date(Date.now() - ORPHAN_GRACE_MS), BATCH);
    for (const run of orphans) {
      const deferred = run.failureCode === 'capacity_deferred';
      await settleRun(run.id, {
        status: 'failed',
        failureCode: deferred ? 'capacity_deferred' : 'dispatch_lost',
      });
      await appendReviewEvent(run.reviewId, {
        toPhase: 'reviewing' as CodeReviewPhase,
        trigger: 'reconcile',
        code: deferred ? 'capacity_gave_up' : 'dispatch_lost',
        message: deferred
          ? 'No runner became free in time for one part of this review.'
          : 'One part of this review never started.',
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
