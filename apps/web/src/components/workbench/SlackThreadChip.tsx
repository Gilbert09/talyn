import { Slack } from 'lucide-react';
import type { SlackSessionSource } from '@talyn/shared';
import { openSlackThread, slackChannelLabel } from '../../lib/slackSession';

/** Header chip for a session started from Slack: the channel, and a link to the thread. */
export function SlackThreadChip({ source }: { source: SlackSessionSource }) {
  const label = slackChannelLabel(source);
  return (
    <button
      type="button"
      onClick={() => void openSlackThread(source)}
      disabled={!source.permalink}
      data-attr="session-open-slack-thread"
      title={`${source.teamName ?? 'Slack'}: open the thread in Slack`}
      aria-label={`Open the Slack thread in ${label}`}
      className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-60 disabled:hover:bg-muted"
    >
      <Slack className="h-3 w-3" />
      <span className="max-w-[10rem] truncate">{label}</span>
      <span className="text-foreground/70">Open thread</span>
    </button>
  );
}

/** The small mark next to a session's state icon in lists. Renders nothing for other sources. */
export function SlackSessionMark({ source }: { source: SlackSessionSource | null }) {
  if (!source) return null;
  return (
    <Slack
      className="h-3 w-3 shrink-0 text-muted-foreground"
      aria-label={`From Slack (${slackChannelLabel(source)})`}
      data-attr="session-slack-mark"
    />
  );
}
