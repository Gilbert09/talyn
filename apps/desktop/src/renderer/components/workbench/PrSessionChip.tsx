import type { MouseEvent } from 'react';
import { SquareTerminal } from 'lucide-react';
import type { PRRow } from '../../lib/api';
import { useNavigationStore } from '../../stores/navigation';

/** The session working a pull request. Draws nothing when there is none. */
export function PrSessionChip({
  session,
  onOpened,
}: {
  session: PRRow['session'];
  onOpened?: () => void;
}) {
  const navigate = useNavigationStore((s) => s.navigate);
  if (!session) return null;
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    navigate({ view: 'workbench', id: session.id });
    onOpened?.();
  };
  return (
    <button
      type="button"
      data-attr="pr-session-chip"
      onClick={open}
      className="inline-flex max-w-[10rem] items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
      title={`Open session ${session.name}`}
    >
      <SquareTerminal className="h-3 w-3 shrink-0" />
      <span className="truncate">Session</span>
    </button>
  );
}
