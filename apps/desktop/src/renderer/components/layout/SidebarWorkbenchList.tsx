import { useMemo, useState } from 'react';
import { Archive, Cloud, Copy, ExternalLink, Laptop } from 'lucide-react';
import { workbenchDisplayName, type Workbench } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { openNewWorkbench } from '../workbench/new/openNewWorkbench';
import { openExternal } from '../../lib/openExternal';
import { toast } from '../../stores/toast';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu';
import {
  ArchiveWorkbenchDialog,
  archiveWorkbench,
  archiveWorkbenches,
  type ArchiveOptions,
} from '../workbench/archiveWorkbench';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { archiveAllCandidates } from '../../lib/archiveAll';
import { formatKeys } from '../../lib/shortcuts';
import { usePullRequestStore } from '../../stores/pullRequests';
import { isPrOnlyUnseen, useWorkbenchStore } from '../../stores/workbenches';
import { useNavigationStore } from '../../stores/navigation';
import { SessionStateIcon } from '../workbench/WorkbenchBadges';
import { SlackSessionMark } from '../workbench/SlackThreadChip';
import { ThreadTag } from '../threads/ThreadChip';
import { slackSourceOf } from '../../lib/slackSession';
import { sessionPr, sessionState } from '../../lib/sessionState';
import { groupByRepository, isArchived } from '../workbench/workbenchSelectors';
import { useRenameSession } from '../workbench/useRenameSession';
import { useWorkspaceStore } from '../../stores/workspace';
import { useSpacesStore } from '../../stores/spaces';
import { spacesOffered } from '../../lib/spaces';

/**
 * The sidebar's workbench list: live sessions grouped by repository, in the
 * order ⌘1–9 counts. Archived ones live on the History page. Threads have
 * their own section; a session in a thread carries a small thread tag.
 */
export function SidebarWorkbenchList({ workbenches }: { workbenches: Workbench[] }) {
  const route = useNavigationStore((s) => s.route);
  const navigate = useNavigationStore((s) => s.navigate);
  const openId = route.view === 'workbench' ? route.id : null;
  const groups = useMemo(() => groupByRepository(workbenches.filter((w) => !isArchived(w))), [workbenches]);
  const rows = usePullRequestStore((s) => s.rows);
  const chats = useWorkbenchStore((s) => s.chats);
  const candidates = useMemo(
    () => archiveAllCandidates(groups.flatMap((g) => g.items), new Set(rows.map((r) => r.id)), chats),
    [groups, rows, chats]
  );
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [archivingAll, setArchivingAll] = useState(false);

  const archiveAll = async () => {
    setArchivingAll(true);
    await archiveWorkbenches(candidates.map((w) => w.id), openId);
    setArchivingAll(false);
    setConfirmingAll(false);
  };

  if (groups.length === 0) {
    return (
      <div className="space-y-2 px-3 py-2 text-xs text-muted-foreground">
        <p>No sessions yet.</p>
        <Button variant="outline" size="sm" onClick={() => openNewWorkbench()}>
          Start a session
        </Button>
      </div>
    );
  }

  let index = 0;
  return (
    <div className="space-y-1" data-attr="sidebar-workbenches">
      <div className="flex items-center px-3 pt-1.5">
        <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Sessions</span>
        <button
          type="button"
          onClick={() => setConfirmingAll(true)}
          disabled={candidates.length === 0}
          className="app-region-no-drag rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          aria-label="Archive all sessions without an open pull request"
          title={
            candidates.length === 0
              ? 'No session to archive: each one has an open pull request or works now'
              : `Archive all sessions without an open pull request (${candidates.length})`
          }
          data-attr="sidebar-archive-all"
        >
          <Archive className="h-3.5 w-3.5" />
        </button>
      </div>
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
      <ConfirmDialog
        open={confirmingAll}
        title={`Archive ${candidates.length} ${candidates.length === 1 ? 'session' : 'sessions'}?`}
        description={
          <>
            <span className="block">
              Talyn archives each session without an open pull request: no PR, or a merged or closed one. Sessions that
              work now stay.
            </span>
            <span className="mt-2 block">
              They move to History. Their branches, chats and PRs stay, and you can restore them later. A local worktree
              with uncommitted changes stays on disk.
            </span>
          </>
        }
        confirmLabel="Archive all"
        busy={archivingAll}
        confirmDisabled={candidates.length === 0}
        onConfirm={() => void archiveAll()}
        onCancel={() => setConfirmingAll(false)}
      />
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
  const prOnlyUnseen = useWorkbenchStore((s) => isPrOnlyUnseen(s.unseen[workbench.id]));
  const pr = usePullRequestStore((s) =>
    workbench.pullRequestId ? s.rows.find((r) => r.id === workbench.pullRequestId) : undefined
  );
  const pullRequest = sessionPr(workbench, pr);
  const state = sessionState(workbench, chats ?? [], unread, pullRequest, prOnlyUnseen);
  const isUnread = state.kind === 'needs_reply' || state.kind === 'pr_opened';
  const done = pullRequest?.state === 'merged' || pullRequest?.state === 'closed';
  const RuntimeIcon = workbench.runtime === 'local' ? Laptop : Cloud;
  const runtimeLabel = workbench.runtime === 'local' ? 'Local worktree' : 'Sandbox';
  const stats = workbench.uncommittedStats === undefined ? workbench.diffStat : workbench.uncommittedStats;
  const diff = stats && stats.files > 0 ? stats : null;

  const prUrl = pr?.summary.url ?? workbench.pr?.url;
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const rename = useRenameSession(workbench);
  const spacesOn = useWorkspaceStore((s) => spacesOffered(s.features));

  const copyBranch = () => {
    navigator.clipboard.writeText(workbench.branch).catch(() => toast.error('Could not copy to clipboard'));
  };
  const copySessionId = () => {
    navigator.clipboard.writeText(workbench.id).catch(() => toast.error('Could not copy to clipboard'));
  };

  const archive = async (opts: ArchiveOptions) => {
    setArchiving(true);
    const ok = await archiveWorkbench(workbench.id, selected, opts);
    setArchiving(false);
    if (ok) setConfirming(false);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              if (!rename.editing) onSelect();
            }}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                onSelect();
              }
            }}
            data-attr="sidebar-workbench-row"
            aria-current={selected ? 'page' : undefined}
            className={cn(
              'app-region-no-drag flex w-full items-center gap-2 rounded-md px-3 py-1 text-left text-[13px] transition-colors',
              selected ? 'bg-secondary text-foreground' : 'text-foreground/90 hover:bg-accent/60'
            )}
            title={`${state.label}\n${workbenchDisplayName(workbench)} · ${workbench.branch}${shortcut ? ` (${formatKeys(`mod+${shortcut}`)})` : ''}`}
          >
            {/* Only the name dims for a finished session: the state mark keeps its full colour. */}
            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              <SessionStateIcon state={state} />
            </span>
            {rename.editing ? rename.input : (
              <span className={cn(
                'min-w-[5rem] flex-1 truncate',
                isUnread ? 'font-semibold' : 'font-normal',
                done && !selected && 'opacity-60'
              )}>{workbenchDisplayName(workbench)}</span>
            )}
            {diff && !done && (
              // All or nothing: when the counts do not fit, they wrap to a hidden second line.
              <span
                className="flex h-4 min-w-0 shrink flex-wrap justify-end overflow-hidden font-mono text-[11px] leading-4 tabular-nums"
                title={`+${diff.added} −${diff.removed}`}
              >
                <span className="w-0" aria-hidden />
                <span className="whitespace-nowrap">
                  <span className="text-success">+{compactCount(diff.added)}</span> <span className="text-destructive">−{compactCount(diff.removed)}</span>
                </span>
              </span>
            )}
            <ThreadTag threadId={workbench.threadId} />
            <SlackSessionMark source={slackSourceOf(workbench)} />
            <RuntimeIcon
              className={cn('h-3 w-3 shrink-0 text-muted-foreground', done && !selected && 'opacity-60')}
              aria-label={runtimeLabel}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-[10rem]">
          <ContextMenuItem onSelect={onSelect}>Open</ContextMenuItem>
          <ContextMenuItem onSelect={() => setTimeout(rename.start, 0)}>Rename</ContextMenuItem>
          {workbench.branch && (
            <ContextMenuItem onSelect={copyBranch}>
              <Copy className="h-3.5 w-3.5" />
              Copy branch name
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={copySessionId}>
            <Copy className="h-3.5 w-3.5" />
            Copy session ID
          </ContextMenuItem>
          {prUrl && (
            <ContextMenuItem onSelect={() => void openExternal(prUrl)}>
              <ExternalLink className="h-3.5 w-3.5" />
              Open pull request
            </ContextMenuItem>
          )}
          {spacesOn && workbench.runtime !== 'local' && (
            <ContextMenuItem
              data-attr="sidebar-move-to-space"
              onSelect={() =>
                useSpacesStore
                  .getState()
                  .openDialog({ kind: 'move', target: 'session', id: workbench.id, spaceId: workbench.spaceId ?? null })
              }
            >
              Move to space…
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
        onConfirm={(opts) => void archive(opts)}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

/** 1150 → "1.1k" (rounded down): a sidebar row has no room for long numbers. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${(Math.floor(n / 100_000) / 10).toFixed(1).replace(/\.0$/, '')}m`;
}
