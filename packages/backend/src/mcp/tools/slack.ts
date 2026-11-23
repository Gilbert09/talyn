import type { SlackChannelsResponse } from '@talyn/shared';
import { callApi } from '../api.js';
import { defineTool, linesOrNone, requireId, str, textSchema } from './helpers.js';
import type { McpCallContext } from './index.js';

function targetSession(args: Record<string, unknown>, ctx: McpCallContext | undefined): string {
  const self = ctx?.session?.workbenchId;
  const sessionId = str(args.session_id) ?? self;
  if (!sessionId) throw new Error('session_id is required');
  if (self && sessionId !== self) throw new Error('A session can reply in its own Slack thread only.');
  return sessionId;
}

export const SLACK = [
  defineTool(
    'slack_reply',
    'Reply in the Slack thread this session started from, as the Talyn bot. Use this for every message to that thread; never post there with another Slack tool, which posts as a person. Fails when the session did not start from Slack.',
    {
      text: { type: 'string', description: 'The reply text. Up to 40,000 characters.' },
      session_id: { type: 'string', description: 'The session. Default: the calling session.' },
    },
    ['text'],
    { openWorldHint: true },
    async (ownerId, args, ctx) => {
      const sessionId = targetSession(args, ctx);
      if (typeof args.text !== 'string') throw new Error('text is required');
      const result = await callApi<{ ts: string }>(
        ownerId,
        'POST',
        `/workbenches/${encodeURIComponent(sessionId)}/slack-reply`,
        { text: args.text }
      );
      return `Posted Slack reply at ${result.ts}.`;
    }
  ),
  defineTool(
    'list_slack_channels',
    'List the Slack channels Talyn is a member of in one Slack team. Use the channel ids in a Slack automation. Only channels the bot was invited to appear.',
    { teamId: textSchema },
    ['teamId'],
    { readOnlyHint: true, openWorldHint: true },
    async (ownerId, args) => {
      const teamId = requireId(args, 'teamId');
      const result = await callApi<SlackChannelsResponse>(
        ownerId,
        'GET',
        `/slack/teams/${encodeURIComponent(teamId)}/channels`
      );
      const lines = linesOrNone(
        result.channels,
        (channel) => `${channel.id}  #${channel.name}${channel.isPrivate ? '  private' : ''}`
      );
      return result.needsScope
        ? `${lines}\nSlack refused the full list: the app lacks the ${result.needsScope} scope. Reinstall Slack in Talyn.`
        : lines;
    },
    'slackChannelRules'
  ),
];
