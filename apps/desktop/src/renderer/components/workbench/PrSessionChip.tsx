import type { MouseEvent } from 'react';
import { History, Loader2, SquareTerminal } from 'lucide-react';
import type { WorkbenchChat } from '@talyn/shared';
import type { PRRow } from '../../lib/api';
import { useNavigationStore } from '../../stores/navigation';
import { useWorkbenchStore } from '../../stores/workbenches';

type SessionChatActivity = Pick<WorkbenchChat, 'status'> & { queuedMessages?: readonly unknown[] };

export function sessionWorking(chats: readonly SessionChatActivity[] | undefined): boolean {
  return chats?.some((chat) => chat.status === 'running' || (chat.queuedMessages?.length ?? 0) > 0) ?? false;
}

/** A session as the chip shows it. `archived` comes from a code review's session. */
export type PrSessionChipSession = NonNullable<PRRow['session']> & { archived?: boolean };

/** The session working a pull request. Draws nothing when there is none. */
export function PrSessionChip({
  session,
  onOpened,
  withName = false,
}: {
  session: PrSessionChipSession | null | undefined;
  onOpened?: () => void;
  /** Show the session's name beside the icon. */
  withName?: boolean;
}) {
  const navigate = useNavigationStore((s) => s.navigate);
  const chats = useWorkbenchStore((s) => (session ? s.chats[session.id] : undefined));
  if (!session) return null;
  const working = !session.archived && sessionWorking(chats);
  const label = session.archived
    ? `Open archived session ${session.name}`
    : working
      ? `Session ${session.name} is working. Open it`
      : `Open session ${session.name}`;
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    navigate({ view: 'workbench', id: session.id });
    onOpened?.();
  };
  return (
    <button
      type="button"
      data-attr="pr-session-chip"
      data-archived={session.archived ? 'true' : undefined}
      onClick={open}
      className={
        withName
          ? 'inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground'
          : 'inline-flex shrink-0 items-center rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground'
      }
      title={label}
      aria-label={label}
    >
      {working ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : session.archived ? (
        <History className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <SquareTerminal className="h-3.5 w-3.5 shrink-0" />
      )}
      {withName && (
        <span className="truncate">
          {session.archived ? `${session.name} (archived)` : session.name}
        </span>
      )}
    </button>
  );
}
