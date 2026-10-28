import { FEATURE_FLAGS, readFlagOverride } from '@talyn/shared';
import { evaluateFlag, type FlagSubject } from '../featureFlags.js';

/**
 * Who may use Slack sessions. Fails closed, like `loops` and `trunkMergeEta`:
 * the install stores a bot token that reads a whole Slack workspace.
 *
 * The routes ask about the CALLER, the same subject `GET /features` answers
 * for, so a drawn settings section never meets a 403. Event processing (P2)
 * asks about the Talyn user the Slack identity is linked to.
 */
export async function userMayUseSlack(subject: FlagSubject): Promise<boolean> {
  return (await evaluateFlag('slack', subject)).enabled;
}

export function slackRefusalReason(): string {
  const name = FEATURE_FLAGS.slack.envOverride;
  if (readFlagOverride('slack', process.env) === false) {
    return `Slack sessions are switched off on this deployment (${name}=false)`;
  }
  if (!process.env.TALYN_POSTHOG_KEY) {
    return `this deployment has no PostHog key, so Slack sessions stay off (set ${name}=true to use them anyway)`;
  }
  return 'this account is not in the audience for the "slack" feature flag';
}
