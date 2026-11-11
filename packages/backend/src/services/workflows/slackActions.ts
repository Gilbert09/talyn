import { eq } from 'drizzle-orm';
import type { WorkflowActionType, WorkflowTemplateExtras } from '@talyn/shared';
import { renderWorkflowTemplate, slackScopeGrants } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { slackInstallations } from '../../db/schema.js';
import { isSlackRateLimited, SlackApiError } from '../slack/api.js';
import { addReaction } from '../slack/statusReactions.js';
import { callSlackAsBot } from '../slack/tokens.js';
import { no, ok, type OneResult } from './actionResult.js';
import type { SlackActionContext } from './actions.js';

/**
 * The two Slack-only actions: reply in the trigger's thread, and react to the
 * trigger message. Both act as the team's bot.
 */

/**
 * How long to wait after a Slack 429 that carried no `Retry-After`. Slack
 * sends one on every 429 it documents, so this only covers a reply that
 * breaks that rule. A minute is Slack's own rate window for its per-method
 * tiers.
 */
const DEFAULT_SLACK_RETRY_MS = 60_000;

/** A Slack refusal as an outcome. A rate limit is parked with Slack's own wait. */
export function slackFailure(type: WorkflowActionType, err: unknown): OneResult {
  if (isSlackRateLimited(err)) {
    const waitMs = err.retryAfterMs ?? DEFAULT_SLACK_RETRY_MS;
    return {
      outcome: no(
        type,
        'rate_gated',
        `Slack is rate-limiting Talyn for another ${Math.round(waitMs / 1000)}s, so the action was skipped`
      ),
      retryAt: new Date(Date.now() + waitMs),
    };
  }
  if (err instanceof SlackApiError && err.code === 'missing_scope') {
    return { outcome: no(type, 'slack_scope_missing', reinstallMessage(err.needed ?? 'a permission')) };
  }
  return {
    outcome: no(type, 'slack_error', err instanceof SlackApiError ? `Slack refused: ${err.code}` : String(err)),
  };
}

function reinstallMessage(scope: string): string {
  return `The Slack app is missing ${scope}. Install the Slack app again to grant it.`;
}

/** The install's stored scope, or null when Talyn is not installed in the team. */
async function installScope(teamId: string): Promise<{ scope: string | null } | null> {
  const rows = await getPoolDbClient()
    .select({ scope: slackInstallations.scope })
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, teamId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Reply in the thread of the trigger message: in its thread when it is a
 * reply, else in a new thread under it.
 *
 * The stored scope is read first: an install from before `chat:write` was
 * asked for fails with `slack_scope_missing`, which is not retried, rather
 * than calling Slack to hear the same thing.
 */
export async function slackReply(
  text: string,
  ctx: SlackActionContext,
  extras: WorkflowTemplateExtras
): Promise<OneResult> {
  const { facts } = ctx;
  const install = await installScope(facts.teamId);
  if (!install) {
    return { outcome: no('slack_reply', 'slack_error', 'Talyn is no longer installed in this Slack team.') };
  }
  if (!slackScopeGrants(install.scope, 'chat:write')) {
    return { outcome: no('slack_reply', 'slack_scope_missing', reinstallMessage('chat:write')) };
  }
  const rendered = renderWorkflowTemplate(text, facts, extras);
  try {
    await callSlackAsBot(facts.teamId, 'chat.postMessage', {
      channel: facts.channelId,
      thread_ts: facts.threadTs ?? facts.ts,
      text: rendered,
    });
    return { outcome: ok('slack_reply', `replied (${rendered.length} chars)`) };
  } catch (err) {
    return slackFailure('slack_reply', err);
  }
}

/** React to the trigger message. Already reacted counts as done. */
export async function slackReact(emoji: string, ctx: SlackActionContext): Promise<OneResult> {
  const { facts } = ctx;
  try {
    await addReaction(facts.teamId, facts.channelId, facts.ts, emoji);
    return { outcome: ok('slack_react', `reacted :${emoji}:`) };
  } catch (err) {
    return slackFailure('slack_react', err);
  }
}
