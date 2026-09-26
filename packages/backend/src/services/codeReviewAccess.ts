import { FEATURE_FLAGS, readFlagOverride } from '@talyn/shared';
import { evaluateFlag, workspaceHasFeature, type FlagSubject } from './featureFlags.js';

/**
 * Who may use code review.
 *
 * # Why this one fails CLOSED
 *
 * It sits on the `loops` side of the line rather than the `workflows` side, and
 * the difference is worth stating because the two are adjacent in the nav.
 *
 * A workflow acts when a webhook arrives: somebody pushed, opened a PR, left a
 * review. There is a person at the other end of every firing, so if PostHog is
 * unreachable the safe answer is to keep a released feature working.
 *
 * A code review spends the workspace's own agent subscription across several
 * sandboxes per pull request, and the fix run it leads to PUSHES COMMITS to a
 * branch that may not belong to the person who pressed the button. "PostHog is
 * down, so let every account review and fix" is not a graceful degradation. The
 * `false` fallback on the `codeReview` entry in the shared register is what
 * encodes that.
 *
 * # Where it is enforced
 *
 * At the routes, and AGAIN in the engine before each unit is dispatched. Not by
 * hiding the tab: the CLI, the MCP server and plain `curl` all walk straight
 * past a hidden nav item, and the auto-review sweep has no client at all.
 *
 * A review can also be started and then lose access — a flag audience changes
 * without anything touching a row. That is why the fire-time check exists as
 * well as the save-time one, and why losing access surfaces as a recorded,
 * visible refusal rather than a cycle that silently stops advancing.
 */

/**
 * The cheap, subject-free check: is code review switched off for this whole
 * deployment?
 *
 * ONLY the env override, and not a substitute for the per-workspace check. It
 * exists for the two places with no account to ask about — the boot log, and the
 * early-out at the top of a sweep tick before any row has been read.
 */
export function codeReviewKillSwitchPulled(): boolean {
  return readFlagOverride('codeReview', process.env) === false;
}

/**
 * Whether this workspace's owner may use code review.
 *
 * Keyed on the OWNER, for the reason `workspaceMayUseFleet` and
 * `workspaceMayUseLoops` are: an automatic review has no caller. It is a webhook
 * or a sweep. The owner is the one identity every cycle provably has.
 */
export async function workspaceMayUseCodeReview(workspaceId: string): Promise<boolean> {
  return (await workspaceHasFeature('codeReview', workspaceId)).enabled;
}

/** Whether this signed-in user may use code review — the routes and `/features`. */
export async function userMayUseCodeReview(subject: FlagSubject): Promise<boolean> {
  return (await evaluateFlag('codeReview', subject)).enabled;
}

/**
 * The message a refusal carries.
 *
 * Three cases, not two, because this flag's fallback is OFF: an unreachable
 * PostHog genuinely does produce a refusal, and telling somebody "you are not in
 * the audience" when the real answer is "we could not ask" sends them to the
 * wrong dashboard.
 */
export function codeReviewRefusalReason(): string {
  if (codeReviewKillSwitchPulled()) {
    return `code review is switched off on this deployment (${FEATURE_FLAGS.codeReview.envOverride}=false)`;
  }
  if (!process.env.TALYN_POSTHOG_KEY) {
    return `this deployment has no PostHog key, so code review stays off (set ${FEATURE_FLAGS.codeReview.envOverride}=true to run it anyway)`;
  }
  return 'this account is not in the audience for the "code review" feature flag';
}
