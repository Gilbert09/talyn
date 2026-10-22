import { useMemo } from 'react';
import { Archive, Cloud, Laptop } from 'lucide-react';
import { workbenchDisplayName, type Workbench } from '@talyn/shared';
import { useNavigationStore } from '../../../stores/navigation';
import { usePullRequestStore } from '../../../stores/pullRequests';
import { useWorkbenchStore } from '../../../stores/workbenches';
import { SessionStateIcon } from '../WorkbenchBadges';
import { sessionPr, sessionState } from '../../../lib/sessionState';
import { isArchived } from '../workbenchSelectors';

export const RECENT_LIMIT = 8;

/** "3d ago": coarse on purpose, the row's title carries the exact time. */
export function timeAgo(iso: string, now = Date.now()): string {
  const min = Math.floor(Math.max(0, now - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo` : `${Math.floor(days / 365)}y`;
}

/** The newest live workbenches across every repository, and a way to the archived ones. */
export function RecentWorkbenches({ workbenches }: { workbenches: Workbench[] }) {
  const navigate = useNavigationStore((s) => s.navigate);
  const { recent, archived } = useMemo(() => {
    const live = workbenches.filter((w) => !isArchived(w));
    return {
      recent: live.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_LIMIT),
      archived: workbenches.length - live.length,
    };
  }, [workbenches]);

  if (recent.length === 0 && archived === 0) return null;
  return (
    <section aria-label="Recent sessions" className="w-full" data-attr="home-recent">
      <div className="flex items-center justify-between px-2 pb-1">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Recent</h2>
        {archived > 0 && (
          <button
            type="button"
            onClick={() => navigate({ view: 'history' })}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <Archive className="h-3 w-3" /> {archived} archived
          </button>
        )}
      </div>
      {recent.length > 0 && (
        <ul className="divide-y divide-border/60 rounded-lg border border-border bg-card">
          {recent.map((wb) => (
            <li key={wb.id}>
              <RecentRow workbench={wb} onOpen={() => navigate({ view: 'workbench', id: wb.id })} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentRow({ workbench, onOpen }: { workbench: Workbench; onOpen: () => void }) {
  const chats = useWorkbenchStore((s) => s.chats[workbench.id]);
  const unread = useWorkbenchStore((s) => s.unread);
  const pr = usePullRequestStore((s) =>
    workbench.pullRequestId ? s.rows.find((r) => r.id === workbench.pullRequestId) : undefined
  );
  const state = sessionState(workbench, chats ?? [], unread, sessionPr(workbench, pr));
  const RuntimeIcon = workbench.runtime === 'local' ? Laptop : Cloud;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-attr="home-recent-row"
      title={`${state.label}\n${workbenchDisplayName(workbench)} · ${workbench.repoFullName} · ${workbench.branch} · ${new Date(workbench.updatedAt).toLocaleString()}`}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-accent/60"
    >
      <span className="flex h-3 w-3 shrink-0 items-center justify-center">
        <SessionStateIcon state={state} />
      </span>
      <span className="min-w-0 flex-[1_1_30%] truncate font-medium">{workbenchDisplayName(workbench)}</span>
      <span className="min-w-0 flex-[1_1_35%] truncate text-xs text-muted-foreground">{workbench.repoFullName}</span>
      <span className="hidden min-w-0 flex-[1_1_25%] truncate font-mono text-[11px] text-muted-foreground sm:block">
        {workbench.branch}
      </span>
      <RuntimeIcon className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={workbench.runtime === 'local' ? 'Local' : 'Sandbox'} />
      <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{timeAgo(workbench.updatedAt)}</span>
    </button>
  );
}
