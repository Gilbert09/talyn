import { v4 as uuid } from 'uuid';
import {
  CODE_REVIEW_PHASE_AT_REST,
  customReviewersForRepo,
  type CodeReviewPhase,
  type CodeReviewPreset,
} from '@talyn/shared';
import { withReviewCycleGate } from '../billing/entitlements.js';
import { workspaceMayUseCodeReview } from '../codeReviewAccess.js';
import { getSelfHostedClient } from '../selfHosted/credentials.js';
import { getPostHogCodeClient } from '../posthogCode/credentials.js';
import { discardFindings } from './findings.js';
import { scheduleReviewEvaluation } from './evaluator.js';
import {
  casTransition,
  ensureReview,
  getPrForReview,
  getReviewForPr,
  runsForCycle,
  settleRun,
  IN_FLIGHT_RUN_STATUSES,
  type ReviewRow,
} from './store.js';
import { lensesForPreset } from './lenses.js';
import { workspaceOwner, workspacePreset, workspaceReviewSettings } from './workspaceSettings.js';

/**
 * Starting and stopping a review cycle.
 *
 * Deliberately NOT in the evaluator. An evaluation pass decides how to continue
 * work somebody asked for; starting a cycle spends money, so it happens only where
 * a person or an explicit trigger asked for it. If `decide` could start one, an
 * ordinary recovery sweep would be able to run up a bill.
 */

export type StartOutcome =
  | { ok: true; review: ReviewRow; started: boolean }
  | {
      ok: false;
      code: 'not_available' | 'pr_closed' | 'pr_missing' | 'busy' | 'no_reviewers';
      message: string;
    };

export interface StartReviewInput {
  pullRequestId: string;
  preset?: CodeReviewPreset;
  /** Throw away the findings on record rather than carrying them forward. */
  reset?: boolean;
  /** Set when the clock started this rather than a person. */
  auto?: boolean;
  userId?: string | null;
}

/**
 * Start a cycle, or report why not.
 *
 * The order matters. Availability and the pull request's state are checked before
 * the plan gate, because a refusal the user cannot act on ("not in the audience")
 * should not be reported as a billing problem. The plan gate comes last and wraps
 * only the transition, so the advisory lock it takes is held for a row write rather
 * than for two API reads.
 */
export async function startReviewCycle(input: StartReviewInput): Promise<StartOutcome> {
  const pr = await getPrForReview(input.pullRequestId);
  if (!pr) {
    return { ok: false, code: 'pr_missing', message: 'That pull request is not tracked any more.' };
  }
  if (pr.state !== 'open') {
    return {
      ok: false,
      code: 'pr_closed',
      message: 'That pull request is closed, so there is nothing to review.',
    };
  }
  if (!(await workspaceMayUseCodeReview(pr.workspaceId))) {
    return {
      ok: false,
      code: 'not_available',
      message: 'Code review is not available for this workspace.',
    };
  }

  const existing = await getReviewForPr(input.pullRequestId);
  // A cycle already in flight is not an error and not a second cycle: the user
  // pressed a button twice, or a webhook raced a click. Hand back what is running.
  if (existing && !CODE_REVIEW_PHASE_AT_REST[existing.phase as CodeReviewPhase]) {
    return { ok: true, review: existing, started: false };
  }

  const settings = await workspaceReviewSettings(pr.workspaceId);
  const preset = input.preset ?? settings.preset;

  // Who reads this cycle, decided HERE and frozen on the row with the
  // transition below. A settings change after this point is for the next cycle.
  // Talyn's lenses are the preset's, before the files are known. `prepareCycle`
  // drops the ones this change gives nothing to look at.
  const customReviewers = customReviewersForRepo(settings.customReviewers, pr);
  const builtInLenses = settings.builtInReviewers ? lensesForPreset(preset) : [];
  if (!builtInLenses.length && !customReviewers.length) {
    // Refused before the plan gate and before any row moves. A cycle with no
    // reviewer can only fail, and it would spend a free plan's one cycle to do it.
    return {
      ok: false,
      code: 'no_reviewers',
      message: settings.customReviewers.length
        ? `Talyn's reviewers are turned off, and none of your reviewers runs on pull requests ` +
          `in ${pr.owner}/${pr.repo}. Turn on Talyn's reviewers or add a reviewer for this ` +
          'repository in Settings.'
        : "Talyn's reviewers are turned off and you have none of your own. Turn on Talyn's " +
          'reviewers or add a reviewer in Settings.',
    };
  }

  const ownerId = await workspaceOwner(pr.workspaceId);

  const outcome = await withReviewCycleGate(
    ownerId,
    { excludeReviewId: existing?.id },
    async (): Promise<StartOutcome> => {
      const review =
        existing ??
        (await ensureReview({
          id: uuid(),
          workspaceId: pr.workspaceId,
          repositoryId: pr.repositoryId,
          pullRequestId: input.pullRequestId,
          startedBy: input.userId ?? null,
        }));

      if (input.reset) await discardFindings(review.id);

      const moved = await casTransition(
        review.id,
        review.version,
        {
          phase: 'queued',
          phaseStartedAt: new Date(),
          cycle: review.cycle + 1,
          preset,
          lensKeys: builtInLenses,
          customReviewers,
          auto: input.auto === true,
          startedBy: input.userId ?? review.startedBy,
          lastError: null,
          lastErrorAt: null,
        },
        {
          fromPhase: review.phase as CodeReviewPhase,
          toPhase: 'queued',
          trigger: input.auto ? 'auto' : 'user:start',
          code: 'cycle_started',
          message: input.reset
            ? 'Reviewing again, discarding the earlier findings.'
            : 'Review queued.',
          detail: {
            preset,
            cycle: review.cycle + 1,
            builtInReviewers: builtInLenses.length > 0,
            customReviewers: customReviewers.length,
          },
        }
      );

      if (!moved) {
        // Somebody else moved it between our read and our write. Whatever they did
        // is at least as current as what we wanted.
        const current = await getReviewForPr(input.pullRequestId);
        return current
          ? { ok: true, review: current, started: false }
          : { ok: false, code: 'busy', message: 'The review changed while it was starting.' };
      }

      return {
        ok: true,
        review: { ...review, cycle: review.cycle + 1, preset, lensKeys: builtInLenses, customReviewers },
        started: true,
      };
    }
  );

  // Scheduled AFTER the gate, never inside it.
  //
  // The gate holds a transaction. `scheduleReviewEvaluation` detaches onto its
  // own connection, so a pass triggered from inside read the review BEFORE this
  // transaction committed — saw the phase it had before the transition (`ready`
  // or `fixed`, both at rest), decided there was nothing to do, and exited. The
  // review then sat in `queued` until the reconciler noticed, which it only does
  // after two minutes.
  //
  // That is the whole of "why does it take so long to start": not the dispatch,
  // which takes about two seconds, but a first evaluation that raced a commit and
  // lost. It updated `last_evaluated_at` on the way past, which is what made it
  // look like the review HAD been looked at.
  if (outcome.ok && outcome.started) {
    scheduleReviewEvaluation(outcome.review.id, input.auto ? 'auto' : 'user:start');
  }
  return outcome;
}

/**
 * Stop a cycle, cancelling whatever it has running.
 *
 * The sandboxes are cancelled best-effort and the review is moved regardless: a
 * cancel the user asked for must not be blocked by a host that will not answer.
 * The worst case is a microVM that runs to its own deadline with nobody reading
 * its output, which the fleet's `timeoutSec` already bounds.
 */
export async function cancelReviewCycle(review: ReviewRow): Promise<void> {
  const runs = (await runsForCycle(review.id, review.cycle)).filter((r) =>
    IN_FLIGHT_RUN_STATUSES.includes(r.status as (typeof IN_FLIGHT_RUN_STATUSES)[number])
  );

  await Promise.all(
    runs.map(async (run) => {
      try {
        if (run.provider === 'selfhosted' && run.sandboxId) {
          const client = await getSelfHostedClient(run.workspaceId);
          await client?.cancelSandbox(run.sandboxId);
        } else if (run.provider === 'posthog_code' && run.remoteTaskId && run.remoteRunId) {
          const client = await getPostHogCodeClient(run.workspaceId);
          await client?.cancelRun(run.remoteTaskId, run.remoteRunId);
        }
      } catch (err) {
        console.warn(`[code-review] cancelling ${run.id} failed:`, err);
      }
      await settleRun(run.id, { status: 'cancelled' });
    })
  );

  await casTransition(
    review.id,
    review.version,
    { phase: 'cancelled', phaseStartedAt: new Date() },
    {
      fromPhase: review.phase as CodeReviewPhase,
      toPhase: 'cancelled',
      trigger: 'user:cancel',
      code: 'cancelled',
      message: `Stopped with ${runs.length} part(s) running.`,
    }
  );
}

// The workspace's own review settings live in a leaf module — see
// `workspaceSettings.ts` for why — and are re-exported here so every existing
// caller keeps its import.
export { reportingBarsFor, workspaceReviewSettings } from './workspaceSettings.js';
export { workspaceOwner, workspacePreset };
