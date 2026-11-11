import { useMemo, useState } from 'react';
import { Archive, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { splitViewOffered, workbenchDisplayName, type SpaceSessionRow, type Workbench, type WorkbenchChat } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { sessionPr, sessionState, spaceSessionState } from '../../lib/sessionState';
import { useBackground } from '../../stores/sessionBackground';
import { liveThreads, runningSessionCount, threadChildren, threadSummary } from '../../lib/threads';
import { newestSessions } from '../../lib/sessionOrder';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useNavigationStore } from '../../stores/navigation';
import { useWorkbenchStore } from '../../stores/workbenches';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu';
import { ArchiveWorkbenchDialog, archiveWorkbench, type ArchiveOptions } from '../workbench/archiveWorkbench';
import { PrPill, SessionStateIcon } from '../workbench/WorkbenchBadges';
import { openNewThread } from '../workbench/new/openNewWorkbench';
import { spacesOffered } from '../../lib/spaces';
import { sessionDragProps } from '../../lib/splitView';
import { useSpacesStore } from '../../stores/spaces';
import { useWorkspaceStore } from '../../stores/workspace';
import { moveToSpace } from '../spaces/MoveToSpace';
import { SessionViewers } from '../spaces/SpaceAvatars';

/** A row of the Threads section: a loaded workbench, or a space row when the workbench is not loaded. */
export interface SidebarThreadItem {
  id: string;
  workbench: Workbench | null;
  row?: SpaceSessionRow | null;
}

export interface SidebarThreadEntry {
  thread: SidebarThreadItem;
  children: SidebarThreadItem[];
}

/**
 * The sidebar's Threads section, above the sessions: each live thread with
 * how many of its sessions run, and its sessions under it. Hidden when the
 * workspace has no thread; "New thread" on the new-session page makes one.
 */
export function SidebarThreadList({ workbenches }: { workbenches: Workbench[] }) {
  const navigate = useNavigationStore((s) => s.navigate);
  const entries = useMemo(
    () =>
      newestSessions(liveThreads(workbenches)).map((thread) => ({
        thread: { id: thread.id, workbench: thread },
        children: newestSessions(threadChildren(workbenches, thread.id)).map((child) => ({ id: child.id, workbench: child })),
      })),
    [workbenches],
  );
  return <SidebarThreadSection entries={entries} onOpen={(id) => navigate({ view: 'workbench', id })} />;
}

/** The Threads section for any list of threads. A space passes `spaceId` to show who has a session open. */
export function SidebarThreadSection({
  entries,
  onOpen,
  spaceId,
}: {
  entries: SidebarThreadEntry[];
  onOpen: (id: string) => void;
  spaceId?: string;
}) {
  const route = useNavigationStore((s) => s.route);
  const chats = useWorkbenchStore((s) => s.chats);
  const [collapsed, setCollapsed] = useState<Record<string, true>>({});
  const openId = route.view === 'workbench' ? route.id : null;

  if (entries.length === 0) return null;

  return (
    <div className="mb-1" role="group" aria-label="Threads" data-attr="sidebar-threads">
      <div className="flex items-center px-3 pb-0.5 pt-1.5">
        <span className="flex-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Threads</span>
        <button
          type="button"
          onClick={openNewThread}
          className="app-region-no-drag rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="New thread"
          title="New thread"
          data-attr="sidebar-new-thread"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {entries.map(({ thread, children }) => {
        const expanded = !collapsed[thread.id];
        const running = runningChildren(children, chats);
        return (
          <div key={thread.id}>
            <ThreadRow
              item={thread}
              summary={threadSummary(running)}
              sessionsRunning={running}
              hasChildren={children.length > 0}
              expanded={expanded}
              selected={thread.id === openId}
              onToggle={() =>
                setCollapsed((cur) => {
                  const next = { ...cur };
                  if (next[thread.id]) delete next[thread.id];
                  else next[thread.id] = true;
                  return next;
                })
              }
              onSelect={() => onOpen(thread.id)}
            />
            {expanded && children.length > 0 && (
              <div id={`thread-children-${thread.id}`} role="group" aria-label={`Sessions of ${itemName(thread)}`}>
                {children.map((child) =>
                  child.workbench ? (
                    <ThreadChildRow
                      key={child.id}
                      session={child.workbench}
                      selected={child.id === openId}
                      spaceId={spaceId}
                      onSelect={() => onOpen(child.id)}
                    />
                  ) : child.row ? (
                    <SpaceThreadChildRow
                      key={child.id}
                      row={child.row}
                      selected={child.id === openId}
                      spaceId={spaceId}
                      onSelect={() => onOpen(child.id)}
                    />
                  ) : null,
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function itemName(item: SidebarThreadItem): string {
  if (item.workbench) return workbenchDisplayName(item.workbench);
  return item.row?.title || item.row?.name || '';
}

function runningChildren(children: SidebarThreadItem[], chats: Record<string, WorkbenchChat[] | undefined>): number {
  const loaded = children.filter((c) => c.workbench);
  return runningSessionCount(loaded, chats) + children.filter((c) => !c.workbench && c.row?.running).length;
}

function ThreadRow({
  item,
  summary,
  sessionsRunning,
  hasChildren,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  item: SidebarThreadItem;
  summary: string;
  sessionsRunning: number;
  hasChildren: boolean;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const thread = item.workbench;
  const chats = useWorkbenchStore((s) => s.chats[item.id]);
  const unread = useWorkbenchStore((s) => s.unread);
  const background = useBackground(item.id);
  const spacesOn = useWorkspaceStore((s) => spacesOffered(s.features));
  const splitOn = useWorkspaceStore((s) => splitViewOffered(s.features));
  const spaceId = thread ? thread.spaceId ?? null : item.row?.spaceId ?? null;
  const own = thread
    ? sessionState(thread, chats ?? [], unread, null, false, background)
    : item.row
      ? spaceSessionState(item.row)
      : { kind: 'idle' as const, label: 'Idle' };
  // A resting thread whose sessions work is working too. Its own reply, question or failure still wins.
  const state = sessionsRunning > 0 && (own.kind === 'idle' || own.kind === 'wakeup')
    ? { kind: 'working' as const, label: sessionsRunning === 1 ? '1 session working' : `${sessionsRunning} sessions working` }
    : own;
  const name = itemName(item);
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const Chevron = expanded ? ChevronDown : ChevronRight;

  const archive = async (opts: ArchiveOptions) => {
    setArchiving(true);
    const ok = await archiveWorkbench(item.id, selected, opts);
    setArchiving(false);
    if (ok) setConfirming(false);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'flex w-full items-center rounded-md text-[13px] transition-colors',
              selected ? 'bg-secondary text-foreground' : 'text-foreground/90 hover:bg-accent/60'
            )}
          >
            <button
              type="button"
              onClick={onSelect}
              data-attr="sidebar-thread-row"
              aria-current={selected ? 'page' : undefined}
              {...sessionDragProps(item.id, splitOn)}
              title={`${state.label}\n${name}`}
              className={cn('app-region-no-drag flex min-w-0 flex-1 items-center gap-2 py-1 pl-3 text-left', hasChildren ? 'pr-1' : 'pr-3')}
            >
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                <SessionStateIcon state={state} />
              </span>
              <span className={cn('min-w-0 flex-1 truncate', state.kind === 'needs_reply' && 'font-semibold')}>{name}</span>
              {summary && (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" data-attr="sidebar-thread-summary">
                  {summary}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={onToggle}
              disabled={!hasChildren}
              aria-expanded={hasChildren ? expanded : undefined}
              aria-controls={hasChildren ? `thread-children-${item.id}` : undefined}
              aria-label={expanded ? `Hide the sessions of ${name}` : `Show the sessions of ${name}`}
              className="app-region-no-drag mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:hidden"
            >
              <Chevron className="h-3 w-3" />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-[10rem]">
          <ContextMenuItem onSelect={onSelect}>Open</ContextMenuItem>
          {spacesOn && thread?.runtime !== 'local' && (
            <ContextMenuItem
              data-attr="sidebar-thread-move-to-space"
              onSelect={() => useSpacesStore.getState().openDialog({ kind: 'move', target: 'session', id: item.id, spaceId })}
            >
              Move to space…
            </ContextMenuItem>
          )}
          {spacesOn && spaceId && (
            <ContextMenuItem onSelect={() => void moveToSpace('session', item.id, spaceId, null)}>Move to Personal</ContextMenuItem>
          )}
          {thread && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => setConfirming(true)}>
                <Archive className="h-3.5 w-3.5" />
                Archive…
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {thread && (
        <ArchiveWorkbenchDialog
          workbench={thread}
          open={confirming}
          busy={archiving}
          onConfirm={(opts) => void archive(opts)}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

function ThreadChildRow({
  session,
  selected,
  spaceId,
  onSelect,
}: {
  session: Workbench;
  selected: boolean;
  spaceId?: string;
  onSelect: () => void;
}) {
  const chats = useWorkbenchStore((s) => s.chats[session.id]);
  const unread = useWorkbenchStore((s) => s.unread);
  const row = usePullRequestStore((s) =>
    session.pullRequestId ? s.rows.find((r) => r.id === session.pullRequestId) : undefined
  );
  const pr = sessionPr(session, row);
  const background = useBackground(session.id);
  const state = sessionState(session, chats ?? [], unread, pr, false, background);
  const repo = session.repoFullName.split('/').pop() || session.repoFullName;
  const splitOn = useWorkspaceStore((s) => splitViewOffered(s.features));
  return (
    <button
      type="button"
      onClick={onSelect}
      data-attr="sidebar-thread-child"
      aria-current={selected ? 'page' : undefined}
      {...sessionDragProps(session.id, splitOn)}
      title={`${state.label}\n${workbenchDisplayName(session)} · ${session.repoFullName} · ${session.branch}`}
      className={cn(
        'app-region-no-drag flex w-full items-center gap-1.5 rounded-md py-0.5 pl-8 pr-3 text-left text-xs transition-colors',
        selected ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
      )}
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="text-foreground/80">{repo}</span>
        <span aria-hidden> · </span>
        <span className="font-mono">{session.branch || workbenchDisplayName(session)}</span>
      </span>
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <SessionStateIcon state={state} />
      </span>
      {pr && <PrPill number={pr.number} state={pr.state} draft={pr.summary.draft} />}
      {spaceId && <SessionViewers spaceId={spaceId} sessionId={session.id} />}
    </button>
  );
}

/** A thread's session that is not loaded here: the space row is all there is. */
function SpaceThreadChildRow({
  row,
  selected,
  spaceId,
  onSelect,
}: {
  row: SpaceSessionRow;
  selected: boolean;
  spaceId?: string;
  onSelect: () => void;
}) {
  const state = spaceSessionState(row);
  const repo = row.repoFullName.split('/').pop() || row.repoFullName;
  const name = row.title || row.name;
  const prState = row.pullRequest?.state === 'merged' || row.pullRequest?.state === 'closed' ? row.pullRequest.state : 'open';
  return (
    <button
      type="button"
      onClick={onSelect}
      data-attr="sidebar-thread-child"
      aria-current={selected ? 'page' : undefined}
      title={`${state.label}\n${name} · ${row.repoFullName} · ${row.branch}`}
      className={cn(
        'app-region-no-drag flex w-full items-center gap-1.5 rounded-md py-0.5 pl-8 pr-3 text-left text-xs transition-colors',
        selected ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
      )}
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="text-foreground/80">{repo}</span>
        <span aria-hidden> · </span>
        <span className="font-mono">{row.branch || name}</span>
      </span>
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <SessionStateIcon state={state} />
      </span>
      {row.pullRequest && <PrPill number={row.pullRequest.number} state={prState} />}
      {spaceId && <SessionViewers spaceId={spaceId} sessionId={row.id} />}
    </button>
  );
}
