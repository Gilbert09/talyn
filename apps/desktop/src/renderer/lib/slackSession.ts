import type { SlackSessionSource, Workbench } from '@talyn/shared';
import { openExternal } from './openExternal';

/** The Slack source of a session, or null for any other kind. */
export function slackSourceOf(workbench: Pick<Workbench, 'source'>): SlackSessionSource | null {
  return workbench.source?.kind === 'slack' ? workbench.source : null;
}

/** `#general`, or "Slack DM" for a direct message (a channel id that starts with `D`). */
export function slackChannelLabel(source: Pick<SlackSessionSource, 'channelId' | 'channelName'>): string {
  if (source.channelId.startsWith('D')) return 'Slack DM';
  return source.channelName ? `#${source.channelName}` : 'Slack';
}

/** Slack's own deep link to the thread, handled by the Slack desktop app. */
export function slackDeepLink(source: SlackSessionSource): string {
  const message = source.threadTs || source.messageTs;
  const query = new URLSearchParams({ team: source.teamId, id: source.channelId, message });
  return `slack://channel?${query.toString()}`;
}

/** Opens the thread in the Slack app, or its permalink in the browser when the app is not there. */
export async function openSlackThread(source: SlackSessionSource): Promise<void> {
  try {
    await openExternal(slackDeepLink(source));
  } catch {
    if (source.permalink) await openExternal(source.permalink);
  }
}
