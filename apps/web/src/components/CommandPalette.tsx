import { useMemo, useSyncExternalStore } from 'react';
import { GitPullRequest, History, Home, Settings, Workflow } from 'lucide-react';
import { codeReviewOffered, mcpServersOffered, workbenchDisplayName, workbenchesOffered, type Workbench } from '@talyn/shared';
import { formatKeys, getShortcuts, shortcutEnabled, subscribeShortcuts, type Shortcut } from '../lib/shortcuts';
import { sessionPr, sessionState } from '../lib/sessionState';
import { useNavigationStore, type Route, PR_TABS } from '../stores/navigation';
import { usePullRequestStore } from '../stores/pullRequests';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore, type SettingsSection } from '../stores/workspace';
import { AUTOMATION_TAB_LABEL, PR_PAGE_TABS, PR_TAB_LABEL, offeredAutomationTabs } from '../lib/routeLabels';
import { groupByRepository, isArchived, useWorkspaceWorkbenches } from './workbench/workbenchSelectors';
import { openNewWorkbench } from './workbench/new/openNewWorkbench';
import { SessionStateIcon } from './workbench/WorkbenchBadges';
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
  integrations: 'Integrations',
  skills: 'Skills',
  instructions: 'Instructions',
  codeReview: 'Code review',
  account: 'Account',
  billing: 'Billing',
  teams: 'Teams',
  appearance: 'Appearance',
  developer: 'Developer',
  mcp: 'Talyn MCP server',
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
  useSyncExternalStore(subscribeVersion, readVersion);

  const workbenches = useMemo(
    () => groupByRepository(all.filter((w) => !isArchived(w)))
      .flatMap((g) => g.items)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [all]
  );

  const navItems = useMemo<NavItem[]>(() => {
    const items: NavItem[] = [{ key: 'home', label: 'Home', icon: Home, route: { view: 'home' } }];
    if (workbenchesOffered(features)) {
      items.push({ key: 'history', label: 'History', icon: History, route: { view: 'history' } });
    }
    for (const tab of PR_TABS) {
      if (tab === 'code_reviews' && !codeReviewOffered(features)) continue;
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
    if (mcpServersOffered(features)) {
      items.push({ key: 'mcp_servers', label: 'MCP servers', icon: Settings, route: { view: 'mcp_servers' } });
    }
    for (const section of Object.keys(SETTINGS_LABEL) as SettingsSection[]) {
      if (section === 'sessions' && !workbenchesOffered(features)) continue;
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
      <CommandInput placeholder="Search sessions, pages and actions…" autoFocus />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        {workbenchesOffered(features) && workbenches.length > 0 && (
          <CommandGroup heading="Sessions">
            {workbenches.map((wb) => (
              <PaletteSessionItem key={wb.id} workbench={wb} onSelect={() => pick(() => navigate({ view: 'workbench', id: wb.id }))} />
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
      <span className="truncate">{workbenchDisplayName(workbench)}</span>
      <span className="truncate font-mono text-[11px] text-muted-foreground">{workbench.repoFullName}</span>
    </CommandItem>
  );
}
