import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Columns2, Loader2, Maximize2, Plus, X } from 'lucide-react';
import {
  MAX_SPLIT_PANES,
  splitDropPosition,
  splitGridShape,
  workbenchDisplayName,
  type SplitDropPosition,
  type Workbench,
} from '@talyn/shared';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { loadWorkbench } from '../../lib/workbenchData';
import { clientAttentionKey, useAttentionSeen } from '../../lib/contextRail';
import { sessionPr, sessionState } from '../../lib/sessionState';
import { loadExtraWorkbench, spacesOffered } from '../../lib/spaces';
import { carriesSession, draggingSession, droppedSession, sessionDragProps } from '../../lib/splitView';
import { useWorkbenchBackgroundLoad } from '../../hooks/useSessionBackground';
import { useNavigationStore } from '../../stores/navigation';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useBackground } from '../../stores/sessionBackground';
import { useSpacesStore } from '../../stores/spaces';
import { useSplitViewStore } from '../../stores/splitView';
import { isPrOnlyUnseen, useWorkbenchStore } from '../../stores/workbenches';
import { useWorkspaceStore } from '../../stores/workspace';
import { PRDetailSheet } from '../widgets/PRDetailSheet';
import { PrPill, SessionStateIcon } from './WorkbenchBadges';
import { Banner, ChatView, StatusBanner } from './WorkbenchView';
import { getDeviceId } from '../../lib/workbenchBridge';
import { isArchived, useLiveThreads, useOrderedLiveWorkbenches, useSelectedChat, useWorkbenchOps, useWorkbenchPr } from './workbenchSelectors';

/**
 * Split view: several sessions side by side. Each pane is the session's
 * transcript and composer, and little else — the diff, the files and the
 * terminal stay on the session's own page, one click away.
 */
export function SplitView() {
  const panes = useSplitViewStore((s) => s.panes);
  const focusedId = useSplitViewStore((s) => s.focusedId);
  const prunePanes = useSplitViewStore((s) => s.prunePanes);
  const workbenches = useWorkbenchStore((s) => s.workbenches);
  const listLoaded = useWorkbenchStore((s) => s.listLoaded);
  const prDetailId = useWorkbenchStore((s) => s.prDetailId);
  const openPrDetail = useWorkbenchStore((s) => s.openPrDetail);
  const { columns, rows } = splitGridShape(panes.length);

  // An archived session cannot be prompted: its pane closes.
  useEffect(() => {
    if (!listLoaded) return;
    prunePanes((id) => {
      const workbench = workbenches[id];
      return !workbench || !isArchived(workbench);
    });
  }, [listLoaded, workbenches, prunePanes]);

  useEffect(() => () => openPrDetail(null), [openPrDetail]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-attr="split-view">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <Columns2 className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h1 className="text-sm font-medium">Split view</h1>
        {panes.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {panes.length} of {MAX_SPLIT_PANES}
          </span>
        )}
        <div className="ml-auto">
          <AddSessionMenu />
        </div>
      </div>
      {panes.length === 0 ? (
        <EmptySplitView />
      ) : (
        <div
          className="grid min-h-0 flex-1 gap-px bg-border"
          style={{
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          }}
          data-attr="split-view-grid"
        >
          {panes.map((id, index) => (
            <SplitPane key={id} id={id} index={index} count={panes.length} focused={id === focusedId} />
          ))}
        </div>
      )}
      <PRDetailSheet pullRequestId={prDetailId} onClose={() => openPrDetail(null)} layout="overlay" />
    </div>
  );
}

function SplitPane({ id, index, count, focused }: { id: string; index: number; count: number; focused: boolean }) {
  const workbench = useWorkbenchStore((s) => s.workbenches[id]);
  const listLoaded = useWorkbenchStore((s) => s.listLoaded);
  const spacesOn = useWorkspaceStore((s) => spacesOffered(s.features));
  const extraLoad = useSpacesStore((s) => s.extraLoads[id]);
  const focusPane = useSplitViewStore((s) => s.focusPane);
  const { drop, dropProps } = usePaneDrop(id);

  // A teammate's session is not in my list: fetch it, as the session page does.
  useEffect(() => {
    if (!workbench && listLoaded && spacesOn && !extraLoad) void loadExtraWorkbench(id);
  }, [workbench, listLoaded, spacesOn, extraLoad, id]);

  return (
    <section
      className="relative flex min-h-0 min-w-0 flex-col bg-background"
      onMouseDownCapture={() => focusPane(id)}
      onFocusCapture={() => focusPane(id)}
      aria-label={workbench ? workbenchDisplayName(workbench) : 'Session'}
      data-attr="split-view-pane"
      data-focused={focused ? 'true' : undefined}
      {...dropProps}
    >
      {/* Over the pane's own backgrounds, so the focused pane reads at a glance. */}
      {focused && count > 1 && (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-10 ring-1 ring-inset ring-primary/50" />
      )}
      {drop && <PaneDropOverlay drop={drop} />}
      {workbench ? (
        <SessionPane workbench={workbench} index={index} count={count} focused={focused} />
      ) : (
        <MissingPane id={id} loading={!listLoaded || extraLoad === 'loading'} />
      )}
    </section>
  );
}

interface PaneDrop {
  position: SplitDropPosition;
  /** The dragged session already has a pane: the drop moves it. */
  moving: boolean;
}

/**
 * Makes a pane a drop target for a session dragged from the sidebar or from
 * another pane's header. The middle of the pane replaces its session (or swaps
 * two panes); the outer edges add the session beside it while there is room.
 */
function usePaneDrop(id: string) {
  const panes = useSplitViewStore((s) => s.panes);
  const placePane = useSplitViewStore((s) => s.placePane);
  const [drop, setDrop] = useState<PaneDrop | null>(null);

  // A drag that ends anywhere else (or is cancelled) clears the highlight.
  useEffect(() => {
    if (!drop) return;
    const clear = () => setDrop(null);
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
    };
  }, [drop]);

  const dropFor = (event: DragEvent<HTMLElement>): PaneDrop | null => {
    if (!carriesSession(event)) return null;
    const dragged = draggingSession();
    if (dragged === id) return null;
    const moving = dragged !== null && panes.includes(dragged);
    const rect = event.currentTarget.getBoundingClientRect();
    const position = splitDropPosition(event.clientX - rect.left, rect.width, moving || panes.length < MAX_SPLIT_PANES);
    return { position, moving };
  };

  const dropProps = {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      const next = dropFor(event);
      if (!next) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setDrop((current) => (current?.position === next.position && current.moving === next.moving ? current : next));
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const next = dropFor(event);
      setDrop(null);
      if (!next) return;
      event.preventDefault();
      const dropped = droppedSession(event);
      if (dropped) placePane(dropped, id, next.position, 'split_view_drag');
    },
  };

  return { drop, dropProps };
}

function PaneDropOverlay({ drop }: { drop: PaneDrop }) {
  const label =
    drop.position === 'replace' ? (drop.moving ? 'Swap panes' : 'Show here') : drop.moving ? 'Move here' : 'Add beside';
  return (
    <div
      aria-hidden
      data-attr="split-view-drop-target"
      data-position={drop.position}
      className={cn(
        'pointer-events-none absolute inset-y-0 z-20 flex items-center justify-center border-2 border-dashed border-primary/60 bg-primary/10 text-xs font-medium text-primary',
        drop.position === 'replace' && 'inset-x-0',
        drop.position === 'before' && 'left-0 w-1/2',
        drop.position === 'after' && 'right-0 w-1/2',
      )}
    >
      <span className="rounded bg-background/90 px-2 py-1 shadow-sm">{label}</span>
    </div>
  );
}

function SessionPane({
  workbench,
  index,
  count,
  focused,
}: {
  workbench: Workbench;
  index: number;
  count: number;
  focused: boolean;
}) {
  useWorkbenchBackgroundLoad(workbench.id);
  const workbenchOps = useWorkbenchOps(workbench);
  // A local session on another device is moved from its own page, which can pick the checkout folder.
  const foreign = workbench.runtime === 'local' && Boolean(workbench.deviceId) && workbench.deviceId !== getDeviceId();
  const ops = useMemo(
    () => (foreign ? { ...workbenchOps, unavailable: FOREIGN_REASON } : workbenchOps),
    [foreign, workbenchOps],
  );
  const chat = useSelectedChat(workbench.id);
  const pr = useWorkbenchPr(workbench);
  const storeChats = useWorkbenchStore((s) => s.chats[workbench.id]);
  useAttentionSeen(
    workbench.id,
    clientAttentionKey(workbench, storeChats ?? workbench.chats ?? [], sessionPr(workbench, pr)),
  );

  // A fresh read on open, as the session page does. It never wakes the sandbox.
  useEffect(() => {
    void loadWorkbench(workbench.id);
  }, [workbench.id]);

  return (
    <>
      <PaneHeader workbench={workbench} index={index} count={count} focused={focused} />
      {foreign ? (
        <Banner tone="muted" icon={<AlertTriangle className="h-3.5 w-3.5" />} text={FOREIGN_REASON} />
      ) : (
        <StatusBanner workbench={workbench} ops={ops} />
      )}
      <ChatView workbench={workbench} chat={chat} ops={ops} autoFocus={focused} />
    </>
  );
}

const FOREIGN_REASON = 'This session runs on another device. Open it to continue it here.';

function PaneHeader({
  workbench,
  index,
  count,
  focused,
}: {
  workbench: Workbench;
  index: number;
  count: number;
  focused: boolean;
}) {
  const chats = useWorkbenchStore((s) => s.chats[workbench.id]);
  const unread = useWorkbenchStore((s) => s.unread);
  const prOnlyUnseen = useWorkbenchStore((s) => isPrOnlyUnseen(s.unseen[workbench.id]));
  const prRow = usePullRequestStore((s) =>
    workbench.pullRequestId ? s.rows.find((r) => r.id === workbench.pullRequestId) : undefined,
  );
  const background = useBackground(workbench.id);
  const pr = sessionPr(workbench, prRow);
  const state = sessionState(workbench, chats ?? [], unread, pr, prOnlyUnseen, background);
  const removePane = useSplitViewStore((s) => s.removePane);
  const movePane = useSplitViewStore((s) => s.movePane);
  const navigate = useNavigationStore((s) => s.navigate);
  const name = workbenchDisplayName(workbench);
  const iconButton = 'h-6 w-6 p-0 text-muted-foreground hover:text-foreground';

  return (
    <div
      className={cn(
        'flex h-9 shrink-0 cursor-grab items-center gap-2 border-b px-2.5 active:cursor-grabbing',
        focused ? 'bg-secondary/60' : 'bg-card',
      )}
      data-attr="split-view-pane-header"
      title="Drag onto another pane to move or swap"
      {...sessionDragProps(workbench.id)}
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" title={state.label}>
        <SessionStateIcon state={state} />
      </span>
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="min-w-0 truncate text-[13px] font-medium" title={name}>
          {name}
        </span>
        <span className="min-w-0 shrink-[2] truncate text-xs text-muted-foreground" title={workbench.repoFullName}>
          {workbench.repoFullName}
        </span>
      </div>
      {pr && <PrPill number={pr.number} state={pr.state} draft={pr.summary.draft} />}
      <div className="flex shrink-0 items-center">
        {count > 1 && (
          <>
            <Button
              variant="ghost"
              className={iconButton}
              disabled={index === 0}
              onClick={() => movePane(workbench.id, -1)}
              aria-label={`Move ${name} left`}
              title="Move left"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              className={iconButton}
              disabled={index === count - 1}
              onClick={() => movePane(workbench.id, 1)}
              aria-label={`Move ${name} right`}
              title="Move right"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          className={iconButton}
          onClick={() => navigate({ view: 'workbench', id: workbench.id })}
          aria-label={`Open ${name}`}
          title="Open the session"
          data-attr="split-view-open-session"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          className={iconButton}
          onClick={() => removePane(workbench.id)}
          aria-label={`Close ${name} in split view`}
          title="Close pane"
          data-attr="split-view-close-pane"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function MissingPane({ id, loading }: { id: string; loading: boolean }) {
  const removePane = useSplitViewStore((s) => s.removePane);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
      {loading ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the session…
        </>
      ) : (
        <>
          <p>This session is not available.</p>
          <Button variant="outline" size="sm" onClick={() => removePane(id)}>
            Close pane
          </Button>
        </>
      )}
    </div>
  );
}

function EmptySplitView() {
  const addPane = useSplitViewStore((s) => s.addPane);
  const [over, setOver] = useState(false);

  return (
    <div
      className={cn(
        'm-2 flex flex-1 flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed border-transparent px-6 text-center',
        over && 'border-primary/60 bg-primary/10',
      )}
      data-attr="split-view-empty"
      onDragOver={(event) => {
        if (!carriesSession(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(event) => {
        setOver(false);
        if (!carriesSession(event)) return;
        event.preventDefault();
        const dropped = droppedSession(event);
        if (dropped) addPane(dropped, 'split_view_drag');
      }}
    >
      <Columns2 className="h-8 w-8 text-muted-foreground" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-medium">Work on several sessions at once</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Add up to {MAX_SPLIT_PANES} sessions to read their transcripts side by side and prompt each one from here. You
          can also drag a session here from the sidebar, or right-click it and choose Open in split view.
        </p>
      </div>
      <AddSessionMenu variant="outline" />
    </div>
  );
}

/** Live sessions and threads that are not in a pane yet. */
function AddSessionMenu({ variant = 'ghost' }: { variant?: 'ghost' | 'outline' }) {
  const panes = useSplitViewStore((s) => s.panes);
  const addPane = useSplitViewStore((s) => s.addPane);
  const sessions = useOrderedLiveWorkbenches();
  const threads = useLiveThreads();
  const options = useMemo(
    () => [...threads, ...sessions].filter((workbench) => !panes.includes(workbench.id)),
    [threads, sessions, panes],
  );
  const full = panes.length >= MAX_SPLIT_PANES;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size="sm" className="h-7 gap-1 text-xs" data-attr="split-view-add-session">
          <Plus className="h-3.5 w-3.5" /> Add session
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {full ? `Split view holds ${MAX_SPLIT_PANES}. Adding one closes the oldest pane.` : 'Add a session'}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No other live sessions.</div>
        ) : (
          options.map((workbench) => (
            <DropdownMenuItem key={workbench.id} onSelect={() => addPane(workbench.id, 'split_view_menu')}>
              <AddSessionOption workbench={workbench} />
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddSessionOption({ workbench }: { workbench: Workbench }) {
  const chats = useWorkbenchStore((s) => s.chats[workbench.id]);
  const unread = useWorkbenchStore((s) => s.unread);
  const background = useBackground(workbench.id);
  const state = sessionState(workbench, chats ?? [], unread, sessionPr(workbench, null), false, background);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <SessionStateIcon state={state} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">{workbenchDisplayName(workbench)}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{workbench.repoFullName}</span>
      </span>
    </span>
  );
}
