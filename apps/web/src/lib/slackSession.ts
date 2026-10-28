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

/**
 * Opens the thread's permalink in a new tab. Called straight from the click:
 * a browser grants `window.open` only while user activation is live. A
 * session without a permalink has nothing a browser can open.
 */
export async function openSlackThread(source: SlackSessionSource): Promise<void> {
  if (source.permalink) await openExternal(source.permalink);
}
