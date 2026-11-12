import { FEATURE_FLAGS, readFlagOverride } from '@talyn/shared';
import {
  evaluateFlag,
  workspaceHasFeature,
  type FlagSubject,
} from './featureFlags.js';

/**
 * Whether Workflows is available.
 *
 * # It used to be one boolean for the whole deployment
 *
 * Workflows shipped behind an email allow-list, then released to everybody
 * behind `WORKFLOWS_ENABLED` as a kill switch — one env var that answered the
 * same for every account. That was the right shape while the only question was
 * "is the engine armed at all", and the wrong shape the moment the real
 * question became "can we take this away from the one workspace whose 40
 * workflows are hammering a repository, without taking it from everybody".
 *
 * So the audience moved to a PostHog flag (`workflows`), evaluated per
 * workspace owner. `WORKFLOWS_ENABLED` survives as the break-glass override and
 * still wins — see `services/featureFlags.ts` for the precedence and why the
 * env layer has to stay.
 *
 * # The polarity did not change
 *
 * Absent still means ON. Workflows is a released feature; a deployment with no
 * PostHog key, a developer's local backend and a PostHog outage must all keep
 * serving it rather than hiding a page that exists. The flag's `fallback` in
 * the shared register is what encodes that.
 *
 * # It is still enforced where the work happens
 *
 * At the routes, in the engine before any action runs, and on the
 * task-dispatching actions. Hiding the nav item from one client was never a
 * gate — the CLI, the MCP server and plain `curl` all walk straight past one.
 */

/**
 * The cheap, subject-free check: has somebody pulled the kill switch for the
 * whole deployment?
 *
 * This is ONLY the env override, and it is not a substitute for the per-account
 * check. It exists for the two places that have no account to ask about — the
 * boot log, and the early-out at the top of a webhook delivery before any
 * workspace has been resolved — where the alternative is either a flag
 * evaluation against nobody or no early-out at all.
 */
export function workflowsKillSwitchPulled(): boolean {
  return readFlagOverride('workflows', process.env) === false;
}

/**
 * Whether this workspace's owner may use Workflows.
 *
 * Kept under its old name so the engine and the actions read the way they did.
 * It is once again genuinely per-workspace — as it was under the allow-list —
 * but without the allow-list's cost: the owner lookup is cached, and with
 * `TALYN_POSTHOG_PERSONAL_API_KEY` set the flag itself is evaluated in-process,
 * so a delivery pays no query and no round trip.
 */
export async function workspaceMayUseWorkflows(workspaceId: string): Promise<boolean> {
  return (await workspaceHasFeature('workflows', workspaceId)).enabled;
}

/** Whether this signed-in user may use Workflows — the route and `/features`. */
export async function userMayUseWorkflows(subject: FlagSubject): Promise<boolean> {
  return (await evaluateFlag('workflows', subject)).enabled;
}

/**
 * The message a refusal carries.
 *
 * Says which of the two reasons it is, because reading one as the other is an
 * hour: the switch was pulled for this deployment, or the account is not in the
 * flag's audience. There is no third case — an unreachable PostHog answers the
 * flag's fallback, which for workflows is ON, so an outage never produces a
 * refusal to explain.
 */
export function workflowsRefusalReason(): string {
  return workflowsKillSwitchPulled()
    ? `automations are switched off on this deployment (${FEATURE_FLAGS.workflows.envOverride}=false)`
    : 'this account is not in the audience for the "workflows" feature flag';
}

/**
 * Whether this workspace's owner may use Slack rules.
 *
 * Asked IN ADDITION to {@link workspaceMayUseWorkflows}: a Slack rule is a
 * workflow, so the workflows kill switch stops it too. Keyed on the owner for
 * the same reason as the workflows gate: a Slack message has no Talyn caller,
 * and the routes and the engine must give one answer.
 */
export async function workspaceMayUseSlackRules(workspaceId: string): Promise<boolean> {
  return (await workspaceHasFeature('slackChannelRules', workspaceId)).enabled;
}

/** The message a Slack-rule refusal carries. See {@link workflowsRefusalReason}. */
export function slackRulesRefusalReason(): string {
  return readFlagOverride('slackChannelRules', process.env) === false
    ? `Slack automations are switched off on this deployment (${FEATURE_FLAGS.slackChannelRules.envOverride}=false)`
    : 'this account is not in the audience for the "slack-channel-rules" feature flag';
}

/**
 * Whether this workspace's owner may use webhook rules.
 *
 * Asked IN ADDITION to {@link workspaceMayUseWorkflows} by the engine, and on
 * its own by the receiver. Keyed on the owner: a webhook has no Talyn caller.
 */
export async function workspaceMayUseWebhookRules(workspaceId: string): Promise<boolean> {
  return (await workspaceHasFeature('webhookRules', workspaceId)).enabled;
}

/** Whether this signed-in user may use webhook rules. The owner routes ask this. */
export async function userMayUseWebhookRules(subject: FlagSubject): Promise<boolean> {
  return (await evaluateFlag('webhookRules', subject)).enabled;
}

/**
 * Whether this workspace's owner may use issue rules (Linear, GitHub Issues).
 *
 * Asked IN ADDITION to {@link workspaceMayUseWorkflows} by the engine, and on
 * its own by the Linear receiver. Keyed on the owner: an issue event has no
 * Talyn caller.
 */
export async function workspaceMayUseIssueRules(workspaceId: string): Promise<boolean> {
  return (await workspaceHasFeature('issueRules', workspaceId)).enabled;
}

/** Whether this signed-in user may use issue rules. The owner routes ask this. */
export async function userMayUseIssueRules(subject: FlagSubject): Promise<boolean> {
  return (await evaluateFlag('issueRules', subject)).enabled;
}
