import { FEATURE_FLAGS, readFlagOverride } from '@talyn/shared';
import { evaluateFlag, type FlagSubject } from '../featureFlags.js';

/**
 * Who may use the public API. The `publicApi` flag fails CLOSED: a token
 * starts sandbox sessions on fleet hardware with the owner's own agent
 * subscription. Evaluated against the TOKEN OWNER on every `/v1` request and
 * when a token is minted. Listing and revoking tokens are never gated, so a
 * person can always take a token away.
 */
export async function userMayUsePublicApi(subject: FlagSubject): Promise<boolean> {
  return (await evaluateFlag('publicApi', subject)).enabled;
}

/** Which of the three reasons a refusal is, because each sends you somewhere else. */
export function publicApiRefusalReason(): string {
  const env = FEATURE_FLAGS.publicApi.envOverride;
  if (readFlagOverride('publicApi', process.env) === false) {
    return `the API is switched off on this deployment (${env}=false)`;
  }
  if (!process.env.TALYN_POSTHOG_KEY) {
    return `this deployment has no PostHog key, so the API stays off (set ${env}=true to use it anyway)`;
  }
  return 'this account is not in the audience for the "public-api" feature flag';
}
