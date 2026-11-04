import type { MouseEvent } from 'react';
import { Loader2, SquareTerminal } from 'lucide-react';
import type { WorkbenchChat } from '@talyn/shared';
import type { PRRow } from '../../../lib/api';
import { navigateToWorkbench } from '../../../lib/workbenchNavigation';
import { useWorkbenchStore } from '../../../stores/workbenches';

type SessionChatActivity = Pick<WorkbenchChat, 'status'> & { queuedMessages?: readonly unknown[] };

export function sessionWorking(chats: readonly SessionChatActivity[] | undefined): boolean {
  return chats?.some((chat) => chat.status === 'running' || (chat.queuedMessages?.length ?? 0) > 0) ?? false;
}

/** The session working a pull request. Draws nothing when there is none. */
export function PrSessionChip({
  session,
  onOpened,
}: {
  session: PRRow['session'];
  onOpened?: () => void;
}) {
  const chats = useWorkbenchStore((s) => (session ? s.chats[session.id] : undefined));
  if (!session) return null;
  const working = sessionWorking(chats);
  const label = working ? `Session ${session.name} is working. Open it` : `Open session ${session.name}`;
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    navigateToWorkbench(session.id);
    onOpened?.();
  };
  return (
    <button
      type="button"
      data-attr="pr-session-chip"
      onClick={open}
      className="inline-flex shrink-0 items-center rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      title={label}
      aria-label={label}
    >
      {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SquareTerminal className="h-3.5 w-3.5" />}
    </button>
  );
}
