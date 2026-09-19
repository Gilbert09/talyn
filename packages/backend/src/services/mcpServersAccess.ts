import { evaluateFlag, workspaceHasFeature, type FlagSubject } from './featureFlags.js';

/**
 * Who may use MCP servers.
 *
 * # Why this fails CLOSED
 *
 * Same answer as `fleet` and `loops`, and for a reason of its own worth
 * stating: this is the surface where somebody pastes a Stripe restricted key or
 * a GitHub token. Failing open during a PostHog outage would offer credential
 * storage to every account, including ones nobody decided to offer it to. It is
 * also fleet-only — PostHog Code has no equivalent — so a workspace that got it
 * without the fleet would get a page that cannot do anything.
 *
 * # Where it is enforced
 *
 * At every route, and again at dispatch. Not by hiding the nav item: the CLI,
 * the MCP server and plain `curl` walk straight past a hidden tab, and a
 * dispatch has no client at all.
 *
 * A workspace can also connect servers and then lose access — a flag audience
 * changes without anything touching a row. The dispatch-time check is what
 * makes that a run WITHOUT those tools rather than a run that fails, which is
 * the right degradation: the task itself is still worth doing.
 *
 * # There is no break glass, and that is on purpose
 *
 * Every other flag in the register carries an env override that short-circuits
 * PostHog — `WORKFLOWS_ENABLED`, `LOOPS_ENABLED`, `FLEET_ALLOWED`. This one
 * carries none: Tom's call is that its audience is PostHog's alone.
 *
 * So `readFlagOverride('mcpServers', …)` is always undefined, and every gate
 * here falls straight through to PostHog and then to `fallback`. Two things
 * follow that are worth knowing BEFORE you go looking for the switch. There is
 * no way to run this feature against a deployment with no PostHog project —
 * the thing `LOOPS_ENABLED=true` exists for. And if PostHog is the broken
 * thing, the answer is `fallback`, which is false: the feature turns off rather
 * than on, which is the direction you would have wanted the switch to go.
 */

/**
 * Whether this workspace's owner may use MCP servers.
 *
 * Keyed on the OWNER, for the reason `workspaceMayUseFleet` is: a dispatch may
 * have no caller — a loop firing is the clock, and a merge-queue fix run is a
 * watcher. The owner is the one identity every run provably has.
 */
export async function workspaceMayUseMcpServers(workspaceId: string): Promise<boolean> {
  return (await workspaceHasFeature('mcpServers', workspaceId)).enabled;
}

/** Whether this signed-in user may use MCP servers — the routes and `/features`. */
export async function userMayUseMcpServers(subject: FlagSubject): Promise<boolean> {
  return (await evaluateFlag('mcpServers', subject)).enabled;
}

/**
 * The message a refusal carries.
 *
 * TWO cases, not the three its siblings have, and the missing one is the point:
 * there is no env override, so "an operator switched this off" is not a state
 * this flag can be in. What remains is the distinction that actually misleads
 * people — "you are not in the audience" when the real answer is "we could not
 * ask PostHog" sends somebody to the wrong dashboard.
 *
 * The no-key case is now a dead end rather than a hint. Every other flag can
 * answer "set X=true to use it anyway"; this one cannot, so it says what is
 * true instead of offering a switch that does not exist.
 */
export function mcpServersRefusalReason(): string {
  if (!process.env.TALYN_POSTHOG_KEY) {
    return (
      'this deployment has no PostHog key, and MCP servers are gated on PostHog alone, ' +
      'so there is no way to switch them on here'
    );
  }
  return 'this account is not in the audience for the "mcp-servers" feature flag';
}
