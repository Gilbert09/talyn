import { TASK_STATUS_TERMINAL, type TaskStatus } from '@talyn/shared';
import { domainEvents } from '../events.js';
import { runWithoutScope } from '../../db/client.js';
import { resolveEntitlement } from '../billing/entitlements.js';
import { workspaceMayUseCodeReview } from '../codeReviewAccess.js';
import { settleFixRun } from './fix.js';
import { scheduleReviewEvaluation } from './evaluator.js';
import { startReviewCycle, workspaceOwner, workspaceReviewSettings } from './cycle.js';
import { getPrForReview, getReviewForPr, reviewsByFixTask } from './store.js';
import { CODE_REVIEW_PHASE_AT_REST, type CodeReviewPhase } from '@talyn/shared';

/**
 * Turning things that happen in Talyn into review work.
 *
 * Two events matter, and every handler is wrapped in `runWithoutScope()`: domain
 * events are often emitted from inside a request's scoped transaction, and
 * AsyncLocalStorage would otherwise hand these detached handlers a transaction
 * that is dead by the time they run — a hang, then `25P02` over everything after.
 *
 * # Why the snapshot handler is careful about cost
 *
 * `pr:snapshot` fires on every poll upsert of every tracked pull request, which is
 * the busiest domain event in the app. There is no cheap deployment-wide switch to
 * check first — this feature is gated on PostHog alone — so the first thing it does
 * is the per-workspace feature check, which the flag service caches for thirty
 * seconds. Until the feature is switched on for an account, a snapshot costs one
 * cached boolean and nothing else.
 */

export function initCodeReviewTriggers(): void {
  /**
   * A task reached a terminal status.
   *
   * The fix run's settle path. The reconciler is the backstop for the case this
   * cannot cover — a task completing during a deploy, when no replica is listening
   * — which is the failure Loops needed its own settle sweep for.
   */
  domainEvents.on('task:status', (evt) => {
    if (!TASK_STATUS_TERMINAL[evt.status as TaskStatus]) return;
    void runWithoutScope(async () => {
      try {
        const reviews = await reviewsByFixTask(evt.taskId);
        for (const review of reviews) {
          await settleFixRun(review, evt.taskId, evt.status);
        }
      } catch (err) {
        console.warn(`[code-review] settling the fix for task ${evt.taskId} failed:`, err);
      }
    });
  });

  /**
   * A pull request's snapshot changed.
   *
   * Three jobs, in increasing cost: nudge a review that is mid-cycle, notice that
   * the head has moved past what the findings describe, and start an automatic
   * cycle when the workspace asked for one.
   */
  domainEvents.on('pr:snapshot', (evt) => {
    void runWithoutScope(async () => {
      try {
        await onSnapshot(evt.prId, evt.workspaceId, evt.state);
      } catch (err) {
        console.warn(`[code-review] handling a snapshot for ${evt.prId} failed:`, err);
      }
    });
  });
}

async function onSnapshot(
  prId: string,
  workspaceId: string,
  state: 'open' | 'closed' | 'merged'
): Promise<void> {
  // Cached for thirty seconds by the flag service, so this is the cheap gate that
  // keeps an unswitched-on deployment paying nothing for the busiest event we have.
  if (!(await workspaceMayUseCodeReview(workspaceId))) return;

  const review = await getReviewForPr(prId);

  // A review mid-cycle wants to know: its pull request closing is how `decide`
  // learns to stop, and a new commit is how the app learns its findings are behind.
  if (review && !CODE_REVIEW_PHASE_AT_REST[review.phase as CodeReviewPhase]) {
    scheduleReviewEvaluation(review.id, 'pr:snapshot');
    return;
  }
  if (state !== 'open') return;

  const settings = await workspaceReviewSettings(workspaceId);
  if (!settings.autoReview) return;

  // Re-checked at FIRE time, not just at the settings toggle. The toggle asserts
  // the plan on its OFF->ON transition, which is right for grandfathering — but an
  // account that later downgrades would otherwise keep reviewing every pull request
  // for ever on a plan that does not include it.
  const ownerId = await workspaceOwner(workspaceId);
  const entitlement = await resolveEntitlement(ownerId);
  if (entitlement.plan !== 'unlimited') return;

  // Only when the head has actually moved past what the findings describe, which
  // is what makes this idempotent against an event that fires on every poll: a
  // finished cycle leaves `reviewedHeadSha` equal to the current head, so the next
  // hundred snapshots do nothing.
  const pr = await getPrForReview(prId);
  const summary = (pr?.lastSummary ?? {}) as { headSha?: string; draft?: boolean };
  const head = summary.headSha ?? '';
  if (!head) return;

  // A draft is still being written. Reviewing one spends the workspace's
  // subscription on a state its author has not finished making, and then again
  // on every push until they mark it ready — which is the worst ratio of cost to
  // usefulness this feature has.
  //
  // AUTOMATIC reviews only. Asking for a review of your own draft is a perfectly
  // good thing to want, and the button still does it; what this refuses is doing
  // it on your behalf, repeatedly, unasked.
  if (summary.draft === true) return;
  if (review && review.reviewedHeadSha === head) return;
  if (review && review.targetHeadSha === head && review.phase !== 'idle') return;

  const outcome = await startReviewCycle({ pullRequestId: prId, auto: true });
  if (!outcome.ok) {
    // Refusals here are expected and mostly uninteresting — a free plan's cycle
    // already in flight, a pull request that closed between the two reads. Logged
    // at debug volume rather than warned about, because an automatic trigger that
    // shouts on every ordinary refusal trains people to ignore the log.
    if (outcome.code !== 'pr_closed' && outcome.code !== 'busy') {
      console.log(`[code-review] auto review for ${prId} declined: ${outcome.code}`);
    }
  }
}
