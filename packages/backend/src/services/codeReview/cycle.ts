import { v4 as uuid } from 'uuid';
import {
  CODE_REVIEW_PHASE_AT_REST,
  DEFAULT_CODE_REVIEW_PRESET,
  isCodeReviewPreset,
  resolveCodeReviewSettings,
  type CodeReviewPhase,
  type CodeReviewPreset,
} from '@talyn/shared';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { workspaces as workspacesTable } from '../../db/schema.js';
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
  | { ok: false; code: 'not_available' | 'pr_closed' | 'pr_missing' | 'busy'; message: string };

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

  const preset = input.preset ?? (await workspacePreset(pr.workspaceId));
  const ownerId = await workspaceOwner(pr.workspaceId);

  return withReviewCycleGate(
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
          detail: { preset, cycle: review.cycle + 1 },
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

      scheduleReviewEvaluation(review.id, input.auto ? 'auto' : 'user:start');
      return { ok: true, review: { ...review, cycle: review.cycle + 1, preset }, started: true };
    }
  );
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

/** The workspace's chosen depth, or the default. */
export async function workspacePreset(workspaceId: string): Promise<CodeReviewPreset> {
  const settings = await readSettings(workspaceId);
  const resolved = resolveCodeReviewSettings(settings);
  return isCodeReviewPreset(resolved.preset) ? resolved.preset : DEFAULT_CODE_REVIEW_PRESET;
}

/** The workspace's full review posture, for the fix run and the auto sweep. */
export async function workspaceReviewSettings(workspaceId: string) {
  return resolveCodeReviewSettings(await readSettings(workspaceId));
}

async function readSettings(workspaceId: string) {
  // Projects the settings column alone — `workspaces.logo` is an inline data URL
  // and must never ship on a dispatch path.
  const rows = await getDbClient()
    .select({ settings: workspacesTable.settings })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  const settings = rows[0]?.settings as { codeReview?: unknown } | null;
  return (settings?.codeReview ?? null) as Parameters<typeof resolveCodeReviewSettings>[0];
}

export async function workspaceOwner(workspaceId: string): Promise<string> {
  const rows = await getDbClient()
    .select({ ownerId: workspacesTable.ownerId })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  const ownerId = rows[0]?.ownerId;
  if (!ownerId) throw new Error(`workspace ${workspaceId} has no owner`);
  return ownerId;
}
