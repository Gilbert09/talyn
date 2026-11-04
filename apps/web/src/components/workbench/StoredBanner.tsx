import type { WorkbenchChanges } from '@talyn/shared';
import { timeAgo } from './new/RecentWorkbenches';

function agoText(iso: string): string {
  const ago = timeAgo(iso);
  return ago === 'now' ? 'just now' : `${ago} ago`;
}

export function staleText(stale: WorkbenchChanges['stale']): string | null {
  switch (stale) {
    case 'list_newer':
      return 'This copy is out of date: the session has newer changes.';
    case 'sandbox_replaced':
      return 'This copy is from an earlier sandbox.';
    default:
      return null;
  }
}

/**
 * Says that the list is Talyn's stored copy, from when, and offers the one
 * read that wakes the sandbox. An archived session has no sandbox to wake.
 */
export function StoredBanner({
  changes,
  stale,
  what,
  onRefresh,
}: {
  changes: Pick<WorkbenchChanges, 'snapshotAt' | 'storedReason' | 'stale'>;
  stale?: WorkbenchChanges['stale'];
  what: 'changes' | 'files';
  onRefresh: () => void;
}) {
  const archived = changes.storedReason === 'archived';
  const warning = staleText(stale ?? changes.stale);
  return (
    <div
      className={`flex items-center gap-2 border-b px-3 py-1.5 text-[11px] ${warning ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}
      data-testid="changes-asleep"
    >
      <span className="min-w-0 flex-1">
        {archived ? 'This session is archived.' : 'Sandbox is asleep.'} Showing {what} from {agoText(changes.snapshotAt!)}.
        {warning && ` ${warning}`}
      </span>
      {!archived && (
        <button type="button" onClick={onRefresh} className="shrink-0 rounded px-1 underline-offset-2 hover:text-foreground hover:underline">
          Refresh from the sandbox
        </button>
      )}
    </div>
  );
}
