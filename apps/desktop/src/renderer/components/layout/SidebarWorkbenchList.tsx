import { useMemo, useState, type ReactNode } from 'react';
import { Archive, ChevronDown, ChevronRight, Cloud, Columns2, Copy, ExternalLink, Laptop, Timer } from 'lucide-react';
import { splitViewOffered, workbenchDisplayName, type Workbench } from '@talyn/shared';
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
import { sessionPr, sessionState, type SessionState } from '../../lib/sessionState';
import {
  groupSidebarWorkbenches,
  isArchived,
  sessionGroupKey,
  sidebarSessionStates,
  visibleGroupItems,
  type RepoGroup,
  type SidebarItem,
} from '../workbench/workbenchSelectors';
import { useRenameSession } from '../workbench/useRenameSession';
import { useWorkspaceStore } from '../../stores/workspace';
import { useSpacesStore } from '../../stores/spaces';
import { spacesOffered } from '../../lib/spaces';
import { moveToSpace } from '../spaces/MoveToSpace';
import { isActiveBackground } from '../../lib/sessionBackground';
import { useBackground, useSessionBackgroundStore } from '../../stores/sessionBackground';
import { useSplitViewStore } from '../../stores/splitView';
import { openInSplitView } from '../../lib/splitView';

/**
 * The sidebar's workbench list: live sessions grouped by repository, in the
 * order ⌘1–9 counts. Archived ones live on the History page. Threads have
 * their own section; a session in a thread carries a small thread tag.
 */
export function SidebarWorkbenchList({ workbenches }: { workbenches: Workbench[] }) {
  const route = useNavigationStore((s) => s.route);
  const navigate = useNavigationStore((s) => s.navigate);
  const openId = route.view === 'workbench' ? route.id : null;
  // In split view a row adds its session as a pane, and the rows in panes read as open.
  const inSplit = route.view === 'split';
  const splitPanes = useSplitViewStore((s) => s.panes);
  const addPane = useSplitViewStore((s) => s.addPane);
  const sidebarOrder = useWorkspaceStore((s) => s.sidebarOrder);
  const rows = usePullRequestStore((s) => s.rows);
  const chats = useWorkbenchStore((s) => s.chats);
  const unread = useWorkbenchStore((s) => s.unread);
  const unseen = useWorkbenchStore((s) => s.unseen);
  const backgrounds = useSessionBackgroundStore((s) => s.byWorkbench);
  const live = useMemo(() => workbenches.filter((workbench) => !isArchived(workbench)), [workbenches]);
  const { activeIds, states } = useMemo(
    () => sidebarSessionStates(live, { prRows: rows, chats, unread, unseen, backgrounds }),
    [live, rows, chats, unread, unseen, backgrounds],
  );
  const groups = useMemo(
    () => groupSidebarWorkbenches(live, activeIds, sidebarOrder === 'active_first'),
    [live, activeIds, sidebarOrder],
  );

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

  return (
    <div className="space-y-1" data-attr="sidebar-workbenches">
      <SessionsHeader workbenches={live} openId={openId} />
      <SidebarSessionGroups
        groups={groups}
        states={states}
        openId={openId}
        renderItem={(wb, shortcut) => (
          <WorkbenchRow
            key={wb.id}
            workbench={wb}
            shortcut={shortcut}
            selected={inSplit ? splitPanes.includes(wb.id) : wb.id === openId}
            onSelect={() => (inSplit ? addPane(wb.id, 'sidebar') : navigate({ view: 'workbench', id: wb.id }))}
          />
        )}
      />
    </div>
  );
}

/**
 * The "Sessions" header with archive-all. It archives only the sessions it is
 * given, so a space passes my own sessions and never a teammate's.
 */
export function SessionsHeader({ workbenches, openId }: { workbenches: Workbench[]; openId: string | null }) {
  const rows = usePullRequestStore((s) => s.rows);
  const chats = useWorkbenchStore((s) => s.chats);
  const candidates = useMemo(
    () => archiveAllCandidates(workbenches, new Set(rows.map((r) => r.id)), chats),
    [workbenches, rows, chats]
  );
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [archivingAll, setArchivingAll] = useState(false);

  const archiveAll = async () => {
    setArchivingAll(true);
    await archiveWorkbenches(candidates.map((w) => w.id), openId);
    setArchivingAll(false);
    setConfirmingAll(false);
  };

  return (
    <>
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
    </>
  );
}

/**
 * Session groups with collapsible headers, numbered in the order ⌘1–9
 * counts. A space passes `keyPrefix` so its collapsed groups are its own.
 */
export function SidebarSessionGroups<T extends SidebarItem>({
  groups,
  states,
  openId,
  keyPrefix = '',
  renderItem,
}: {
  groups: RepoGroup<T>[];
  states: ReadonlyMap<string, SessionState>;
  openId: string | null;
  keyPrefix?: string;
  renderItem: (item: T, shortcut: number | null) => ReactNode;
}) {
  const collapsed = useWorkspaceStore((s) => s.collapsedSessionGroups);
  const toggleGroup = useWorkspaceStore((s) => s.toggleSessionGroup);
  let index = 0;
  return (
    <>
      {groups.map((group) => {
        const key = sessionGroupKey(group, keyPrefix);
        const items = visibleGroupItems(group, collapsed, openId, keyPrefix);
        return (
          <div key={key} role="group" aria-label={group.repo}>
            <GroupHeader
              group={group}
              groupKey={key}
              expanded={!collapsed[key]}
              hidden={group.items.filter((wb) => !items.includes(wb))}
              states={states}
              onToggle={() => toggleGroup(key)}
            />
            <div id={`sidebar-group-${key}`}>
              {items.map((item) => {
                index += 1;
                return renderItem(item, index <= 9 ? index : null);
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** A group's name. Click it to hide or show the group's sessions. */
function GroupHeader({
  group,
  groupKey,
  expanded,
  hidden,
  states,
  onToggle,
}: {
  group: Pick<RepoGroup<SidebarItem>, 'repo'>;
  groupKey: string;
  expanded: boolean;
  hidden: { id: string }[];
  states: ReadonlyMap<string, SessionState>;
  onToggle: () => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  // A collapsed group must not hide a reply: its name goes bold, as an unread row does.
  const unreadHidden = hidden.filter((wb) => {
    const kind = states.get(wb.id)?.kind;
    return kind === 'needs_reply' || kind === 'pr_opened';
  }).length;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-controls={`sidebar-group-${groupKey}`}
      title={expanded ? `Hide the sessions of ${group.repo}` : `Show the sessions of ${group.repo}`}
      data-attr="sidebar-group-toggle"
      className={cn(
        'app-region-no-drag group/header flex w-full items-center gap-1 rounded px-3 pb-0.5 pt-1.5 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground',
        unreadHidden > 0 && 'font-semibold text-foreground'
      )}
    >
      <span className="min-w-0 truncate">{group.repo}</span>
      <Chevron
        className={cn('h-3 w-3 shrink-0', expanded && 'opacity-0 group-hover/header:opacity-100 group-focus-visible/header:opacity-100')}
        aria-hidden
      />
      {hidden.length > 0 && (
        <span className="ml-auto shrink-0 tabular-nums" data-attr="sidebar-group-hidden-count">
          {hidden.length}
        </span>
      )}
    </button>
  );
}

/** A session row with its live state and the owner's menu. A space adds the creator and who has it open (`trailing`). */
export function WorkbenchRow({
  workbench,
  selected,
  shortcut,
  onSelect,
  trailing,
}: {
  workbench: Workbench;
  selected: boolean;
  shortcut: number | null;
  onSelect: () => void;
  trailing?: ReactNode;
}) {
  const chats = useWorkbenchStore((s) => s.chats[workbench.id]);
  const unread = useWorkbenchStore((s) => s.unread);
  const prOnlyUnseen = useWorkbenchStore((s) => isPrOnlyUnseen(s.unseen[workbench.id]));
  const pr = usePullRequestStore((s) =>
    workbench.pullRequestId ? s.rows.find((r) => r.id === workbench.pullRequestId) : undefined
  );
  const pullRequest = sessionPr(workbench, pr);
  const background = useBackground(workbench.id);
  const state = sessionState(workbench, chats ?? [], unread, pullRequest, prOnlyUnseen, background);
  const isUnread = state.kind === 'needs_reply' || state.kind === 'pr_opened';
  const done = pullRequest?.state === 'merged' || pullRequest?.state === 'closed';
  const RuntimeIcon = workbench.runtime === 'local' ? Laptop : Cloud;
  const runtimeLabel = workbench.runtime === 'local' ? 'Local worktree' : 'Sandbox';
  const stats = workbench.uncommittedStats === undefined ? workbench.diffStat : workbench.uncommittedStats;
  const diff = stats && stats.files > 0 ? stats : null;
  const runningJob = background?.jobs.some((job) => job.status === 'running');
  const backgroundTitle = runningJob ? 'Background job running' : 'Wake-up scheduled';
  // The state icon already shows the job or wake-up when nothing more urgent wins.
  const showBackgroundMark = isActiveBackground(background) && state.kind !== 'background_job' && state.kind !== 'wakeup' && state.kind !== 'waiting_ci';

  const prUrl = pr?.summary.url ?? workbench.pr?.url;
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const rename = useRenameSession(workbench);
  const spacesOn = useWorkspaceStore((s) => spacesOffered(s.features));
  const splitOn = useWorkspaceStore((s) => splitViewOffered(s.features));

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
            onClick={(event) => {
              if (rename.editing) return;
              // ⌘- or Ctrl-click opens the session beside the others in split view.
              if (splitOn && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                openInSplitView(workbench.id, 'sidebar_modifier_click');
                return;
              }
              onSelect();
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
            {showBackgroundMark && <span title={backgroundTitle} aria-label={backgroundTitle}><Timer className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', runningJob && 'text-emerald-500')} aria-hidden /></span>}
            <SlackSessionMark source={slackSourceOf(workbench)} />
            <RuntimeIcon
              className={cn('h-3 w-3 shrink-0 text-muted-foreground', done && !selected && 'opacity-60')}
              aria-label={runtimeLabel}
            />
            {trailing}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-[10rem]">
          <ContextMenuItem onSelect={onSelect}>Open</ContextMenuItem>
          {splitOn && (
            <ContextMenuItem data-attr="sidebar-open-in-split-view" onSelect={() => openInSplitView(workbench.id, 'sidebar_menu')}>
              <Columns2 className="h-3.5 w-3.5" />
              Open in split view
            </ContextMenuItem>
          )}
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
          {spacesOn && workbench.spaceId && (
            <ContextMenuItem
              data-attr="sidebar-move-to-personal"
              onSelect={() => void moveToSpace('session', workbench.id, workbench.spaceId ?? null, null)}
            >
              Move to Personal
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
