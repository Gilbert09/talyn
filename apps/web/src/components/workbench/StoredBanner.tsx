import type { WorkbenchChanges } from '@talyn/shared';
import { timeAgo } from './new/RecentWorkbenches';

function agoText(iso: string): string {
  const ago = timeAgo(iso);
  return ago === 'now' ? 'just now' : `${ago} ago`;
}

/**
 * Says that the list is Talyn's stored copy, from when, and offers the one
 * read that wakes the sandbox. An archived session has no sandbox to wake.
 */
export function StoredBanner({
  changes,
  what,
  onRefresh,
}: {
  changes: Pick<WorkbenchChanges, 'snapshotAt' | 'storedReason' | 'stale'>;
  what: 'changes' | 'files';
  onRefresh: () => void;
}) {
  const archived = changes.storedReason === 'archived';
  return (
    <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="changes-asleep">
      <span className="min-w-0 flex-1">
        {archived ? 'This session is archived.' : 'Sandbox is asleep.'} Showing {what} from {agoText(changes.snapshotAt!)}.
        {changes.stale === 'sandbox_replaced' && ' The session moved to a new sandbox after this copy.'}
      </span>
      {!archived && (
        <button type="button" onClick={onRefresh} className="shrink-0 rounded px-1 underline-offset-2 hover:text-foreground hover:underline">
          Refresh from the sandbox
        </button>
      )}
    </div>
  );
}
