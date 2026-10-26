import { FEATURE_FLAGS, readFlagOverride } from '@talyn/shared';
import { evaluateFlag, type FlagSubject } from './featureFlags.js';

/**
 * Who may use Trunk merge ETAs. Fails closed, like `loops` and `mcpServers`:
 * the surface stores a third-party token, and an outage should not offer it to
 * accounts nobody chose. The routes gate on the CALLER, which is the same
 * subject `GET /features` answers for, so a drawn control never meets a 403.
 */
export async function userMayUseTrunkMergeEta(subject: FlagSubject): Promise<boolean> {
  return (await evaluateFlag('trunkMergeEta', subject)).enabled;
}

export function trunkMergeEtaRefusalReason(): string {
  const name = FEATURE_FLAGS.trunkMergeEta.envOverride;
  if (readFlagOverride('trunkMergeEta', process.env) === false) {
    return `Trunk merge ETAs are switched off on this deployment (${name}=false)`;
  }
  if (!process.env.TALYN_POSTHOG_KEY) {
    return `this deployment has no PostHog key, so Trunk merge ETAs stay off (set ${name}=true to use them anyway)`;
  }
  return 'this account is not in the audience for the "trunk-merge-eta" feature flag';
}
