import type { Workbench, WorkbenchBackground, WorkbenchChat } from '@talyn/shared';
import { isThread } from './threads';

type Chat = Pick<WorkbenchChat, 'status'> & { queuedMessages?: WorkbenchChat['queuedMessages'] };

/**
 * The live sessions that "Archive all" archives: each one with no open pull
 * request. A merged or closed PR counts as no open PR. It skips threads,
 * sessions that start, move or work now, and sessions whose linked PR state is not
 * known, because an unknown PR can be an open one.
 *
 * `openPrIds` holds the ids of the PRs the app knows are open. `background`
 * holds the jobs and wake-ups of the sessions the app loaded. The server also
 * refuses a session that works now, because this list can be stale.
 */
export function archiveAllCandidates(
  workbenches: Workbench[],
  openPrIds: ReadonlySet<string>,
  chats: Record<string, Chat[] | undefined>,
  background: Record<string, Pick<WorkbenchBackground, 'jobs' | 'wakeups'> | undefined> = {}
): Workbench[] {
  return workbenches.filter((wb) => {
    if (isThread(wb) || wb.status === 'archived' || wb.archivedAt) return false;
    if (wb.status === 'provisioning' || wb.status === 'moving' || wb.sandboxState === 'creating') return false;
    const own = chats[wb.id] ?? wb.chats ?? [];
    if (own.some((c) => c.status === 'running' || (c.queuedMessages?.length ?? 0) > 0)) return false;
    const bg = background[wb.id];
    if (bg?.jobs.some((j) => j.status === 'running') || bg?.wakeups.some((k) => k.status === 'scheduled')) return false;
    if (!wb.pullRequestId) return true;
    if (openPrIds.has(wb.pullRequestId)) return false;
    return wb.pr != null && wb.pr.state !== 'open';
  });
}
