import { slackScopeGrants } from '@talyn/shared';
import { desc, eq } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import { slackInstallations, slackThreads } from '../../db/schema.js';
import { isSlackRateLimited, SlackApiError } from './api.js';
import { callSlackAsBot } from './tokens.js';
import { THREAD_COLUMNS } from './threads.js';

export class SlackSessionReplyError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'SlackSessionReplyError';
  }
}

export async function replyInSessionThread(
  workbenchId: string,
  text: string
): Promise<{ channelId: string; threadTs: string; ts: string }> {
  if (typeof text !== 'string') {
    throw new SlackSessionReplyError('invalid_text', 400, 'text must contain a message.');
  }
  if (text.length > 40_000) {
    throw new SlackSessionReplyError('invalid_text', 400, 'text must be 40,000 characters or fewer.');
  }
  if (!text.trim()) {
    throw new SlackSessionReplyError('invalid_text', 400, 'text must contain a message.');
  }

  const [thread] = await getPoolDbClient()
    .select(THREAD_COLUMNS)
    .from(slackThreads)
    .where(eq(slackThreads.workbenchId, workbenchId))
    .orderBy(desc(slackThreads.createdAt), desc(slackThreads.id))
    .limit(1);
  if (!thread) {
    throw new SlackSessionReplyError('not_slack_session', 409, 'This session did not start from Slack.');
  }

  const [install] = await getPoolDbClient()
    .select({ scope: slackInstallations.scope })
    .from(slackInstallations)
    .where(eq(slackInstallations.teamId, thread.teamId))
    .limit(1);
  if (!install) {
    throw new SlackSessionReplyError('slack_not_installed', 409, 'Talyn is no longer installed in this Slack team. Install the Slack app again.');
  }
  if (!slackScopeGrants(install.scope, 'chat:write')) {
    throw new SlackSessionReplyError('slack_scope_missing', 409, 'The Slack app is missing chat:write. Install the Slack app again to grant it.');
  }

  try {
    const response = await callSlackAsBot<{ ts?: string }>(thread.teamId, 'chat.postMessage', {
      channel: thread.channelId,
      thread_ts: thread.threadTs,
      text,
    });
    if (!response.ts) throw new SlackSessionReplyError('slack_error', 502, 'Slack did not return a message timestamp.');
    return { channelId: thread.channelId, threadTs: thread.threadTs, ts: response.ts };
  } catch (err) {
    if (isSlackRateLimited(err)) {
      const retryAfterSeconds = Math.ceil((err.retryAfterMs ?? 60_000) / 1000);
      throw new SlackSessionReplyError('slack_rate_limited', 429, `Slack is rate limiting Talyn. Retry in ${retryAfterSeconds} seconds.`, retryAfterSeconds);
    }
    if (err instanceof SlackApiError && err.code === 'missing_scope') {
      throw new SlackSessionReplyError('slack_scope_missing', 409, `The Slack app is missing ${err.needed ?? 'chat:write'}. Install the Slack app again to grant it.`);
    }
    if (err instanceof SlackApiError) {
      throw new SlackSessionReplyError('slack_error', 502, `Slack refused the reply: ${err.code}.`);
    }
    throw err;
  }
}
