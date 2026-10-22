import { AlertCircle, AlertTriangle, CircleCheck, GitMerge, Loader2, XCircle } from 'lucide-react';
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
 * tick is ready, a violet merge mark is done.
 */
export function SessionStateIcon({ state }: { state: SessionState }) {
  const icon = 'h-3 w-3 shrink-0';
  const dot = 'h-2 w-2 shrink-0 rounded-full';
  const label = state.label;
  switch (state.kind) {
    case 'failed':
      return <AlertCircle className={cn(icon, 'text-destructive')} aria-label={label} />;
    case 'starting':
      return <Loader2 className={cn(icon, 'animate-spin text-muted-foreground')} aria-label={label} />;
    case 'working':
      return <Loader2 className={cn(icon, 'animate-spin text-warning')} aria-label={label} />;
    case 'needs_reply':
      return <span className={cn(dot, 'bg-info')} aria-label={label} />;
    case 'pr_attention':
      return <AlertTriangle className={cn(icon, 'text-warning')} aria-label={label} />;
    case 'ready_to_merge':
      return <CircleCheck className={cn(icon, 'text-success')} aria-label={label} />;
    case 'pr_waiting':
      return <span className={cn(dot, 'border-[1.5px] border-success')} aria-label={label} />;
    case 'draft':
      return <span className={cn(dot, 'border-[1.5px] border-muted-foreground/60')} aria-label={label} />;
    case 'merged':
      return <GitMerge className={cn(icon, 'text-merged')} aria-label={label} />;
    case 'closed':
      return <XCircle className={cn(icon, 'text-muted-foreground')} aria-label={label} />;
    case 'unshipped':
      return <span className={cn(dot, 'border-[1.5px] border-muted-foreground/60 border-dashed')} aria-label={label} />;
    case 'idle':
    default:
      return <span className={cn(dot, 'bg-muted-foreground/30')} aria-label={label} />;
  }
}
