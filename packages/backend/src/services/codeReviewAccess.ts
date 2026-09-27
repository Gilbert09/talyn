import { evaluateFlag, workspaceHasFeature, type FlagSubject } from './featureFlags.js';

/**
 * Who may use code review.
 *
 * # Why this fails CLOSED
 *
 * It sits on the `loops` and `mcpServers` side of the line rather than the
 * `workflows` side, and the difference is worth stating because the two are
 * adjacent in the nav.
 *
 * A workflow acts when a webhook arrives: somebody pushed, opened a PR, left a
 * review. There is a person at the other end of every firing, so if PostHog is
 * unreachable the safe answer is to keep a released feature working.
 *
 * A code review spends the workspace's own agent subscription across several
 * sandboxes per pull request, and the fix run it leads to PUSHES COMMITS to a
 * branch that may not belong to the person who pressed the button. "PostHog is
 * unreachable, so let every account review and fix" is not a graceful
 * degradation. The `false` fallback on the `codeReview` entry in the shared
 * register is what encodes that.
 *
 * # Where it is enforced
 *
 * At the routes, and AGAIN in the engine before each unit is dispatched. Not by
 * hiding the tab: the CLI, the MCP server and plain `curl` all walk straight
 * past a hidden nav item, and the automatic-review trigger has no client at all.
 *
 * A review can also be started and then lose access — a flag audience changes
 * without anything touching a row. That is why the fire-time check exists as
 * well as the save-time one, and why losing access surfaces as a recorded,
 * visible refusal rather than a cycle that silently stops advancing.
 *
 * # There is no break glass, and that is on purpose
 *
 * `workflows`, `loops` and `fleet` each carry an env override that
 * short-circuits PostHog. This one carries none, matching `mcpServers`, and the
 * reasoning is sharper here than there: `readFlagOverride` is read generously —
 * anything but `false`/`0`/`off`/`no` reads as ON — and it short-circuits rather
 * than outvotes. So one env var set in production would hand a feature that
 * pushes commits to other people's branches to every account at once. PostHog's
 * audience is the only way in.
 *
 * Two consequences, worth knowing BEFORE going to look for the switch. There is
 * no way to run this against a deployment with no PostHog project — the thing
 * `LOOPS_ENABLED=true` exists for — so developing it locally needs a project.
 * And if PostHog is the broken thing, the answer is `fallback`, which is false:
 * the feature turns off rather than on, which is the direction you would have
 * wanted the switch to go anyway.
 */

/**
 * Whether this workspace's owner may use code review.
 *
 * Keyed on the OWNER, for the reason `workspaceMayUseFleet` and
 * `workspaceMayUseMcpServers` are: an automatic review has no caller. It is a
 * webhook or a sweep. The owner is the one identity every cycle provably has.
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
 * TWO cases, not the three `loops` has, and the missing one is the point: with no
 * env override, "an operator switched this off" is not a state this flag can be
 * in. What remains is the distinction that actually misleads people — telling
 * somebody "you are not in the audience" when the real answer is "we could not
 * ask PostHog" sends them to the wrong dashboard.
 *
 * The no-key case is a dead end rather than a hint. Its siblings can answer "set
 * X=true to use it anyway"; this one cannot, so it says what is true instead of
 * offering a switch that does not exist.
 */
export function codeReviewRefusalReason(): string {
  if (!process.env.TALYN_POSTHOG_KEY) {
    return (
      'this deployment has no PostHog key, and code review is gated on PostHog alone, ' +
      'so there is no way to switch it on here'
    );
  }
  return 'this account is not in the audience for the "code-review" feature flag';
}
