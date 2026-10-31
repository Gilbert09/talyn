import { MessagesSquare } from 'lucide-react';
import { workbenchDisplayName } from '@talyn/shared';
import { useNavigationStore } from '../../stores/navigation';
import { useWorkbenchStore } from '../../stores/workbenches';

function useThreadName(threadId: string | null | undefined): string | null {
  return useWorkbenchStore((s) => {
    const thread = threadId ? s.workbenches[threadId] : undefined;
    return thread ? workbenchDisplayName(thread) : null;
  });
}

/** Header chip for a session in a thread: the thread's name, and a link to it. */
export function ThreadChip({ threadId }: { threadId: string }) {
  const navigate = useNavigationStore((s) => s.navigate);
  const name = useThreadName(threadId);
  const label = name ?? 'a thread';
  return (
    <button
      type="button"
      onClick={() => navigate({ view: 'workbench', id: threadId })}
      data-attr="session-open-thread"
      title={`Part of ${label}. Open the thread`}
      aria-label={`Open the thread ${label}`}
      className="app-region-no-drag inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <MessagesSquare className="h-3 w-3" />
      <span>Part of</span>
      <span className="max-w-[10rem] truncate text-foreground/70">{label}</span>
    </button>
  );
}

/** The small thread tag on a session row in lists. Renders nothing outside a thread. */
export function ThreadTag({ threadId }: { threadId: string | null | undefined }) {
  const name = useThreadName(threadId);
  if (!threadId || !name) return null;
  return (
    <span
      className="inline-flex max-w-[6rem] shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground"
      title={`Part of the thread ${name}`}
      data-attr="session-thread-tag"
    >
      <MessagesSquare className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  );
}
