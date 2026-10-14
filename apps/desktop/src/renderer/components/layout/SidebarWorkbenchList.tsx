import { useMemo } from 'react';
import { Cloud, Laptop } from 'lucide-react';
import type { Workbench } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { formatKeys } from '../../lib/shortcuts';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useWorkbenchStore } from '../../stores/workbenches';
import { useNavigationStore } from '../../stores/navigation';
import { PrStateDot, StatusDot, chatTone, prDotState } from '../workbench/WorkbenchBadges';
import { groupByRepository, isArchived } from '../workbench/workbenchSelectors';

/**
 * The sidebar's workbench list: live workbenches grouped by repository, in
 * the order ⌘1–9 counts. Archived ones live on the History page.
 */
export function SidebarWorkbenchList({ workbenches }: { workbenches: Workbench[] }) {
  const route = useNavigationStore((s) => s.route);
  const navigate = useNavigationStore((s) => s.navigate);
  const openId = route.view === 'workbench' ? route.id : null;
  const groups = useMemo(() => groupByRepository(workbenches.filter((w) => !isArchived(w))), [workbenches]);

  if (groups.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">No workbenches yet.</p>;
  }

  let index = 0;
  return (
    <div className="space-y-1" data-attr="sidebar-workbenches">
      {groups.map((group) => (
        <div key={group.repo} role="group" aria-label={group.repo}>
          <div className="truncate px-3 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">{group.repo}</div>
          {group.items.map((wb) => {
            index += 1;
            return (
              <WorkbenchRow
                key={wb.id}
                workbench={wb}
                shortcut={index <= 9 ? index : null}
                selected={wb.id === openId}
                onSelect={() => navigate({ view: 'workbench', id: wb.id })}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function WorkbenchRow({
  workbench,
  selected,
  shortcut,
  onSelect,
}: {
  workbench: Workbench;
  selected: boolean;
  shortcut: number | null;
  onSelect: () => void;
}) {
  const chats = useWorkbenchStore((s) => s.chats[workbench.id]);
  const unread = useWorkbenchStore((s) => s.unread);
  const pr = usePullRequestStore((s) =>
    workbench.pullRequestId ? s.rows.find((r) => r.id === workbench.pullRequestId) : undefined
  );
  const provisioning = workbench.status === 'provisioning';
  const failed = workbench.status === 'error' || workbench.sandboxState === 'error';
  const tone = failed ? 'error' : provisioning ? 'running' : chatTone(chats ?? [], unread);
  const isUnread = tone === 'unread';
  const suspended = workbench.runtime === 'sandbox' && workbench.sandboxState === 'suspended';
  const RuntimeIcon = workbench.runtime === 'local' ? Laptop : Cloud;
  const runtimeLabel = workbench.runtime === 'local' ? 'Local worktree' : suspended ? 'Sandbox (asleep)' : 'Sandbox';
  const diff = workbench.diffStat && workbench.diffStat.files > 0 ? workbench.diffStat : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      data-attr="sidebar-workbench-row"
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'app-region-no-drag flex w-full items-center gap-2 rounded-md px-3 py-1 text-left text-[13px] transition-colors',
        selected ? 'bg-secondary text-foreground' : 'text-foreground/90 hover:bg-accent/60',
        suspended && !selected && 'opacity-60'
      )}
      title={`${workbench.name} · ${workbench.branch}${shortcut ? ` (${formatKeys(`mod+${shortcut}`)})` : ''}`}
    >
      {tone === 'idle' && pr ? <PrStateDot state={prDotState(pr.state, pr.summary.draft)} /> : <StatusDot tone={tone} />}
      <span className={cn('min-w-0 flex-1 truncate', isUnread ? 'font-semibold' : 'font-normal')}>{workbench.name}</span>
      {diff && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-success">+{diff.added}</span> <span className="text-destructive">−{diff.removed}</span>
        </span>
      )}
      <RuntimeIcon className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={runtimeLabel} />
    </button>
  );
}
