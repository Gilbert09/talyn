import { useMemo } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  FolderPlus,
  FolderTree,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Settings,
  Sun,
  Users,
} from 'lucide-react';
import { workbenchDisplayName, workbenchesOffered, type SpaceSessionRow } from '@talyn/shared';
import { CONTEXT_JUMP_KEYS } from './layout/appShortcuts';
import { useOptionalAuth } from './auth/AuthProvider';
import { formatKeys } from '../lib/shortcuts';
import { contextEntries, contextsEqual, isWorkbenchOwner, openSpaceSession, spacesOffered, switchContext, useActiveSpace } from '../lib/spaces';
import { openExternal } from '../lib/openExternal';
import { useNavigationStore } from '../stores/navigation';
import { usePullRequestStore } from '../stores/pullRequests';
import { emptySpaceList, useSpacesStore } from '../stores/spaces';
import { toast } from '../stores/toast';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore, type AppContext, type SidebarOrder, type Theme } from '../stores/workspace';
import { workbenchPlaceLabel } from '../lib/threads';
import { SpaceDot } from './spaces/SpaceAvatars';
import { WorkspaceLogo } from './widgets/WorkspaceLogo';
import { CommandGroup, CommandItem, CommandShortcut } from './ui/command';

const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

const SIDEBAR_ORDERS: { value: SidebarOrder; label: string }[] = [
  { value: 'active_first', label: 'Active sessions first' },
  { value: 'repository', label: 'Group by repository' },
];

const ICON = 'h-3.5 w-3.5 shrink-0 text-muted-foreground';

type PickFn = (fn: () => void) => void;

/**
 * The palette rows for what the sidebar menus hold: the workspace and space
 * switcher, the open session's menu, a space's sessions, preferences and
 * sign-out. The twin file in the other app must stay the same.
 */
export function PaletteAppCommands({ pick }: { pick: PickFn }) {
  return (
    <>
      <CurrentSessionGroup pick={pick} />
      <SpaceSessionsGroup pick={pick} />
      <ContextGroup pick={pick} />
      <PreferencesGroup pick={pick} />
    </>
  );
}

function copy(text: string, what: string): void {
  navigator.clipboard.writeText(text).then(
    () => toast.success(`Copied ${what}`),
    () => toast.error('Could not copy to clipboard'),
  );
}

function CurrentSessionGroup({ pick }: { pick: PickFn }) {
  const route = useNavigationStore((s) => s.route);
  const id = route.view === 'workbench' ? route.id : null;
  const workbench = useWorkbenchStore((s) => (id ? s.workbenches[id] : undefined));
  const extra = useWorkbenchStore((s) => (id ? Boolean(s.extraWorkbenchIds[id]) : false));
  const owner = useWorkspaceStore((s) =>
    workbench ? !extra || isWorkbenchOwner(workbench, s.workspaces, s.currentWorkspaceId) : false,
  );
  const spacesOn = useWorkspaceStore((s) => spacesOffered(s.features));
  const row = usePullRequestStore((s) =>
    workbench?.pullRequestId ? s.rows.find((r) => r.id === workbench.pullRequestId) : undefined,
  );
  if (!workbench) return null;
  const prUrl = row?.summary.url ?? workbench.pr?.url;
  const name = workbenchDisplayName(workbench);

  return (
    <CommandGroup heading={`This session: ${name}`}>
      {workbench.branch && (
        <CommandItem value="session copy branch name" onSelect={() => pick(() => copy(workbench.branch, 'branch name'))}>
          <Copy className={ICON} />
          Copy branch name
        </CommandItem>
      )}
      <CommandItem value="session copy session id" onSelect={() => pick(() => copy(workbench.id, 'session ID'))}>
        <Copy className={ICON} />
        Copy session ID
      </CommandItem>
      {prUrl && (
        <CommandItem value="session open pull request on github" onSelect={() => pick(() => void openExternal(prUrl))}>
          <ExternalLink className={ICON} />
          Open pull request on GitHub
        </CommandItem>
      )}
      {owner && spacesOn && workbench.runtime !== 'local' && (
        <CommandItem
          value="session move to space"
          onSelect={() =>
            pick(() =>
              useSpacesStore
                .getState()
                .openDialog({ kind: 'move', target: 'session', id: workbench.id, spaceId: workbench.spaceId ?? null }),
            )
          }
        >
          <FolderTree className={ICON} />
          Move to space…
        </CommandItem>
      )}
    </CommandGroup>
  );
}

function SpaceSessionsGroup({ pick }: { pick: PickFn }) {
  const active = useActiveSpace();
  const offered = useWorkspaceStore((s) => workbenchesOffered(s.features));
  const sessions = useSpacesStore((s) => (active ? s.sessions[active.space.id] : undefined)) ?? emptySpaceList<SpaceSessionRow>();
  if (!active || !offered || sessions.items.length === 0) return null;
  return (
    <CommandGroup heading={`${active.space.name} sessions`}>
      {sessions.items.map((row) => (
        <CommandItem
          key={row.id}
          value={`space session ${row.title ?? ''} ${row.name} ${row.repoFullName} ${row.creator.githubLogin ?? ''} ${row.id}`}
          onSelect={() => pick(() => void openSpaceSession(row.id))}
        >
          <SpaceDot color={active.space.color} image={active.space.image} />
          <span className="truncate">{row.title || row.name}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{workbenchPlaceLabel(row)}</span>
          {row.creator.githubLogin && (
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">@{row.creator.githubLogin}</span>
          )}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function ContextGroup({ pick }: { pick: PickFn }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const currentContext = useWorkspaceStore((s) => s.currentContext);
  const offered = useWorkspaceStore((s) => spacesOffered(s.features));
  const teams = useSpacesStore((s) => s.teams);
  const active = useActiveSpace();

  // ⌘⌥⇧1–9 count in switcher order, and only while Spaces is on.
  const jumpKeys = useMemo(() => {
    const keys = new Map<string, string>();
    if (!offered) return keys;
    contextEntries(workspaces, teams).slice(0, 9).forEach((context, i) => {
      keys.set(contextKey(context), CONTEXT_JUMP_KEYS(i + 1));
    });
    return keys;
  }, [offered, workspaces, teams]);

  const current: AppContext = offered ? currentContext : { kind: 'personal', workspaceId: currentWorkspaceId };
  const isCurrent = (context: AppContext) => contextsEqual(current, context);

  const selectWorkspace = (id: string) => {
    if (offered) switchContext({ kind: 'personal', workspaceId: id });
    else if (id !== useWorkspaceStore.getState().currentWorkspaceId) useWorkspaceStore.getState().setCurrentWorkspace(id);
  };
  const openTeamSettings = (teamId: string) => {
    useSpacesStore.getState().setSettingsTeamId(teamId);
    useNavigationStore.getState().navigate({ view: 'settings', section: 'teams' });
  };

  return (
    <CommandGroup heading={offered ? 'Workspaces and spaces' : 'Workspaces'}>
      {workspaces.map((w) => {
        const context: AppContext = { kind: 'personal', workspaceId: w.id };
        const keys = jumpKeys.get(contextKey(context));
        return (
          <CommandItem key={`ws:${w.id}`} value={`switch workspace ${w.name} ${w.id}`} onSelect={() => pick(() => selectWorkspace(w.id))}>
            <WorkspaceLogo logo={w.logo} fallbackSeed={w.id} size={14} className="shrink-0" />
            <span className="truncate">Switch to {w.name}</span>
            {isCurrent(context) && <Check className={ICON} aria-label="Current" />}
            {keys && <CommandShortcut>{formatKeys(keys)}</CommandShortcut>}
          </CommandItem>
        );
      })}
      {offered &&
        (teams ?? []).flatMap((team) =>
          team.spaces.map((space) => {
            const context: AppContext = { kind: 'space', spaceId: space.id };
            const keys = jumpKeys.get(contextKey(context));
            return (
              <CommandItem
                key={`space:${space.id}`}
                value={`switch space ${team.name} ${space.name} ${space.id}`}
                onSelect={() => pick(() => switchContext(context))}
              >
                <SpaceDot color={space.color} image={space.image} />
                <span className="truncate">Switch to {space.name}</span>
                <span className="truncate text-[11px] text-muted-foreground">{team.name}</span>
                {isCurrent(context) && <Check className={ICON} aria-label="Current" />}
                {keys && <CommandShortcut>{formatKeys(keys)}</CommandShortcut>}
              </CommandItem>
            );
          }),
        )}
      <CommandItem value="new workspace create" onSelect={() => pick(() => useWorkspaceStore.getState().setCreateWorkspaceOpen(true))}>
        <Plus className={ICON} />
        New workspace…
      </CommandItem>
      {active ? (
        <CommandItem
          value={`add repository to space ${active.space.name}`}
          onSelect={() => pick(() => useSpacesStore.getState().openDialog({ kind: 'addRepository', spaceId: active.space.id }))}
        >
          <FolderPlus className={ICON} />
          Add repository to {active.space.name}…
        </CommandItem>
      ) : (
        <CommandItem value="add repository" onSelect={() => pick(() => useNavigationStore.getState().setAddRepositoryOpen(true))}>
          <FolderPlus className={ICON} />
          Add repository
        </CommandItem>
      )}
      {offered &&
        (teams ?? []).map((team) => (
          <CommandItem
            key={`new-space:${team.id}`}
            value={`new space create in ${team.name} ${team.id}`}
            onSelect={() => pick(() => useSpacesStore.getState().openDialog({ kind: 'createSpace', teamId: team.id }))}
          >
            <Plus className={ICON} />
            New space in {team.name}…
          </CommandItem>
        ))}
      {offered &&
        (teams ?? []).map((team) => (
          <CommandItem key={`team:${team.id}`} value={`team settings ${team.name} ${team.id}`} onSelect={() => pick(() => openTeamSettings(team.id))}>
            <Settings className={ICON} />
            Team settings: {team.name}
          </CommandItem>
        ))}
      {offered && (
        <CommandItem value="create team new" onSelect={() => pick(() => useSpacesStore.getState().openDialog({ kind: 'createTeam' }))}>
          <Users className={ICON} />
          Create team…
        </CommandItem>
      )}
    </CommandGroup>
  );
}

function contextKey(context: AppContext): string {
  return context.kind === 'space' ? `space:${context.spaceId}` : `personal:${context.workspaceId ?? ''}`;
}

function PreferencesGroup({ pick }: { pick: PickFn }) {
  const theme = useWorkspaceStore((s) => s.theme);
  const sidebarOrder = useWorkspaceStore((s) => s.sidebarOrder);
  const sessionsOffered = useWorkspaceStore((s) => workbenchesOffered(s.features));
  const auth = useOptionalAuth();

  return (
    <CommandGroup heading="Preferences">
      {THEMES.map((t) => (
        <CommandItem key={t.value} value={`theme ${t.label} appearance`} onSelect={() => pick(() => useWorkspaceStore.getState().setTheme(t.value))}>
          <t.icon className={ICON} />
          Theme: {t.label}
          {theme === t.value && <Check className={ICON} aria-label="Current" />}
        </CommandItem>
      ))}
      {sessionsOffered &&
        SIDEBAR_ORDERS.map((o) => (
          <CommandItem
            key={o.value}
            value={`sidebar order ${o.label}`}
            onSelect={() => pick(() => useWorkspaceStore.getState().setSidebarOrder(o.value))}
          >
            <FolderTree className={ICON} />
            Sidebar: {o.label}
            {sidebarOrder === o.value && <Check className={ICON} aria-label="Current" />}
          </CommandItem>
        ))}
      {auth?.user && (
        <CommandItem value="sign out log out" onSelect={() => pick(() => void auth.signOut())}>
          <LogOut className={ICON} />
          Sign out
        </CommandItem>
      )}
    </CommandGroup>
  );
}
