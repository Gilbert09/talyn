import { AlertCircle, CircleCheck, GitPullRequest, MessageCircleQuestion, MessagesSquare, Play } from 'lucide-react';
import type { ThreadSessionEvent } from '@talyn/shared';
import { threadSessionEventText } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { openExternal } from '../../lib/openExternal';
import { threadCardTitle } from '../../lib/threads';
import { useNavigationStore } from '../../stores/navigation';
import { Button } from '../ui/button';

function iconFor(event: ThreadSessionEvent) {
  switch (event.action) {
    case 'session_started':
      return Play;
    case 'pr_opened':
      return GitPullRequest;
    case 'needs_input':
      return MessageCircleQuestion;
    case 'session_finished':
    default:
      return event.status === 'error' ? AlertCircle : CircleCheck;
  }
}

/**
 * A `talyn_thread` transcript event: one of the thread's sessions started,
 * finished its turn, opened a pull request or needs an answer. Open goes to
 * the session.
 */
export function ThreadSessionCard({ event }: { event: ThreadSessionEvent }) {
  const navigate = useNavigationStore((s) => s.navigate);
  const Icon = iconFor(event);
  const error = event.action === 'session_finished' && event.status === 'error';
  return (
    <div
      className={cn('rounded-md border bg-card text-xs', error ? 'border-destructive/40' : 'border-border')}
      data-testid="thread-session-card"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <Icon
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            error ? 'text-destructive' : event.action === 'needs_input' ? 'text-info' : 'text-muted-foreground'
          )}
        />
        <span className="font-medium">{threadCardTitle(event)}</span>
        <span className="min-w-0 truncate text-muted-foreground" title={threadSessionEventText(event)}>
          {event.name || event.sessionId}
          {event.repo && ` · ${event.repo}`}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {event.prUrl && (
            <Button variant="outline" size="sm" onClick={() => void openExternal(event.prUrl!)}>
              <GitPullRequest className="mr-1 h-3 w-3" />
              Pull request
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate({ view: 'workbench', id: event.sessionId })}
            aria-label={`Open the session ${event.name || event.sessionId}`}
          >
            Open
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A message Talyn wrote to wake the thread. A compact system note, not the person's bubble. */
export function TalynMessageCard({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="talyn-message">
      <MessagesSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="shrink-0 font-medium text-foreground/70">Talyn</span>
      <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>
    </div>
  );
}
