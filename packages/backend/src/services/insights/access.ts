import { FEATURE_FLAGS, readFlagOverride } from '@talyn/shared';
import { evaluateFlag, type FlagSubject } from '../featureFlags.js';

/**
 * Who may open Insights. Fails closed while it rolls out. The routes gate on
 * the CALLER, the same subject `GET /features` answers for, so a drawn nav
 * item never meets a 403. The data is the caller's own: every route also
 * checks that the caller owns the workspace.
 */
export async function userMayUseInsights(subject: FlagSubject): Promise<boolean> {
  return (await evaluateFlag('usageInsights', subject)).enabled;
}

export function insightsRefusalReason(): string {
  const name = FEATURE_FLAGS.usageInsights.envOverride;
  if (readFlagOverride('usageInsights', process.env) === false) {
    return `Insights is switched off on this deployment (${name}=false)`;
  }
  if (!process.env.TALYN_POSTHOG_KEY) {
    return `this deployment has no PostHog key, so Insights stays off (set ${name}=true to use it anyway)`;
  }
  return 'this account is not in the audience for the "usage-insights" feature flag';
}
