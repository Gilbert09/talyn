import {
  AlertCircle,
  AlertTriangle,
  CircleCheck,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader2,
} from 'lucide-react';
import type { WorkbenchChat } from '@talyn/shared';
import { cn } from '../../lib/utils';
import type { SessionState } from '../../lib/sessionState';

export type ChatTone = 'running' | 'error' | 'unread' | 'idle';

/** One tone for a workbench's chats: any running wins, then an error, then something waiting on you. */
export function chatTone(chats: WorkbenchChat[], unread: Record<string, true>): ChatTone {
  if (chats.some((c) => c.status === 'running')) return 'running';
  if (chats.some((c) => c.status === 'error')) return 'error';
  if (chats.some((c) => unread[c.id] || c.status === 'awaiting_input')) return 'unread';
  return 'idle';
}

export function StatusDot({ tone }: { tone: ChatTone }) {
  if (tone === 'running') {
    return <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-warning" aria-label="Running" />;
  }
  return (
    <span
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        tone === 'error' && 'bg-destructive',
        tone === 'unread' && 'bg-info',
        tone === 'idle' && 'bg-muted-foreground/30'
      )}
      aria-label={tone === 'error' ? 'Error' : tone === 'unread' ? 'Needs you' : 'Idle'}
    />
  );
}

export function PrPill({ number, state, draft }: { number: number; state: string; draft?: boolean }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 font-mono text-[10px] font-medium',
        state === 'merged'
          ? 'bg-merged/15 text-merged'
          : state === 'closed'
            ? 'bg-destructive/15 text-destructive'
            : draft
              ? 'bg-muted text-muted-foreground'
              : 'bg-success/15 text-success'
      )}
    >
      #{number}
    </span>
  );
}

/**
 * The sidebar row's state mark. Each state has its own shape as well as its
 * own colour, so the states are clear at a glance and without colour vision:
 * a spinner is work, a solid blue dot or an amber triangle needs you, a green
 * PR mark is open, a green tick is ready, a purple merge mark is done and a
 * red closed mark was not merged. The PR marks follow GitHub's colours.
 */
export function SessionStateIcon({ state }: { state: SessionState }) {
  const icon = 'h-3.5 w-3.5 shrink-0';
  const dot = 'h-2.5 w-2.5 shrink-0 rounded-full';
  const label = state.label;
  switch (state.kind) {
    case 'failed':
      return <AlertCircle className={cn(icon, 'text-destructive')} aria-label={label} />;
    case 'starting':
      return <Loader2 className={cn(icon, 'animate-spin text-info')} aria-label={label} />;
    case 'working':
      return <Loader2 className={cn(icon, 'animate-spin text-warning')} aria-label={label} />;
    case 'needs_reply':
      return <span className={cn(dot, 'bg-info')} aria-label={label} />;
    case 'pr_attention':
      return <AlertTriangle className={cn(icon, 'text-warning')} aria-label={label} />;
    case 'ready_to_merge':
      return <CircleCheck className={cn(icon, 'text-success')} aria-label={label} />;
    case 'pr_waiting':
      return <GitPullRequest className={cn(icon, 'text-success')} aria-label={label} />;
    case 'draft':
      return <GitPullRequestDraft className={cn(icon, 'text-muted-foreground')} aria-label={label} />;
    case 'merged':
      return <GitMerge className={cn(icon, 'text-merged')} aria-label={label} />;
    case 'closed':
      return <GitPullRequestClosed className={cn(icon, 'text-destructive')} aria-label={label} />;
    case 'unshipped':
      return <span className={cn(dot, 'border-[1.5px] border-dashed border-muted-foreground')} aria-label={label} />;
    case 'idle':
    default:
      return <span className={cn(dot, 'bg-muted-foreground/50')} aria-label={label} />;
  }
}
