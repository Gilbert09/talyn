import type { WorkflowActionFailureCode, WorkflowActionOutcome, WorkflowActionType } from '@talyn/shared';
import { boxRefusalReason } from '@talyn/shared';
import { captureWorkspaceEvent } from '../analytics.js';
import { deferralRetryAt } from '../billing/boxDeferral.js';
import type { BoxGateError } from '../billing/entitlements.js';
import { isIssueContext, type WorkflowActionContext } from './actions.js';

/**
 * The outcome helpers every action module shares. Their own module so the
 * action modules (`actions.ts`, `sessionAction.ts`, `slackActions.ts`) do not
 * import each other in a circle.
 */

/** What one action produced. */
export interface OneResult {
  outcome: WorkflowActionOutcome;
  taskId?: string | null;
  pullRequestId?: string | null;
  /**
   * When a parked outcome should be tried again: a box refusal's recheck time,
   * or the `Retry-After` of a Slack rate limit.
   */
  retryAt?: Date | null;
  /** The session a `start_session` started. */
  workbenchId?: string | null;
  /** That session's link, for `{{session.url}}` in a later action. */
  sessionUrl?: string | null;
}

export function ok(type: WorkflowActionType, detail: string): WorkflowActionOutcome {
  return { type, ok: true, detail };
}

export function no(
  type: WorkflowActionType,
  code: WorkflowActionFailureCode,
  error: string
): WorkflowActionOutcome {
  return { type, ok: false, code, error };
}

/**
 * A box the plan refused, as a parked outcome. `usage_exhausted` and
 * `box_limit_reached` are retryable and carry their recheck time; a size the
 * plan cannot start is not (unattended runs are downsized before it).
 */
export function boxRefused(
  type: WorkflowActionType,
  err: BoxGateError,
  pullRequestId: string | null,
  ctx?: WorkflowActionContext
): OneResult {
  const code = boxRefusalReason(err.code);
  if (ctx) recordDeferral(ctx, code);
  return { outcome: no(type, code, err.message), pullRequestId, retryAt: deferralRetryAt(err) };
}

/**
 * A plan limit hit with nobody watching.
 *
 * Captured server-side for the reason Session 116 gives: a workflow run has no
 * request behind it, so there is no 402 to answer and no UpgradeModal to open.
 * The population that hits this hardest is exactly the one whose clients report
 * nothing.
 */
export function recordDeferral(ctx: WorkflowActionContext, gate: WorkflowActionFailureCode): void {
  const subject =
    ctx.integration === 'slack'
      ? { slack_team_id: ctx.facts.teamId, slack_channel_id: ctx.facts.channelId }
      : ctx.integration === 'webhook'
        ? { webhook_connection_id: ctx.facts.connectionId }
        : isIssueContext(ctx)
          ? { issue_integration: ctx.integration, issue_id: ctx.facts.externalId }
          : { repo: `${ctx.owner}/${ctx.repo}`, pr_number: ctx.facts.number };
  captureWorkspaceEvent(ctx.workspaceId, 'paywall_deferred', {
    source: 'workflow',
    gate,
    workflow_id: ctx.workflowId,
    ...subject,
  });
}
