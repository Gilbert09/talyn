import { useMemo } from 'react';
import { CheckCircle2, Circle, CircleDot, ExternalLink, Loader2, XCircle } from 'lucide-react';
import type { SpaceSessionRow, SpaceTaskRow } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { groupSpaceSessions, isWorkbenchOwner, openSpaceSession, viewersOf } from '../../lib/spaces';
import { openExternal } from '../../lib/openExternal';
import { emptySpaceList, useSpacesStore, type SpaceRef } from '../../stores/spaces';
import { useNavigationStore } from '../../stores/navigation';
import { useWorkspaceStore } from '../../stores/workspace';
import { Button } from '../ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu';
import { MemberAvatar, PresenceAvatars } from '../spaces/SpaceAvatars';
import { moveToSpace } from '../spaces/MoveToSpace';
import { SessionStateIcon } from '../workbench/WorkbenchBadges';
import { openNewWorkbench } from '../workbench/new/openNewWorkbench';
import { timeAgo } from '../workbench/new/RecentWorkbenches';
import { spaceSessionState } from '../../lib/sessionState';

export function SpaceSidebar({ active }: { active: SpaceRef }) {
  const spaceId = active.space.id;
  const sessions = useSpacesStore((s) => s.sessions[spaceId]) ?? emptySpaceList<SpaceSessionRow>();
  const tasks = useSpacesStore((s) => s.tasks[spaceId]) ?? emptySpaceList<SpaceTaskRow>();
  const presence = useSpacesStore((s) => s.presence[spaceId]);
  const selfUserId = useSpacesStore((s) => s.selfUserId);
  const route = useNavigationStore((s) => s.route);
  const openId = route.view === 'workbench' ? route.id : null;
  const groups = useMemo(() => groupSpaceSessions(sessions.items, presence, selfUserId), [sessions.items, presence, selfUserId]);
  const hidden = sessions.hiddenCount + tasks.hiddenCount;

  return (
    <div className="space-y-2" data-attr="space-sidebar">
      {!sessions.loaded ? (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading sessions…
        </div>
      ) : sessions.error ? (
        <p className="px-3 py-2 text-xs text-destructive">{sessions.error}</p>
      ) : groups.active.length + groups.recent.length === 0 ? (
        <div className="space-y-2 px-3 py-2 text-xs text-muted-foreground" data-attr="space-sidebar-empty">
          <p>No sessions in this space yet.</p>
          <Button variant="outline" size="sm" onClick={() => openNewWorkbench()}>
            Start a session
          </Button>
        </div>
      ) : (
        <>
          <SessionGroup label="Active now" rows={groups.active} openId={openId} spaceId={spaceId} />
          <SessionGroup label="Recent" rows={groups.recent} openId={openId} spaceId={spaceId} />
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

function SessionGroup({ label, rows, openId, spaceId }: { label: string; rows: SpaceSessionRow[]; openId: string | null; spaceId: string }) {
  if (rows.length === 0) return null;
  return (
    <div role="group" aria-label={label}>
      <div className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">{label}</div>
      {rows.map((row) => (
        <SpaceSessionItem key={row.id} row={row} selected={row.id === openId} spaceId={spaceId} />
      ))}
    </div>
  );
}

export function SpaceSessionItem({ row, selected, spaceId }: { row: SpaceSessionRow; selected: boolean; spaceId: string }) {
  const presence = useSpacesStore((s) => s.presence[spaceId]);
  const selfUserId = useSpacesStore((s) => s.selfUserId);
  const owner = useWorkspaceStore((s) => isWorkbenchOwner(row, s.workspaces, s.currentWorkspaceId));
  const viewers = viewersOf(presence, row.id, selfUserId);
  const name = row.title || row.name;
  const state = spaceSessionState(row);
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
      title={`${state.label}\n${name}\n${row.repoFullName} · ${row.creator.githubLogin ?? 'A teammate'}`}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-3 py-1 text-left text-[13px] transition-colors',
        selected ? 'bg-secondary text-foreground' : 'text-foreground/90 hover:bg-accent/60',
      )}
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <SessionStateIcon state={state} />
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <MemberAvatar member={row.creator} size={14} />
      <PresenceAvatars members={viewers} max={2} size={14} />
    </div>
  );
  if (!owner) return item;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{item}</ContextMenuTrigger>
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
};

function TaskRow({ task }: { task: SpaceTaskRow }) {
  const Icon = TASK_ICON[task.status] ?? Circle;
  const url = task.pullRequest?.url;
  return (
    <div
      className="flex w-full items-center gap-2 rounded-md px-3 py-1 text-[13px] text-foreground/90"
      title={`${task.title}\n${task.status.replace('_', ' ')} · ${task.creator.githubLogin ?? 'A teammate'} · ${timeAgo(task.updatedAt)}`}
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
