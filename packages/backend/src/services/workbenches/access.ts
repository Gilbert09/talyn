import { FEATURE_FLAGS, readFlagOverride } from '@talyn/shared';
import { evaluateFlag, workspaceHasFeature, type FlagSubject } from '../featureFlags.js';

/**
 * Who may use Workbenches. The `workbenches` flag fails CLOSED, on the `loops`
 * side of the line: a sandbox workbench keeps a fleet microVM alive and spends
 * the workspace's own agent subscription, so "PostHog is down" must not open
 * that to every account.
 *
 * Enforced at every route and at the terminal bridge — never by hiding the
 * nav item, which the CLI and plain `curl` walk straight past.
 */

/** Whether this signed-in user may use Workbenches — the routes and the terminal socket. */
export async function userMayUseWorkbenches(subject: FlagSubject): Promise<boolean> {
  return (await evaluateFlag('workbenches', subject)).enabled;
}

/** The same answer for a workspace's OWNER — background work that has no caller. */
export async function workspaceMayUseWorkbenches(workspaceId: string): Promise<boolean> {
  return (await workspaceHasFeature('workbenches', workspaceId)).enabled;
}

/** Says which of the three reasons a refusal is, because each sends you somewhere else. */
export function workbenchesRefusalReason(): string {
  const env = FEATURE_FLAGS.workbenches.envOverride;
  if (readFlagOverride('workbenches', process.env) === false) {
    return `workbenches are switched off on this deployment (${env}=false)`;
  }
  if (!process.env.TALYN_POSTHOG_KEY) {
    return `this deployment has no PostHog key, so workbenches stay off (set ${env}=true to use them anyway)`;
  }
  return 'this account is not in the audience for the "workbenches" feature flag';
}
