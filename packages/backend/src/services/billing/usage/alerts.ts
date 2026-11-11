import { eq } from 'drizzle-orm';
import {
  formatBoxHoursUsage,
  PLAN_LIMITS,
  PLAN_TIER_LABELS,
  type PlanTier,
  type UsageAlertEvent,
  type UsageAlertThreshold,
  type UsageExhaustedEvent,
} from '@talyn/shared';
import { getPoolDbClient } from '../../../db/client.js';
import { slackUserLinks } from '../../../db/schema.js';
import { debugBus } from '../../debugBus.js';
import { callSlackAsBot } from '../../slack/tokens.js';
import { webAppUrl } from '../../webApp.js';
import { emitUsageAlert, emitUsageExhausted } from '../../websocket.js';

/** Where the alert text sends people. */
/** The web app's billing page; Slack messages link to it. */
export const BILLING_PATH = '/settings/billing';

/** The alert sentence. Legacy Pro at 80% and 100% gets the Pro pitch (spec). */
export function usageAlertText(alert: UsageAlertEvent): string {
  const usage = formatBoxHoursUsage(alert.usedWsec, alert.includedWsec);
  const resets = new Date(alert.periodEnd).toISOString().slice(0, 10);
  const head =
    alert.thresholdPct >= 100
      ? `You have used all your included box-hours (${usage}). They reset on ${resets}.`
      : `You have used ${alert.thresholdPct}% of your included box-hours (${usage}). They reset on ${resets}.`;
  return `${head} ${nextStep(alert.tier, alert.thresholdPct)}`.trim();
}

function nextStep(tier: PlanTier, pct: UsageAlertThreshold): string {
  if (pct < 80) return '';
  const pro = `Upgrade to Pro for ${PLAN_LIMITS.pro.includedBoxHours} box-hours a month`;
  if (tier === 'free') return `${pro}.`;
  if (tier === 'legacy_pro') return `${pro}, or add credits.`;
  return pct >= 100 ? 'New boxes now use your credits.' : 'Add credits or turn on auto top-up so work does not stop.';
}

export function exhaustedText(event: UsageExhaustedEvent): string {
  const resets = new Date(event.periodEnd).toISOString().slice(0, 10);
  const action = event.creditsAllowed ? 'Add credits to start new boxes now.' : 'Upgrade to Pro to start new boxes now.';
  return `Your box-hours are used up (${PLAN_TIER_LABELS[event.tier]} plan). New boxes are paused and idle sessions are suspended until ${resets}. ${action}`;
}

/**
 * The owner's Slack identities. A user can be linked in more than one Slack
 * workspace; each gets the DM.
 */
async function slackLinksOf(ownerId: string): Promise<Array<{ teamId: string; slackUserId: string }>> {
  return getPoolDbClient()
    .select({ teamId: slackUserLinks.teamId, slackUserId: slackUserLinks.slackUserId })
    .from(slackUserLinks)
    .where(eq(slackUserLinks.userId, ownerId));
}

/**
 * DM the owner in Slack when they have linked an account. Best effort: a
 * failure is recorded on the debug bus and never thrown.
 *
 * Posting a DM needs the bot's `chat:write` scope. An install from before
 * Talyn asked for it answers `missing_scope` until the team installs the app
 * again, and the in-app alert is the one that lands.
 */
export async function sendSlackDm(ownerId: string, text: string): Promise<void> {
  let links: Array<{ teamId: string; slackUserId: string }>;
  try {
    links = await slackLinksOf(ownerId);
  } catch (error) {
    debugBus.recordEvent({ service: 'billing', action: 'usage_slack_dm', summary: 'Could not read Slack links', ok: false, error });
    return;
  }
  const link = webAppUrl(BILLING_PATH);
  const body = link ? `${text}\n<${link}|Open billing>` : text;
  for (const { teamId, slackUserId } of links) {
    try {
      await callSlackAsBot(teamId, 'chat.postMessage', { channel: slackUserId, text: body });
    } catch (error) {
      debugBus.recordEvent({ service: 'billing', action: 'usage_slack_dm', summary: `Slack DM to ${slackUserId} failed`, ok: false, error });
    }
  }
}

/** Send one threshold alert: the WS event and a Slack DM. */
export async function sendUsageAlert(ownerId: string, alert: UsageAlertEvent): Promise<void> {
  emitUsageAlert(ownerId, alert);
  debugBus.recordEvent({
    service: 'billing',
    action: `usage_alert_${alert.thresholdPct}`,
    summary: usageAlertText(alert).slice(0, 200),
    ok: true,
  });
  await sendSlackDm(ownerId, usageAlertText(alert));
}

/** Tell the owner they are out of hours and credits: the WS event and a Slack DM. */
export async function sendExhaustedNotice(ownerId: string, tier: PlanTier, periodEnd: Date): Promise<void> {
  const event: UsageExhaustedEvent = {
    tier,
    periodEnd: periodEnd.toISOString(),
    creditsAllowed: PLAN_LIMITS[tier].creditsAllowed,
  };
  emitUsageExhausted(ownerId, event);
  debugBus.recordEvent({ service: 'billing', action: 'usage_exhausted', summary: exhaustedText(event).slice(0, 200), ok: true });
  await sendSlackDm(ownerId, exhaustedText(event));
}
