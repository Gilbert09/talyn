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
    ? `workflows are switched off on this deployment (${FEATURE_FLAGS.workflows.envOverride}=false)`
    : 'this account is not in the audience for the "workflows" feature flag';
}
