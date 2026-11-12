import type { ReactElement } from 'react';
import { CheckCircle2, Circle, CircleDot, Clock, ExternalLink, Loader2, XCircle } from 'lucide-react';
import type { SpaceSessionRow, SpaceTaskRow } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { isWorkbenchOwner, openSpaceSession } from '../../lib/spaces';
import { formatKeys } from '../../lib/shortcuts';
import { openExternal } from '../../lib/openExternal';
import { emptySpaceList, useSpacesStore, type SpaceRef } from '../../stores/spaces';
import { useNavigationStore } from '../../stores/navigation';
import { useWorkspaceStore } from '../../stores/workspace';
import { Button } from '../ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu';
import { MemberAvatar, SessionViewers } from '../spaces/SpaceAvatars';
import { moveToSpace } from '../spaces/MoveToSpace';
import { SessionStateIcon } from '../workbench/WorkbenchBadges';
import { SpaceSessionHoverCard } from '../workbench/SessionHoverCard';
import { openNewWorkbench } from '../workbench/new/openNewWorkbench';
import { timeAgo } from '../workbench/new/RecentWorkbenches';
import { spaceSessionState, type SessionState } from '../../lib/sessionState';
import { spaceGroupKeyPrefix } from '../workbench/workbenchSelectors';
import { SidebarSessionGroups, WorkbenchRow } from './SidebarWorkbenchList';
import { SidebarThreadSection } from './SidebarThreadList';
import { useSpaceSidebarModel } from './spaceSidebarModel';

/**
 * The sidebar body in a space, laid out like Personal: my threads, then every
 * member's sessions in the Personal groups and order, then the space's tasks.
 */
export function SpaceSidebar({ active }: { active: SpaceRef }) {
  const spaceId = active.space.id;
  const sessions = useSpacesStore((s) => s.sessions[spaceId]) ?? emptySpaceList<SpaceSessionRow>();
  const tasks = useSpacesStore((s) => s.tasks[spaceId]) ?? emptySpaceList<SpaceTaskRow>();
  const route = useNavigationStore((s) => s.route);
  const openId = route.view === 'workbench' ? route.id : null;
  const model = useSpaceSidebarModel(spaceId);
  const hidden = sessions.hiddenCount + tasks.hiddenCount;
  const open = (id: string) => void openSpaceSession(id);

  return (
    <div className="space-y-2" data-attr="space-sidebar">
      {!sessions.loaded ? (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading sessions…
        </div>
      ) : sessions.error ? (
        <p className="px-3 py-2 text-xs text-destructive">{sessions.error}</p>
      ) : (
        <>
          <SidebarThreadSection entries={model.threads} onOpen={open} spaceId={spaceId} />
          {model.groups.length === 0 ? (
            <div className="space-y-2 px-3 py-2 text-xs text-muted-foreground" data-attr="space-sidebar-empty">
              <p>No sessions in this space yet.</p>
              <Button variant="outline" size="sm" onClick={() => openNewWorkbench()}>
                Start a session
              </Button>
            </div>
          ) : (
            <div className="space-y-1" data-attr="sidebar-workbenches">
              <SidebarSessionGroups
                groups={model.groups}
                states={model.states}
                openId={openId}
                keyPrefix={spaceGroupKeyPrefix(spaceId)}
                renderItem={(row, shortcut) => {
                  const workbench = model.owned.get(row.id);
                  return workbench ? (
                    <WorkbenchRow
                      key={row.id}
                      workbench={workbench}
                      shortcut={shortcut}
                      selected={row.id === openId}
                      onSelect={() => open(row.id)}
                      trailing={<SpaceRowPeople row={row} spaceId={spaceId} />}
                    />
                  ) : (
                    <SpaceSessionItem
                      key={row.id}
                      row={row}
                      selected={row.id === openId}
                      spaceId={spaceId}
                      shortcut={shortcut}
                      state={model.states.get(row.id)}
                    />
                  );
                }}
              />
            </div>
          )}
        </>
      )}
      {tasks.items.length > 0 && (
        <div role="group" aria-label="Tasks">
          <div className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">Tasks</div>
          {tasks.items.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </div>
      )}
      {hidden > 0 && (
        <p className="px-3 text-[11px] text-muted-foreground" data-attr="space-hidden-count">
          {hidden === 1 ? '1 item you can\'t see' : `${hidden} items you can't see`}
        </p>
      )}
    </div>
  );
}

/** Who started a space session, and the teammates who have it open now. */
function SpaceRowPeople({ row, spaceId }: { row: SpaceSessionRow; spaceId: string }) {
  return (
    <>
      <MemberAvatar member={row.creator} size={14} />
      <SessionViewers spaceId={spaceId} sessionId={row.id} />
    </>
  );
}

/** A space session row from the space's list only: a teammate's, or mine when it is not loaded here. */
export function SpaceSessionItem({
  row,
  selected,
  spaceId,
  shortcut = null,
  state: given,
}: {
  row: SpaceSessionRow;
  selected: boolean;
  spaceId: string;
  shortcut?: number | null;
  state?: SessionState;
}) {
  const owner = useWorkspaceStore((s) => isWorkbenchOwner(row, s.workspaces, s.currentWorkspaceId));
  const name = row.title || row.name;
  const state = given ?? spaceSessionState(row);
  const open = () => void openSpaceSession(row.id);
  const move = (to: 'personal' | 'pick') => {
    if (to === 'personal') {
      void moveToSpace('session', row.id, spaceId, null);
    } else {
      useSpacesStore.getState().openDialog({ kind: 'move', target: 'session', id: row.id, spaceId });
    }
  };

  const item = (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          open();
        }
      }}
      data-attr="space-session-row"
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-3 py-1 text-left text-[13px] transition-colors',
        selected ? 'bg-secondary text-foreground' : 'text-foreground/90 hover:bg-accent/60',
      )}
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <SessionStateIcon state={state} />
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <SpaceRowPeople row={row} spaceId={spaceId} />
    </div>
  );
  const card = (trigger: ReactElement) => (
    <SpaceSessionHoverCard row={row} state={state} shortcut={shortcut ? formatKeys(`mod+alt+${shortcut}`) : null}>
      {trigger}
    </SpaceSessionHoverCard>
  );
  if (!owner) return card(item);
  return (
    <ContextMenu>
      {card(<ContextMenuTrigger asChild>{item}</ContextMenuTrigger>)}
      <ContextMenuContent className="min-w-[10rem]">
        <ContextMenuItem onSelect={open}>Open</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => move('pick')}>Move to space…</ContextMenuItem>
        <ContextMenuItem onSelect={() => move('personal')}>Move to Personal</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const TASK_ICON: Partial<Record<SpaceTaskRow['status'], typeof Circle>> = {
  in_progress: Loader2,
  completed: CheckCircle2,
  failed: XCircle,
  needs_human: CircleDot,
  waiting_ci: Clock,
};

function TaskRow({ task }: { task: SpaceTaskRow }) {
  const Icon = TASK_ICON[task.status] ?? Circle;
  const url = task.pullRequest?.url;
  return (
    <div
      className="flex w-full items-center gap-2 rounded-md px-3 py-1 text-[13px] text-foreground/90"
      title={`${task.title}\n${task.status.replace(/_/g, ' ')} · ${task.creator.githubLogin ?? 'A teammate'} · ${timeAgo(task.updatedAt)}`}
      data-attr="space-task-row"
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', task.status === 'in_progress' && 'animate-spin')} />
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      <MemberAvatar member={task.creator} size={14} />
      {url && (
        <button
          type="button"
          onClick={() => void openExternal(url)}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={`Open #${task.pullRequest!.number} on GitHub`}
          title={`Open #${task.pullRequest!.number} on GitHub`}
        >
          <ExternalLink className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
