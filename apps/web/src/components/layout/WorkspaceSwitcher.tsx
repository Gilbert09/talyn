import { useEffect, useRef, useState } from 'react';
import { Check, ChevronsUpDown, FolderPlus, Plus, Settings, Users } from 'lucide-react';
import { cn } from '../../lib/utils';
import { WorkspaceLogo } from '../widgets/WorkspaceLogo';
import { useWorkspaceStore } from '../../stores/workspace';
import { useNavigationStore } from '../../stores/navigation';
import { useSpacesStore } from '../../stores/spaces';
import { spacesOffered, switchContext, useActiveSpace } from '../../lib/spaces';
import { SpaceDot } from '../spaces/SpaceAvatars';

const ITEM = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent';

export function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const { workspaces, currentWorkspaceId, setCurrentWorkspace, openSettings, setCreateWorkspaceOpen } =
    useWorkspaceStore();
  const offered = useWorkspaceStore((s) => spacesOffered(s.features));
  const teams = useSpacesStore((s) => s.teams);
  const openDialog = useSpacesStore((s) => s.openDialog);
  const active = useActiveSpace();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = workspaces.find((w) => w.id === currentWorkspaceId);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const selectWorkspace = (id: string) => {
    if (offered) switchContext({ kind: 'personal', workspaceId: id });
    else if (id !== currentWorkspaceId) setCurrentWorkspace(id);
    setOpen(false);
  };

  const openTeamSettings = (teamId: string | null) => {
    useSpacesStore.getState().setSettingsTeamId(teamId);
    openSettings('teams');
    setOpen(false);
  };

  const title = active ? active.space.name : (current?.name || 'No Workspace');
  const subtitle = active
    ? active.team.name
    : current
      ? `${current.repos.length} ${current.repos.length === 1 ? 'repo' : 'repos'}`
      : 'Select a workspace';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={collapsed ? title : offered ? 'Switch workspace or space' : 'Switch workspace'}
        data-attr="workspace-switcher"
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent',
          collapsed && 'justify-center'
        )}
      >
        {active ? (
          <span className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-md bg-muted">
            <SpaceDot color={active.space.color} className="h-3 w-3" />
          </span>
        ) : (
          <WorkspaceLogo logo={current?.logo} fallbackSeed={current?.id ?? 'talyn'} size={22} className="flex-shrink-0" />
        )}
        {!collapsed && (
          <>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium leading-tight">{title}</p>
              <p className="truncate text-[11px] leading-tight text-muted-foreground">{subtitle}</p>
            </div>
            <ChevronsUpDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          </>
        )}
      </button>

      {open && (
        <div
          className={cn(
            'absolute z-50 mt-1 max-h-[28rem] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
            collapsed ? 'left-0 w-60' : 'inset-x-0 min-w-56'
          )}
        >
          <div className="px-2 py-1 text-xs font-medium text-muted-foreground">{offered ? 'Personal' : 'Workspaces'}</div>
          {workspaces.map((w) => (
            <button key={w.id} type="button" onClick={() => selectWorkspace(w.id)} className={ITEM}>
              <Check
                className={cn(
                  'h-4 w-4 flex-shrink-0',
                  !active && w.id === currentWorkspaceId ? 'opacity-100' : 'opacity-0'
                )}
              />
              <WorkspaceLogo logo={w.logo} fallbackSeed={w.id} size={20} className="flex-shrink-0" />
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              <span className="text-xs text-muted-foreground">{w.repos.length}</span>
            </button>
          ))}
          {!offered && <div className="my-1 border-t" />}
          <button
            type="button"
            onClick={() => {
              setCreateWorkspaceOpen(true);
              setOpen(false);
            }}
            className={ITEM}
          >
            <span aria-hidden className="h-4 w-4 flex-shrink-0" />
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
              <Plus className="h-4 w-4" />
            </span>
            New workspace…
          </button>
          {!active && (
            <>
              <button
                type="button"
                data-attr="sidebar-add-repository"
                onClick={() => {
                  useNavigationStore.getState().setAddRepositoryOpen(true);
                  setOpen(false);
                }}
                className={ITEM}
              >
                <FolderPlus className="h-4 w-4 flex-shrink-0" />
                Add repository
              </button>
              <button
                type="button"
                onClick={() => {
                  openSettings('workspace');
                  setOpen(false);
                }}
                className={cn(ITEM, 'text-muted-foreground')}
              >
                <Settings className="h-4 w-4 flex-shrink-0" />
                Workspace settings
              </button>
            </>
          )}

          {offered &&
            (teams ?? []).map((team) => (
              <div key={team.id} role="group" aria-label={team.name}>
                <div className="my-1 border-t" />
                <div className="truncate px-2 py-1 text-xs font-medium text-muted-foreground">{team.name}</div>
                {team.spaces.map((space) => (
                  <button
                    key={space.id}
                    type="button"
                    data-attr="switcher-space"
                    onClick={() => {
                      switchContext({ kind: 'space', spaceId: space.id });
                      setOpen(false);
                    }}
                    className={ITEM}
                  >
                    <Check className={cn('h-4 w-4 flex-shrink-0', active?.space.id === space.id ? 'opacity-100' : 'opacity-0')} />
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                      <SpaceDot color={space.color} />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{space.name}</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    openDialog({ kind: 'createSpace', teamId: team.id });
                    setOpen(false);
                  }}
                  className={ITEM}
                >
                  <span aria-hidden className="h-4 w-4 flex-shrink-0" />
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                    <Plus className="h-4 w-4" />
                  </span>
                  New space…
                </button>
                <button type="button" onClick={() => openTeamSettings(team.id)} className={cn(ITEM, 'text-muted-foreground')}>
                  <Settings className="h-4 w-4 flex-shrink-0" />
                  Team settings
                </button>
              </div>
            ))}
          {offered && (
            <>
              <div className="my-1 border-t" />
              <button
                type="button"
                data-attr="switcher-create-team"
                onClick={() => {
                  openDialog({ kind: 'createTeam' });
                  setOpen(false);
                }}
                className={ITEM}
              >
                <Users className="h-4 w-4 flex-shrink-0" />
                Create team…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
