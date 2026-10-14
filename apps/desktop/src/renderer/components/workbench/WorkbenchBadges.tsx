import { Loader2 } from 'lucide-react';
import type { WorkbenchChat } from '@talyn/shared';
import { cn } from '../../lib/utils';

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

export type PrDotState = 'open' | 'draft' | 'merged' | 'closed';

export function prDotState(state: string, draft?: boolean): PrDotState {
  if (state === 'merged') return 'merged';
  if (state === 'closed') return 'closed';
  return draft ? 'draft' : 'open';
}

/** The idle dot of a workbench with a PR: its PR state's colour. */
export function PrStateDot({ state }: { state: PrDotState }) {
  return (
    <span
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        state === 'open' && 'bg-success',
        state === 'draft' && 'bg-muted-foreground/50',
        state === 'merged' && 'bg-primary',
        state === 'closed' && 'bg-destructive'
      )}
      aria-label={`Pull request ${state}`}
    />
  );
}

export function PrPill({ number, state, draft }: { number: number; state: string; draft?: boolean }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 font-mono text-[10px] font-medium',
        state === 'merged'
          ? 'bg-primary/15 text-primary'
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
