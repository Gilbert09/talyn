import { FEATURE_FLAGS, readFlagOverride } from '@talyn/shared';
import { workspaceHasFeature } from '../featureFlags.js';

/**
 * Who may use the self-hosted Firecracker fleet.
 *
 * The fleet runs on hardware we own, with a memory budget that fits a couple of
 * concurrent runs, and it spends the workspace's own Claude or Codex
 * subscription. It is not a product surface yet — it is one box, and the point
 * of this gate is that turning `FLEET_ENABLED` on for the backend does not
 * simultaneously turn it on for every workspace that happens to configure
 * credentials.
 *
 * # The allow-list became a PostHog flag
 *
 * This used to be `FLEET_ALLOWED_EMAILS`, a comma-separated env var. Adding one
 * person to it was a production restart — and a restart is the exact moment the
 * advisory locks in `services/advisoryLock.ts` exist to survive. The audience
 * now lives in the `talyn-fleet` flag, where it can also be a percentage or a
 * cohort rather than five literal strings; the backend passes the owner's email
 * as a person property, so an email-based release condition expresses precisely
 * what the env var used to.
 *
 * `FLEET_ALLOWED` is the break-glass override that still wins over PostHog, for
 * the day the fleet has to be taken away from everybody faster than a flag save
 * propagates.
 *
 * # Fail closed, and not in the UI
 *
 * Unreachable PostHog means NOBODY, not everybody. That is the opposite of the
 * obvious default and it is deliberate: the failure mode of getting it
 * backwards is "the fleet quietly serves people it should not", which is
 * exactly the shape of the billing `clientGate` bug this codebase already paid
 * for — a paywall that read as opt-in, so the CLI, the MCP server and plain
 * `curl` all bypassed it with no error, no log and no metric. The `false`
 * fallback on the `fleet` entry in the shared register is what encodes it.
 *
 * For the same reason the gate is enforced where the work happens — at dispatch
 * and at credential-write — rather than by filtering a list the desktop
 * renders. Hiding a provider from one client is not a gate; it is a decoration
 * that three other callers walk straight past.
 *
 * # `FLEET_ENABLED` stays an env var, on purpose
 *
 * That one is not an audience question. It says whether this DEPLOYMENT has
 * fleet hardware and gateway tokens to reach, and it is read once at boot to
 * decide whether to register the provider at all. No flag can conjure a
 * machine, and a boot-time registration should not wait on a network call.
 */

/**
 * True when the workspace's owner is in the fleet's audience.
 *
 * Keyed on the OWNER rather than on whoever triggered the task. A task can be
 * dispatched by a webhook, the poller, a scheduled sweep or another member —
 * none of which has a user attached — and a gate that silently passes when it
 * cannot identify a caller is not a gate at all. The owner is the one identity
 * every task provably has.
 */
export async function workspaceMayUseFleet(workspaceId: string): Promise<boolean> {
  return (await workspaceHasFeature('fleet', workspaceId)).enabled;
}

/**
 * The message a refusal carries. Deliberately says which of the two reasons it
 * is: somebody pulled the override, or this account is simply not in the
 * audience. Reading one as the other is an hour.
 */
export function fleetRefusalReason(): string {
  return readFlagOverride('fleet', process.env) === false
    ? `the self-hosted fleet is switched off on this deployment (${FEATURE_FLAGS.fleet.envOverride}=false)`
    : 'this workspace is not in the audience for the self-hosted fleet';
}
