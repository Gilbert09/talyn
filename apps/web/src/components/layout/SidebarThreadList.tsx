import { useMemo, useState } from 'react';
import { Archive, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { workbenchDisplayName, type Workbench } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { sessionPr, sessionState } from '../../lib/sessionState';
import { liveThreads, runningSessionCount, threadChildren, threadSummary } from '../../lib/threads';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useNavigationStore } from '../../stores/navigation';
import { useWorkbenchStore } from '../../stores/workbenches';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu';
import { ArchiveWorkbenchDialog, archiveWorkbench } from '../workbench/archiveWorkbench';
import { PrPill, SessionStateIcon } from '../workbench/WorkbenchBadges';
import { openNewThread } from '../workbench/new/openNewWorkbench';

/**
 * The sidebar's Threads section, above the sessions: each live thread with
 * how many of its sessions run, and its sessions under it. Hidden when the
 * workspace has no thread; "New thread" on the new-session page makes one.
 */
export function SidebarThreadList({ workbenches }: { workbenches: Workbench[] }) {
  const route = useNavigationStore((s) => s.route);
  const navigate = useNavigationStore((s) => s.navigate);
  const chats = useWorkbenchStore((s) => s.chats);
  const threads = useMemo(() => liveThreads(workbenches), [workbenches]);
  const [collapsed, setCollapsed] = useState<Record<string, true>>({});
  const openId = route.view === 'workbench' ? route.id : null;

  if (threads.length === 0) return null;

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
      {threads.map((thread) => {
        const children = threadChildren(workbenches, thread.id);
        const expanded = !collapsed[thread.id];
        return (
          <div key={thread.id}>
            <ThreadRow
              thread={thread}
              summary={threadSummary(runningSessionCount(children, chats))}
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
              onSelect={() => navigate({ view: 'workbench', id: thread.id })}
            />
            {expanded && children.length > 0 && (
              <div id={`thread-children-${thread.id}`} role="group" aria-label={`Sessions of ${workbenchDisplayName(thread)}`}>
                {children.map((child) => (
                  <ThreadChildRow
                    key={child.id}
                    session={child}
                    selected={child.id === openId}
                    onSelect={() => navigate({ view: 'workbench', id: child.id })}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ThreadRow({
  thread,
  summary,
  hasChildren,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  thread: Workbench;
  summary: string;
  hasChildren: boolean;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const chats = useWorkbenchStore((s) => s.chats[thread.id]);
  const unread = useWorkbenchStore((s) => s.unread);
  const state = sessionState(thread, chats ?? [], unread, null);
  const name = workbenchDisplayName(thread);
  const [confirming, setConfirming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const Chevron = expanded ? ChevronDown : ChevronRight;

  const archive = async () => {
    setArchiving(true);
    const ok = await archiveWorkbench(thread.id, selected);
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
              aria-controls={hasChildren ? `thread-children-${thread.id}` : undefined}
              aria-label={expanded ? `Hide the sessions of ${name}` : `Show the sessions of ${name}`}
              className="app-region-no-drag mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:hidden"
            >
              <Chevron className="h-3 w-3" />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-[10rem]">
          <ContextMenuItem onSelect={onSelect}>Open</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setConfirming(true)}>
            <Archive className="h-3.5 w-3.5" />
            Archive…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <ArchiveWorkbenchDialog
        workbench={thread}
        open={confirming}
        busy={archiving}
        onConfirm={() => void archive()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

function ThreadChildRow({ session, selected, onSelect }: { session: Workbench; selected: boolean; onSelect: () => void }) {
  const chats = useWorkbenchStore((s) => s.chats[session.id]);
  const unread = useWorkbenchStore((s) => s.unread);
  const row = usePullRequestStore((s) =>
    session.pullRequestId ? s.rows.find((r) => r.id === session.pullRequestId) : undefined
  );
  const pr = sessionPr(session, row);
  const state = sessionState(session, chats ?? [], unread, pr);
  const repo = session.repoFullName.split('/').pop() || session.repoFullName;
  return (
    <button
      type="button"
      onClick={onSelect}
      data-attr="sidebar-thread-child"
      aria-current={selected ? 'page' : undefined}
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
    </button>
  );
}
