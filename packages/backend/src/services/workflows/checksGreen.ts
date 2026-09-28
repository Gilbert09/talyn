import { domainEvents, type DomainPrChecksEvent } from '../events.js';
import { targetsForRepo } from '../webhookIndex.js';
import { evaluateWorkflowsForDelivery } from './engine.js';
import { CHECKS_GREEN_EVENT } from './facts.js';
import type { CheckBreakdown } from '../githubGraphql.js';
import type { WebhookDelivery } from '../webhookPayload.js';

/**
 * Raises the `pr_checks_passed` workflow trigger — "every check on this PR is
 * green" — from the recomputed check counts.
 *
 * WHY NOT A WEBHOOK. GitHub has no "the PR is green" event. It sends
 * `check_suite completed`, and on a repo with two CI providers that is one
 * suite of two: a rule on it fires while the other provider is still running,
 * and fires again when the second finishes. The only place the whole picture
 * exists is Talyn's own per-PR breakdown, recomputed after the check_run
 * coalescer flushes — the same signal the merge queue already trusts to decide
 * whether a queued head may merge.
 *
 * ONCE PER COMMIT, and that falls out of the existing idempotency rather than
 * needing new machinery. The engine claims `(workflow_id, delivery_id)` with a
 * unique index before it acts, so a synthetic delivery id derived from the head
 * SHA means the first flush that finds the commit green wins and every later
 * one — a re-run, another provider finishing, the reconciler — is a duplicate
 * that returns without acting. Push a new commit and the id changes with it,
 * which is exactly when the rule should be allowed to fire again.
 *
 * It follows that this must NOT be made to fire on a transition. "Is green
 * now" plus a sha-keyed claim is strictly simpler than "was not green and is
 * now", needs no previous state, and cannot be defeated by two replicas
 * observing the flush in different orders.
 */

/** Deliveries are synthesised here, so the id is ours to define. */
function deliveryIdFor(repoFullName: string, headSha: string): string {
  return `checks-green:${repoFullName}:${headSha}`;
}

/**
 * Whether a breakdown means "CI passed".
 *
 * `total > 0` is load-bearing and not a paranoia guard: a PR in a repo with no
 * CI at all has an all-zero breakdown, which satisfies "nothing failed and
 * nothing is running" while nothing has actually passed. Firing "all checks
 * passed" there would arm every such rule on every PR in the repo.
 *
 * `skipped` does not disqualify — a skipped check is not a failing one, and a
 * path-filtered job that correctly did not run is the normal case.
 */
export function checksAreGreen(checks: CheckBreakdown | undefined): boolean {
  if (!checks) return false;
  return checks.total > 0 && checks.failed === 0 && checks.inProgress === 0;
}

/**
 * Build the synthetic delivery. Separated so a test can assert its shape
 * without a database or an event loop.
 */
export function checksGreenDelivery(evt: DomainPrChecksEvent): WebhookDelivery {
  return {
    deliveryId: deliveryIdFor(evt.repoFullName, evt.headSha),
    eventType: CHECKS_GREEN_EVENT,
    action: 'completed',
    repoFullName: evt.repoFullName,
    enqueuedAtMs: Date.now(),
    payload: {
      prs: evt.prs.map((p) => ({ number: p.number })),
      head_sha: evt.headSha,
      checks: evt.checks,
    },
  };
}

async function onChecks(evt: DomainPrChecksEvent): Promise<void> {
  if (!checksAreGreen(evt.checks)) return;
  if (evt.prs.length === 0) return;

  // Authorization is re-asked here rather than carried on the event. The
  // coalescer's own flush checks it too, and both have to: a workspace whose
  // GitHub access was revoked between the flush and here must not get a
  // workflow run out of a cached answer.
  const targets = await targetsForRepo(evt.repoFullName);
  if (targets.length === 0) return;

  await evaluateWorkflowsForDelivery(checksGreenDelivery(evt), targets);
}

let subscribed = false;

/** Idempotent — `init()` runs once, but tests import this module freely. */
export function initChecksGreenTrigger(): void {
  if (subscribed) return;
  subscribed = true;
  domainEvents.on('pr:checks', (evt) => {
    // Never let a workflow failure touch the recompute that raised it: this
    // listener runs inside the coalescer's flush, and that flush owes the merge
    // queue its own signal.
    void onChecks(evt).catch((err) => {
      console.warn(
        `[workflows] checks-green trigger failed for ${evt.repoFullName} ${evt.headSha}:`,
        err instanceof Error ? err.message : err,
      );
    });
  });
}
