import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Archive, BarChart3, Columns2, GitPullRequest, History, Home, MessagesSquare, Settings, Workflow } from 'lucide-react';
import { INTEGRATION_CATALOG, integrationsOffered, mcpServersOffered, splitViewOffered, workbenchDisplayName, workbenchesOffered, type Workbench } from '@talyn/shared';
import { formatKeys, getShortcut, getShortcuts, shortcutEnabled, subscribeShortcuts, type Shortcut } from '../lib/shortcuts';
import { goToShortcutIdForNavItem } from './layout/goToShortcuts';
import { sessionPr, sessionState } from '../lib/sessionState';
import { useBackground } from '../stores/sessionBackground';
import { api } from '../lib/api';
import { archivedAtOf, relativeTime } from '../pages/HistoryView';
import { useNavigationStore, type Route, PR_TABS } from '../stores/navigation';
import { usePullRequestStore } from '../stores/pullRequests';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore, type SettingsSection } from '../stores/workspace';
import { PR_PAGE_TABS, PR_TAB_LABEL } from '../lib/routeLabels';
import { isArchived, useWorkspaceWorkbenches } from './workbench/workbenchSelectors';
import { openNewThread, openNewWorkbench } from './workbench/new/openNewWorkbench';
import { SessionStateIcon } from './workbench/WorkbenchBadges';
import { usePaletteAppSections } from './PaletteAppCommands';
import { usePaletteAutomationsSection } from './PaletteAutomations';
import { rankPaletteSections, type PaletteEntry, type PaletteSection } from '../lib/paletteSearch';
import { SlackSessionMark } from './workbench/SlackThreadChip';
import { slackSourceOf } from '../lib/slackSession';
import { workbenchPlaceLabel } from '../lib/threads';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from './ui/command';

const ICON = 'h-3.5 w-3.5 shrink-0 text-muted-foreground';

const SETTINGS_LABEL: Record<SettingsSection, string> = {
  sessions: 'Sessions',
  shortcuts: 'Shortcuts',
  workspace: 'Workspace',
  sandboxSetup: 'Sandbox setup',
  integrations: 'Integrations',
  skills: 'Skills',
  instructions: 'Instructions',
  memory: 'Memory',
  codeReview: 'Code review',
  account: 'Account',
  billing: 'Billing',
  teams: 'Teams',
  appearance: 'Appearance',
  developer: 'Developer',
  mcp: 'Talyn MCP server',
  apiTokens: 'API tokens',
  about: 'About',
};

interface NavItem {
  key: string;
  label: string;
  icon: typeof Home;
  route: Route;
}

let shortcutsVersion = 0;
function subscribeVersion(listener: () => void): () => void {
  return subscribeShortcuts(() => {
    shortcutsVersion += 1;
    listener();
  });
}
const readVersion = () => shortcutsVersion;

/** The go-to shortcut for a Navigate row, when it applies now. */
function navShortcut(key: string): Shortcut | undefined {
  const id = goToShortcutIdForNavItem(key);
  const shortcut = id ? getShortcut(id) : undefined;
  return shortcut && shortcutEnabled(shortcut) ? shortcut : undefined;
}

/**
 * ⌘K. Jump to any workbench, go anywhere in the app, or run any shortcut
 * that applies now (listed with its keys). With no search the rows are
 * grouped by type; a search ranks every match in one list, best first.
 * Closes on Escape or on a pick.
 */
export function CommandPalette() {
  const open = useNavigationStore((s) => s.paletteOpen);
  const setOpen = useNavigationStore((s) => s.setPaletteOpen);
  if (!open) return null;
  return <PaletteBody onClose={() => setOpen(false)} />;
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigationStore((s) => s.navigate);
  const features = useWorkspaceStore((s) => s.features);
  const all = useWorkspaceWorkbenches();
  const workspaceId = useWorkbenchStore((s) => s.workspaceId);
  const [query, setQuery] = useState('');
  const [archiveCache, setArchiveCache] = useState<{ workspaceId: string; rows: Workbench[] } | null>(null);
  const archived = archiveCache?.workspaceId === workspaceId ? archiveCache.rows : [];
  const sessionsOffered = workbenchesOffered(features);
  useEffect(() => {
    if (!workspaceId || !sessionsOffered) return;
    let active = true;
    void api.workbenches.list(workspaceId, { includeArchived: true }).then(
      (list) => {
        const rows = list.filter(isArchived);
        if (active && rows.length > 0) setArchiveCache({ workspaceId, rows });
      },
      () => {}
    );
    return () => { active = false; };
  }, [workspaceId, sessionsOffered]);
  const archivedSessions = useMemo(
    () => (sessionsOffered ? [...archived].sort((a, b) => archivedAtOf(b).localeCompare(archivedAtOf(a))) : []),
    [archived, sessionsOffered]
  );
  useSyncExternalStore(subscribeVersion, readVersion);

  const workbenches = useMemo(
    // Threads too: they are not in the repository groups, but a person searches for them the same way.
    () => all.filter((w) => !isArchived(w)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [all]
  );

  const navItems = useMemo<NavItem[]>(() => {
    const items: NavItem[] = [{ key: 'home', label: 'Home', icon: Home, route: { view: 'home' } }];
    if (workbenchesOffered(features)) {
      items.push({ key: 'history', label: 'History', icon: History, route: { view: 'history' } });
    }
    if (splitViewOffered(features)) {
      items.push({ key: 'split', label: 'Split view', icon: Columns2, route: { view: 'split' } });
    }
    for (const tab of PR_TABS) {
      items.push({
        key: `prs:${tab}`,
        label: PR_PAGE_TABS.includes(tab) ? `Pull requests: ${PR_TAB_LABEL[tab]}` : PR_TAB_LABEL[tab],
        icon: GitPullRequest,
        route: { view: 'prs', tab },
      });
    }
    items.push({ key: 'integrations', label: 'Integrations', icon: Workflow, route: { view: 'integrations' } });
    for (const kind of integrationsOffered(features)) {
      items.push({
        key: `integrations:${kind}`,
        label: `Integrations: ${INTEGRATION_CATALOG[kind].name}`,
        icon: Workflow,
        route: { view: 'integrations', kind },
      });
    }
    items.push({ key: 'insights', label: 'Insights', icon: BarChart3, route: { view: 'insights' } });
    if (mcpServersOffered(features)) {
      items.push({ key: 'mcp_servers', label: 'MCP servers', icon: Settings, route: { view: 'mcp_servers' } });
    }
    for (const section of Object.keys(SETTINGS_LABEL) as SettingsSection[]) {
      if ((section === 'sessions' || section === 'memory' || section === 'sandboxSetup') && !workbenchesOffered(features)) continue;
      items.push({
        key: `settings:${section}`,
        label: `Settings: ${SETTINGS_LABEL[section]}`,
        icon: Settings,
        route: { view: 'settings', section },
      });
    }
    return items;
  }, [features]);

  const actions: Shortcut[] = getShortcuts().filter((s) => !s.hidden && shortcutEnabled(s));

  const pick = (fn: () => void) => {
    onClose();
    fn();
  };

  const appSections = usePaletteAppSections(pick);
  const automationsSection = usePaletteAutomationsSection(pick);

  const navEntries: PaletteEntry[] = [];
  if (workbenchesOffered(features)) {
    navEntries.push({
      id: 'new:session',
      label: 'New session',
      onSelect: () => pick(() => openNewWorkbench()),
      content: (
        <>
          <Home className={ICON} />
          New session
        </>
      ),
    });
  }
  if (workbenchesOffered(features)) {
    navEntries.push({
      id: 'new:thread',
      label: 'New thread',
      onSelect: () => pick(openNewThread),
      content: (
        <>
          <MessagesSquare className={ICON} />
          New thread
        </>
      ),
    });
  }
  for (const item of navItems) {
    const shortcut = navShortcut(item.key);
    navEntries.push({
      id: `go:${item.key}`,
      label: item.label,
      keywords: ['go'],
      onSelect: () => pick(() => navigate(item.route)),
      content: (
        <>
          <item.icon className={ICON} />
          {item.label}
          {shortcut && <CommandShortcut>{formatKeys(shortcut.keys)}</CommandShortcut>}
        </>
      ),
    });
  }

  const sections: PaletteSection[] = [
    {
      id: 'sessions',
      heading: 'Sessions',
      kind: 'Session',
      entries: (workbenchesOffered(features) ? workbenches : []).map((wb) => ({
        id: `session:${wb.id}`,
        label: workbenchDisplayName(wb),
        keywords: [wb.name, wb.branch, wb.repoFullName, wb.id],
        onSelect: () => pick(() => navigate({ view: 'workbench', id: wb.id })),
        content: <PaletteSessionContent workbench={wb} />,
      })),
    },
    {
      id: 'archived',
      heading: 'Archived',
      kind: 'Archived',
      searchOnly: true,
      limit: 8,
      entries: archivedSessions.map((wb) => ({
        id: `archived:${wb.id}`,
        label: workbenchDisplayName(wb),
        keywords: [wb.name, wb.branch, wb.repoFullName],
        onSelect: () =>
          pick(() => {
            useWorkbenchStore.getState().upsertWorkbench(wb);
            navigate({ view: 'workbench', id: wb.id });
          }),
        content: (
          <>
            <Archive className={ICON} />
            <span className="truncate">{workbenchDisplayName(wb)}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">{workbenchPlaceLabel(wb)}</span>
            <span className="ml-auto shrink-0 text-[11px] text-muted-foreground" title={new Date(archivedAtOf(wb)).toLocaleString()}>
              {relativeTime(archivedAtOf(wb))}
            </span>
          </>
        ),
      })),
    },
    ...(automationsSection ? [automationsSection] : []),
    { id: 'navigate', heading: 'Navigate', kind: 'Navigate', entries: navEntries },
    ...appSections,
    {
      id: 'actions',
      heading: 'Actions',
      kind: 'Action',
      entries: actions.map((s) => ({
        id: `action:${s.id}`,
        label: s.label,
        keywords: [s.group, 'action'],
        onSelect: () => pick(s.run),
        content: (
          <>
            <span className="truncate">{s.label}</span>
            <CommandShortcut>{formatKeys(s.keys)}</CommandShortcut>
          </>
        ),
      })),
    },
  ];

  const searching = query.trim() !== '';

  return (
    <CommandDialog open onOpenChange={(next) => !next && onClose()} shouldFilter={false}>
      <CommandInput placeholder="Search sessions, automations, pages, spaces, settings and actions…" value={query} onValueChange={setQuery} autoFocus />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        {searching
          ? rankPaletteSections(query, sections).map(({ entry, kind }) => <PaletteRow key={entry.id} entry={entry} kind={kind} />)
          : sections
              .filter((section) => !section.searchOnly && section.entries.length > 0)
              .map((section) => (
                <CommandGroup key={section.id} heading={section.heading}>
                  {section.entries.map((entry) => <PaletteRow key={entry.id} entry={entry} />)}
                </CommandGroup>
              ))}
      </CommandList>
    </CommandDialog>
  );
}

/** A palette row. In the ranked list it also shows what type of row it is. */
function PaletteRow({ entry, kind }: { entry: PaletteEntry; kind?: string }) {
  return (
    <CommandItem value={entry.id} onSelect={() => entry.onSelect()}>
      {entry.content}
      {kind && (
        // Right-aligned, after any keys or time that the row already pushes right.
        <span className="ml-auto shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground [.ml-auto~&]:ml-2" data-palette-kind="">
          {kind}
        </span>
      )}
    </CommandItem>
  );
}

function PaletteSessionContent({ workbench }: { workbench: Workbench }) {
  const chats = useWorkbenchStore((s) => s.chats[workbench.id]);
  const unread = useWorkbenchStore((s) => s.unread);
  const pr = usePullRequestStore((s) =>
    workbench.pullRequestId ? s.rows.find((r) => r.id === workbench.pullRequestId) : undefined
  );
  const background = useBackground(workbench.id);
  const state = sessionState(workbench, chats ?? [], unread, sessionPr(workbench, pr), false, background);

  return (
    <>
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <SessionStateIcon state={state} />
      </span>
      <SlackSessionMark source={slackSourceOf(workbench)} />
      <span className="truncate">{workbenchDisplayName(workbench)}</span>
      <span className="truncate font-mono text-[11px] text-muted-foreground">{workbenchPlaceLabel(workbench)}</span>
    </>
  );
}
