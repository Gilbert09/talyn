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
import type { PaletteEntry, PaletteSection } from '../lib/paletteSearch';
import { CommandShortcut } from './ui/command';

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
 * The palette sections for what the sidebar menus hold: the workspace and
 * space switcher, the open session's menu, a space's sessions, preferences
 * and sign-out. The twin file in the other app must stay the same.
 */
export function usePaletteAppSections(pick: PickFn): PaletteSection[] {
  const sections = [
    useCurrentSessionSection(pick),
    useSpaceSessionsSection(pick),
    useContextSection(pick),
    usePreferencesSection(pick),
  ];
  return sections.filter((section): section is PaletteSection => section !== null);
}

function copy(text: string, what: string): void {
  navigator.clipboard.writeText(text).then(
    () => toast.success(`Copied ${what}`),
    () => toast.error('Could not copy to clipboard'),
  );
}

function useCurrentSessionSection(pick: PickFn): PaletteSection | null {
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

  const entries: PaletteEntry[] = [];
  if (workbench.branch) {
    entries.push({
      id: 'this-session:copy-branch',
      label: 'Copy branch name',
      keywords: ['session', workbench.branch],
      onSelect: () => pick(() => copy(workbench.branch, 'branch name')),
      content: (
        <>
          <Copy className={ICON} />
          Copy branch name
        </>
      ),
    });
  }
  entries.push({
    id: 'this-session:copy-id',
    label: 'Copy session ID',
    keywords: ['session'],
    onSelect: () => pick(() => copy(workbench.id, 'session ID')),
    content: (
      <>
        <Copy className={ICON} />
        Copy session ID
      </>
    ),
  });
  if (prUrl) {
    entries.push({
      id: 'this-session:open-pr',
      label: 'Open pull request on GitHub',
      keywords: ['session'],
      onSelect: () => pick(() => void openExternal(prUrl)),
      content: (
        <>
          <ExternalLink className={ICON} />
          Open pull request on GitHub
        </>
      ),
    });
  }
  if (owner && spacesOn && workbench.runtime !== 'local') {
    entries.push({
      id: 'this-session:move',
      label: 'Move to space…',
      keywords: ['session'],
      onSelect: () =>
        pick(() =>
          useSpacesStore
            .getState()
            .openDialog({ kind: 'move', target: 'session', id: workbench.id, spaceId: workbench.spaceId ?? null }),
        ),
      content: (
        <>
          <FolderTree className={ICON} />
          Move to space…
        </>
      ),
    });
  }
  return { id: 'this-session', heading: `This session: ${name}`, kind: 'This session', entries };
}

function useSpaceSessionsSection(pick: PickFn): PaletteSection | null {
  const active = useActiveSpace();
  const offered = useWorkspaceStore((s) => workbenchesOffered(s.features));
  const sessions = useSpacesStore((s) => (active ? s.sessions[active.space.id] : undefined)) ?? emptySpaceList<SpaceSessionRow>();
  if (!active || !offered || sessions.items.length === 0) return null;
  return {
    id: 'space-sessions',
    heading: `${active.space.name} sessions`,
    kind: 'Space session',
    entries: sessions.items.map((row) => ({
      id: `space-session:${row.id}`,
      label: row.title || row.name,
      keywords: [row.name, row.repoFullName, row.creator.githubLogin, row.id, 'space session'],
      onSelect: () => pick(() => void openSpaceSession(row.id)),
      content: (
        <>
          <SpaceDot color={active.space.color} image={active.space.image} />
          <span className="truncate">{row.title || row.name}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{workbenchPlaceLabel(row)}</span>
          {row.creator.githubLogin && (
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">@{row.creator.githubLogin}</span>
          )}
        </>
      ),
    })),
  };
}

function useContextSection(pick: PickFn): PaletteSection {
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

  const entries: PaletteEntry[] = workspaces.map((w) => {
    const context: AppContext = { kind: 'personal', workspaceId: w.id };
    const keys = jumpKeys.get(contextKey(context));
    return {
      id: `workspace:${w.id}`,
      label: `Switch to ${w.name}`,
      keywords: [w.name, 'switch workspace', w.id],
      onSelect: () => pick(() => selectWorkspace(w.id)),
      content: (
        <>
          <WorkspaceLogo logo={w.logo} fallbackSeed={w.id} size={14} className="shrink-0" />
          <span className="truncate">Switch to {w.name}</span>
          {isCurrent(context) && <Check className={ICON} aria-label="Current" />}
          {keys && <CommandShortcut>{formatKeys(keys)}</CommandShortcut>}
        </>
      ),
    };
  });
  if (offered) {
    for (const team of teams ?? []) {
      for (const space of team.spaces) {
        const context: AppContext = { kind: 'space', spaceId: space.id };
        const keys = jumpKeys.get(contextKey(context));
        entries.push({
          id: `space:${space.id}`,
          label: `Switch to ${space.name}`,
          keywords: [space.name, team.name, 'switch space', space.id],
          onSelect: () => pick(() => switchContext(context)),
          content: (
            <>
              <SpaceDot color={space.color} image={space.image} />
              <span className="truncate">Switch to {space.name}</span>
              <span className="truncate text-[11px] text-muted-foreground">{team.name}</span>
              {isCurrent(context) && <Check className={ICON} aria-label="Current" />}
              {keys && <CommandShortcut>{formatKeys(keys)}</CommandShortcut>}
            </>
          ),
        });
      }
    }
  }
  entries.push({
    id: 'workspace:new',
    label: 'New workspace…',
    keywords: ['create workspace'],
    onSelect: () => pick(() => useWorkspaceStore.getState().setCreateWorkspaceOpen(true)),
    content: (
      <>
        <Plus className={ICON} />
        New workspace…
      </>
    ),
  });
  if (active) {
    entries.push({
      id: 'repository:add-to-space',
      label: `Add repository to ${active.space.name}…`,
      keywords: ['add repository to space'],
      onSelect: () => pick(() => useSpacesStore.getState().openDialog({ kind: 'addRepository', spaceId: active.space.id })),
      content: (
        <>
          <FolderPlus className={ICON} />
          Add repository to {active.space.name}…
        </>
      ),
    });
  } else {
    entries.push({
      id: 'repository:add',
      label: 'Add repository',
      onSelect: () => pick(() => useNavigationStore.getState().setAddRepositoryOpen(true)),
      content: (
        <>
          <FolderPlus className={ICON} />
          Add repository
        </>
      ),
    });
  }
  if (offered) {
    for (const team of teams ?? []) {
      entries.push({
        id: `space:new:${team.id}`,
        label: `New space in ${team.name}…`,
        keywords: ['create space'],
        onSelect: () => pick(() => useSpacesStore.getState().openDialog({ kind: 'createSpace', teamId: team.id })),
        content: (
          <>
            <Plus className={ICON} />
            New space in {team.name}…
          </>
        ),
      });
    }
    for (const team of teams ?? []) {
      entries.push({
        id: `team:${team.id}`,
        label: `Team settings: ${team.name}`,
        keywords: [team.id],
        onSelect: () => pick(() => openTeamSettings(team.id)),
        content: (
          <>
            <Settings className={ICON} />
            Team settings: {team.name}
          </>
        ),
      });
    }
    entries.push({
      id: 'team:new',
      label: 'Create team…',
      keywords: ['new team'],
      onSelect: () => pick(() => useSpacesStore.getState().openDialog({ kind: 'createTeam' })),
      content: (
        <>
          <Users className={ICON} />
          Create team…
        </>
      ),
    });
  }
  return { id: 'context', heading: offered ? 'Workspaces and spaces' : 'Workspaces', kind: 'Workspace', entries };
}

function contextKey(context: AppContext): string {
  return context.kind === 'space' ? `space:${context.spaceId}` : `personal:${context.workspaceId ?? ''}`;
}

function usePreferencesSection(pick: PickFn): PaletteSection {
  const theme = useWorkspaceStore((s) => s.theme);
  const sidebarOrder = useWorkspaceStore((s) => s.sidebarOrder);
  const sessionsOffered = useWorkspaceStore((s) => workbenchesOffered(s.features));
  const auth = useOptionalAuth();

  const entries: PaletteEntry[] = THEMES.map((t) => ({
    id: `theme:${t.value}`,
    label: `Theme: ${t.label}`,
    keywords: ['appearance'],
    onSelect: () => pick(() => useWorkspaceStore.getState().setTheme(t.value)),
    content: (
      <>
        <t.icon className={ICON} />
        Theme: {t.label}
        {theme === t.value && <Check className={ICON} aria-label="Current" />}
      </>
    ),
  }));
  if (sessionsOffered) {
    for (const o of SIDEBAR_ORDERS) {
      entries.push({
        id: `sidebar-order:${o.value}`,
        label: `Sidebar: ${o.label}`,
        keywords: ['sidebar order'],
        onSelect: () => pick(() => useWorkspaceStore.getState().setSidebarOrder(o.value)),
        content: (
          <>
            <FolderTree className={ICON} />
            Sidebar: {o.label}
            {sidebarOrder === o.value && <Check className={ICON} aria-label="Current" />}
          </>
        ),
      });
    }
  }
  if (auth?.user) {
    entries.push({
      id: 'sign-out',
      label: 'Sign out',
      keywords: ['log out'],
      onSelect: () => pick(() => void auth.signOut()),
      content: (
        <>
          <LogOut className={ICON} />
          Sign out
        </>
      ),
    });
  }
  return { id: 'preferences', heading: 'Preferences', kind: 'Preference', entries };
}
