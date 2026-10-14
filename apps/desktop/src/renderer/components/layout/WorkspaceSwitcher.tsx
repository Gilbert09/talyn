import { useEffect, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Plus, Settings } from 'lucide-react';
import { cn } from '../../lib/utils';
import { WorkspaceLogo } from '../widgets/WorkspaceLogo';
import { useWorkspaceStore } from '../../stores/workspace';

/**
 * Top-of-sidebar workspace switcher. Shows the active workspace and opens a
 * dropdown to switch between the user's workspaces, plus a shortcut into the
 * Workspace settings (where create / rename / delete live).
 */
export function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const {
    workspaces,
    currentWorkspaceId,
    setCurrentWorkspace,
    openSettings,
    setCreateWorkspaceOpen,
  } = useWorkspaceStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = workspaces.find((w) => w.id === currentWorkspaceId);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const select = (id: string) => {
    if (id !== currentWorkspaceId) setCurrentWorkspace(id);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={collapsed ? current?.name ?? 'No workspace' : 'Switch workspace'}
        className={cn(
          'app-region-no-drag flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent',
          collapsed && 'justify-center',
        )}
      >
        <WorkspaceLogo
          logo={current?.logo}
          fallbackSeed={current?.id ?? 'talyn'}
          size={22}
          className="flex-shrink-0"
        />
        {!collapsed && (
          <>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium leading-tight">{current?.name || 'No Workspace'}</p>
              <p className="truncate text-[11px] leading-tight text-muted-foreground">
                {current ? `${current.repos.length} ${current.repos.length === 1 ? 'repo' : 'repos'}` : 'Select a workspace'}
              </p>
            </div>
            <ChevronsUpDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          </>
        )}
      </button>

      {open && (
        <div
          className={cn(
            'absolute z-50 mt-1 max-h-80 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
            collapsed ? 'left-0 w-56' : 'inset-x-0',
          )}
        >
          <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Workspaces</div>
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => select(w.id)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              <Check
                className={cn(
                  'h-4 w-4 flex-shrink-0',
                  w.id === currentWorkspaceId ? 'opacity-100' : 'opacity-0',
                )}
              />
              <WorkspaceLogo logo={w.logo} fallbackSeed={w.id} size={20} className="flex-shrink-0" />
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              <span className="text-xs text-muted-foreground">{w.repos.length}</span>
            </button>
          ))}
          <div className="my-1 border-t" />
          <button
            type="button"
            onClick={() => {
              setCreateWorkspaceOpen(true);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
          >
            <Plus className="h-4 w-4 flex-shrink-0" />
            New workspace…
          </button>
          <button
            type="button"
            onClick={() => {
              openSettings('workspace');
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent"
          >
            <Settings className="h-4 w-4 flex-shrink-0" />
            Workspace settings
          </button>
        </div>
      )}
    </div>
  );
}
