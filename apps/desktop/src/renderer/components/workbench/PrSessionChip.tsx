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
      className="inline-flex shrink-0 items-center rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      title={`Open session ${session.name}`}
      aria-label={`Open session ${session.name}`}
    >
      <SquareTerminal className="h-3.5 w-3.5" />
    </button>
  );
}
