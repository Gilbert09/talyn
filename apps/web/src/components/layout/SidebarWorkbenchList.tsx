import { useMemo, useState } from 'react';
import { Archive, Copy, ExternalLink } from 'lucide-react';
import { workbenchDisplayName, type Workbench } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { openExternal } from '../../lib/openExternal';
import { toast } from '../../stores/toast';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu';
import { ArchiveWorkbenchDialog, archiveWorkbench } from '../workbench/archiveWorkbench';
import { formatKeys } from '../../lib/shortcuts';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useWorkbenchStore } from '../../stores/workbenches';
import { useNavigationStore } from '../../stores/navigation';
import { SessionStateIcon } from '../workbench/WorkbenchBadges';
import { sessionPr, sessionState } from '../../lib/sessionState';
import { groupByRepository, isArchived } from '../workbench/workbenchSelectors';

export function SidebarWorkbenchList({ workbenches }: { workbenches: Workbench[] }) {
  const route = useNavigationStore((s) => s.route);
  const navigate = useNavigationStore((s) => s.navigate);
  const openId = route.view === 'workbench' ? route.id : null;
  const groups = useMemo(() => groupByRepository(workbenches.filter((w) => !isArchived(w))), [workbenches]);

  if (groups.length === 0) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">No sessions yet.</p>;
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
  const pullRequest = sessionPr(workbench, pr);
  const state = sessionState(workbench, chats ?? [], unread, pullRequest);
  const isUnread = state.kind === 'needs_reply';
  const done = pullRequest?.state === 'merged' || pullRequest?.state === 'closed';
  const suspended = workbench.runtime === 'sandbox' && workbench.sandboxState === 'suspended';
  const stats = workbench.uncommittedStats === undefined ? workbench.diffStat : workbench.uncommittedStats;
  const diff = stats && stats.files > 0 ? stats : null;

  const prUrl = pr?.summary.url ?? workbench.pr?.url;
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const copyBranch = () => {
    navigator.clipboard.writeText(workbench.branch).catch(() => toast.error('Could not copy to clipboard'));
  };

  const archive = async () => {
    setArchiving(true);
    const ok = await archiveWorkbench(workbench.id, selected);
    setArchiving(false);
    if (ok) setConfirming(false);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={onSelect}
            data-attr="sidebar-workbench-row"
            aria-current={selected ? 'page' : undefined}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-3 py-1 text-left text-[13px] transition-colors',
              selected ? 'bg-secondary text-foreground' : 'text-foreground/90 hover:bg-accent/60'
            )}
            title={`${state.label}\n${workbenchDisplayName(workbench)} · ${workbench.branch}${shortcut ? ` (${formatKeys(`mod+alt+${shortcut}`)})` : ''}`}
          >
            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              <SessionStateIcon state={state} />
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                isUnread ? 'font-semibold' : 'font-normal',
                (suspended || done) && !selected && 'opacity-60'
              )}
            >
              {workbenchDisplayName(workbench)}
            </span>
            {diff && !done && (
              <span className="shrink-0 font-mono text-[11px] tabular-nums">
                <span className="text-success">+{diff.added}</span>{' '}
                <span className="text-destructive">−{diff.removed}</span>
              </span>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-[10rem]">
          <ContextMenuItem onSelect={onSelect}>Open</ContextMenuItem>
          {workbench.branch && (
            <ContextMenuItem onSelect={copyBranch}>
              <Copy className="h-3.5 w-3.5" />
              Copy branch name
            </ContextMenuItem>
          )}
          {prUrl && (
            <ContextMenuItem onSelect={() => void openExternal(prUrl)}>
              <ExternalLink className="h-3.5 w-3.5" />
              Open pull request
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setConfirming(true)}>
            <Archive className="h-3.5 w-3.5" />
            Archive…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <ArchiveWorkbenchDialog
        workbench={workbench}
        open={confirming}
        busy={archiving}
        onConfirm={() => void archive()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
