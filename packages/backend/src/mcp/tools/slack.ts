import type { SlackChannelsResponse } from '@talyn/shared';
import { callApi } from '../api.js';
import { defineTool, linesOrNone, requireId, textSchema } from './helpers.js';

export const SLACK = [
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
