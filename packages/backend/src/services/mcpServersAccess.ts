import { FEATURE_FLAGS, readFlagOverride } from '@talyn/shared';
import { evaluateFlag, workspaceHasFeature, type FlagSubject } from './featureFlags.js';

/**
 * Who may use MCP tool servers.
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
 */

/**
 * The cheap, subject-free check: are tool servers switched off for this whole
 * deployment?
 *
 * ONLY the env override, and not a substitute for the per-workspace check. It
 * exists for the boot log and for an early-out before any row has been read.
 */
export function mcpServersKillSwitchPulled(): boolean {
  return readFlagOverride('mcpServers', process.env) === false;
}

/**
 * Whether this workspace's owner may use tool servers.
 *
 * Keyed on the OWNER, for the reason `workspaceMayUseFleet` is: a dispatch may
 * have no caller — a loop firing is the clock, and a merge-queue fix run is a
 * watcher. The owner is the one identity every run provably has.
 */
export async function workspaceMayUseMcpServers(workspaceId: string): Promise<boolean> {
  return (await workspaceHasFeature('mcpServers', workspaceId)).enabled;
}

/** Whether this signed-in user may use tool servers — the routes and `/features`. */
export async function userMayUseMcpServers(subject: FlagSubject): Promise<boolean> {
  return (await evaluateFlag('mcpServers', subject)).enabled;
}

/**
 * The message a refusal carries.
 *
 * Three cases, like loops and for the same reason: this flag's fallback is OFF,
 * so an unreachable PostHog genuinely does produce a refusal, and telling
 * somebody "you are not in the audience" when the real answer is "we could not
 * ask" sends them to the wrong dashboard.
 */
export function mcpServersRefusalReason(): string {
  if (mcpServersKillSwitchPulled()) {
    return `tool servers are switched off on this deployment (${FEATURE_FLAGS.mcpServers.envOverride}=false)`;
  }
  if (!process.env.TALYN_POSTHOG_KEY) {
    return `this deployment has no PostHog key, so tool servers stay off (set ${FEATURE_FLAGS.mcpServers.envOverride}=true to use them anyway)`;
  }
  return 'this account is not in the audience for the "mcp-servers" feature flag';
}
