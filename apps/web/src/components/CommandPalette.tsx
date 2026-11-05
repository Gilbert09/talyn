import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Archive, BarChart3, GitPullRequest, History, Home, MessagesSquare, Settings, Workflow } from 'lucide-react';
import { mcpServersOffered, workbenchDisplayName, workbenchesOffered, type Workbench } from '@talyn/shared';
import { formatKeys, getShortcuts, shortcutEnabled, subscribeShortcuts, type Shortcut } from '../lib/shortcuts';
import { sessionPr, sessionState } from '../lib/sessionState';
import { api } from '../lib/api';
import { archivedAtOf, relativeTime } from '../pages/HistoryView';
import { useNavigationStore, type Route, PR_TABS } from '../stores/navigation';
import { usePullRequestStore } from '../stores/pullRequests';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore, type SettingsSection } from '../stores/workspace';
import { AUTOMATION_TAB_LABEL, PR_PAGE_TABS, PR_TAB_LABEL, offeredAutomationTabs } from '../lib/routeLabels';
import { isArchived, useWorkspaceWorkbenches } from './workbench/workbenchSelectors';
import { openNewThread, openNewWorkbench } from './workbench/new/openNewWorkbench';
import { SessionStateIcon } from './workbench/WorkbenchBadges';
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

const SETTINGS_LABEL: Record<SettingsSection, string> = {
  sessions: 'Sessions',
  shortcuts: 'Shortcuts',
  workspace: 'Workspace',
  sandboxSetup: 'Sandbox setup',
  integrations: 'Integrations',
  slack: 'Slack',
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
  const archivedMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !sessionsOffered) return [];
    return archived
      .filter((wb) => [workbenchDisplayName(wb), wb.name, wb.branch, wb.repoFullName]
        .some((value) => value.toLowerCase().includes(q)))
      .sort((a, b) => archivedAtOf(b).localeCompare(archivedAtOf(a)))
      .slice(0, 8);
  }, [archived, query, sessionsOffered]);
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
    for (const tab of PR_TABS) {
      items.push({
        key: `prs:${tab}`,
        label: PR_PAGE_TABS.includes(tab) ? `Pull requests: ${PR_TAB_LABEL[tab]}` : PR_TAB_LABEL[tab],
        icon: GitPullRequest,
        route: { view: 'prs', tab },
      });
    }
    for (const tab of offeredAutomationTabs(features)) {
      items.push({
        key: `automations:${tab}`,
        label: `Automations: ${AUTOMATION_TAB_LABEL[tab]}`,
        icon: Workflow,
        route: { view: 'automations', tab },
      });
    }
    items.push({ key: 'insights', label: 'Insights', icon: BarChart3, route: { view: 'insights' } });
    if (mcpServersOffered(features)) {
      items.push({ key: 'mcp_servers', label: 'MCP servers', icon: Settings, route: { view: 'mcp_servers' } });
    }
    for (const section of Object.keys(SETTINGS_LABEL) as SettingsSection[]) {
      if ((section === 'sessions' || section === 'slack' || section === 'memory' || section === 'sandboxSetup') && !workbenchesOffered(features)) continue;
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

  return (
    <CommandDialog open onOpenChange={(next) => !next && onClose()}>
      <CommandInput placeholder="Search sessions, pages and actions…" value={query} onValueChange={setQuery} autoFocus />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        {workbenchesOffered(features) && workbenches.length > 0 && (
          <CommandGroup heading="Sessions">
            {workbenches.map((wb) => (
              <PaletteSessionItem key={wb.id} workbench={wb} onSelect={() => pick(() => navigate({ view: 'workbench', id: wb.id }))} />
            ))}
          </CommandGroup>
        )}
        {archivedMatches.length > 0 && (
          <CommandGroup heading="Archived">
            {archivedMatches.map((wb) => (
              <CommandItem
                key={wb.id}
                value={`archived ${workbenchDisplayName(wb)} ${wb.name} ${wb.branch} ${wb.repoFullName}`}
                onSelect={() => pick(() => {
                  useWorkbenchStore.getState().upsertWorkbench(wb);
                  navigate({ view: 'workbench', id: wb.id });
                })}
              >
                <Archive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{workbenchDisplayName(wb)}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">{workbenchPlaceLabel(wb)}</span>
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground" title={new Date(archivedAtOf(wb)).toLocaleString()}>
                  {relativeTime(archivedAtOf(wb))}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading="Navigate">
          {workbenchesOffered(features) && (
            <CommandItem value="new session" onSelect={() => pick(() => openNewWorkbench())}>
              <Home className="h-3.5 w-3.5 text-muted-foreground" />
              New session
            </CommandItem>
          )}
          {workbenchesOffered(features) && (
            <CommandItem value="new thread" onSelect={() => pick(openNewThread)}>
              <MessagesSquare className="h-3.5 w-3.5 text-muted-foreground" />
              New thread
            </CommandItem>
          )}
          {navItems.map((item) => (
            <CommandItem key={item.key} value={`go ${item.label}`} onSelect={() => pick(() => navigate(item.route))}>
              <item.icon className="h-3.5 w-3.5 text-muted-foreground" />
              {item.label}
            </CommandItem>
          ))}
        </CommandGroup>
        {actions.length > 0 && (
          <CommandGroup heading="Actions">
            {actions.map((s) => (
              <CommandItem key={s.id} value={`action ${s.label} ${s.group}`} onSelect={() => pick(s.run)}>
                <span className="truncate">{s.label}</span>
                <CommandShortcut>{formatKeys(s.keys)}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}

function PaletteSessionItem({ workbench, onSelect }: { workbench: Workbench; onSelect: () => void }) {
  const chats = useWorkbenchStore((s) => s.chats[workbench.id]);
  const unread = useWorkbenchStore((s) => s.unread);
  const pr = usePullRequestStore((s) =>
    workbench.pullRequestId ? s.rows.find((r) => r.id === workbench.pullRequestId) : undefined
  );
  const state = sessionState(workbench, chats ?? [], unread, sessionPr(workbench, pr));

  return (
    <CommandItem
      value={`session ${workbenchDisplayName(workbench)} ${workbench.name} ${workbench.branch} ${workbench.repoFullName} ${workbench.id}`}
      onSelect={onSelect}
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <SessionStateIcon state={state} />
      </span>
      <SlackSessionMark source={slackSourceOf(workbench)} />
      <span className="truncate">{workbenchDisplayName(workbench)}</span>
      <span className="truncate font-mono text-[11px] text-muted-foreground">{workbenchPlaceLabel(workbench)}</span>
    </CommandItem>
  );
}
