import { FEATURE_FLAGS, readFlagOverride } from '@talyn/shared';
import { evaluateFlag, workspaceHasFeature, type FlagSubject } from './featureFlags.js';

/**
 * Who may use Loops.
 *
 * # Why this one fails CLOSED, when workflows fails open
 *
 * The two features sit next to each other in the nav and have opposite
 * fallbacks, so the difference is worth stating plainly.
 *
 * A workflow acts when a webhook arrives: somebody pushed a commit, opened a
 * PR, left a review. There is a person at the other end of every firing, and if
 * PostHog is unreachable the safe answer is to keep a released feature working.
 *
 * A loop acts because time passed. It creates paid cloud tasks on hardware or
 * on a metered account at three in the morning with nobody watching. "PostHog
 * is down, so start every scheduler" spends the workspace's money and its agent
 * subscription before anyone is awake to notice — so when we cannot ask, the
 * answer is no. The `false` fallback on the `loops` entry in the shared
 * register is what encodes that.
 *
 * # Where it is enforced
 *
 * At the routes, and again in the scheduler before every firing. Not by hiding
 * the tab: the CLI, the MCP server and plain `curl` all walk straight past a
 * hidden nav item, and the scheduler has no client at all.
 *
 * A loop can also be saved and then lose access — a flag audience changes
 * without anything touching the row. That is why the fire-time check exists as
 * well as the save-time one, and why losing access shows up as a recorded,
 * visible run rather than a schedule that silently stops.
 */

/**
 * The cheap, subject-free check: is Loops switched off for this whole
 * deployment?
 *
 * ONLY the env override, and not a substitute for the per-workspace check. It
 * exists for the two places with no account to ask about — the boot log, and
 * the early-out at the top of a sweep tick before any loop row has been read.
 */
export function loopsKillSwitchPulled(): boolean {
  return readFlagOverride('loops', process.env) === false;
}

/**
 * Whether this workspace's owner may use Loops.
 *
 * Keyed on the OWNER, for the reason `workspaceMayUseFleet` is: a firing has no
 * caller. It is the clock. The owner is the one identity every run provably
 * has.
 */
export async function workspaceMayUseLoops(workspaceId: string): Promise<boolean> {
  return (await workspaceHasFeature('loops', workspaceId)).enabled;
}

/** Whether this signed-in user may use Loops — the routes and `/features`. */
export async function userMayUseLoops(subject: FlagSubject): Promise<boolean> {
  return (await evaluateFlag('loops', subject)).enabled;
}

/**
 * The message a refusal carries.
 *
 * Three cases here, not the two workflows has, because this flag's fallback is
 * OFF: an unreachable PostHog genuinely does produce a refusal, and telling
 * somebody "you are not in the audience" when the real answer is "we could not
 * ask" sends them to the wrong dashboard.
 */
export function loopsRefusalReason(): string {
  if (loopsKillSwitchPulled()) {
    return `loops are switched off on this deployment (${FEATURE_FLAGS.loops.envOverride}=false)`;
  }
  if (!process.env.TALYN_POSTHOG_KEY) {
    return `this deployment has no PostHog key, so loops stay off (set ${FEATURE_FLAGS.loops.envOverride}=true to run them anyway)`;
  }
  return 'this account is not in the audience for the "loops" feature flag';
}
