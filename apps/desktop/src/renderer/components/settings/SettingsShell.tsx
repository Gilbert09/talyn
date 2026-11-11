import { useState, type ComponentType } from 'react';
import {
  Bot,
  Box,
  Brain,
  Bug,
  CreditCard,
  FileText,
  FolderGit2,
  FolderKanban,
  GitPullRequest,
  Info,
  Keyboard,
  MessageSquare,
  Network,
  Palette,
  KeyRound,
  Plug,
  PlugZap,
  ScanSearch,
  Search,
  Settings,
  SquareTerminal,
  User,
  Users,
  Wand2,
} from 'lucide-react';
import { mcpServersOffered, privateRoutesOffered, workbenchesOffered, type IntegrationKind } from '@talyn/shared';
import { useNavigationStore } from '../../stores/navigation';
import { TeamsSettings } from './sections/TeamsSettings';
import { spacesOffered } from '../../lib/spaces';
import { cn } from '../../lib/utils';
import { useBillingStore } from '../../stores/billing';
import { hasUsageBilling } from '../../lib/usageBilling';
import { useWorkspaceStore, type SettingsSection } from '../../stores/workspace';
import { CodeReviewSettingsCard } from '../panels/codeReview/CodeReviewSettingsCard';
import { McpServersPanel } from '../panels/mcpServers/McpServersPanel';
import { SkillsSettings } from '../panels/SkillsSettings';
import { TeamSettings } from '../panels/TeamBilling';
import { InstructionsPage } from './InstructionsPage';
import { MemoryPage } from './MemoryPage';
import { PageHeader } from '../ui/page-header';
import { ScrollArea } from '../ui/scroll-area';
import { SettingsPage } from '../ui/settings';
import { AboutSettings } from './sections/AboutSettings';
import { AccountSettings } from './sections/AccountSettings';
import { AgentsSettings } from './sections/AgentsSettings';
import { AppearanceSettings } from './sections/AppearanceSettings';
import { BillingSettings } from './sections/BillingSettings';
import { DeveloperSettings } from './sections/DeveloperSettings';
import { IntegrationsSettings } from './sections/IntegrationsSettings';
import { MCPServerSettings } from './sections/McpSettings';
import { ApiTokensSettings } from './sections/ApiTokensSettings';
import { PullRequestsSettings } from './sections/PullRequestsSettings';
import { RepositoriesSettings } from './sections/RepositoriesSettings';
import { SandboxSetupSettings } from './sections/SandboxSetupSettings';
import { SessionsSettings } from './sections/SessionsSettings';
import { ShortcutsSettings } from './sections/ShortcutsSettings';
import { WorkspaceSettings } from './sections/WorkspaceSettings';

interface NavEntry {
  id: SettingsSection;
  icon: ComponentType<{ className?: string }>;
  label: string;
}

const SETTINGS_SEARCH_TERMS: Record<SettingsSection, string> = {
  sessions: 'defaults runtime agent model reasoning effort plan mode internet access notifications archive idle branch prefix sidebar order usage limits',
  agents: 'Claude Codex subscriptions accounts providers API keys models usage rate limits',
  repositories: 'GitHub watched repositories local checkouts scan setup run command preview',
  sandboxSetup: 'dotfiles setup steps install commands branch repository',
  privateRoutes: 'Tailscale tailnet connector destinations hostname IP TCP port devices',
  shortcuts: 'keyboard hotkeys keys navigation',
  instructions: 'AGENTS.md CLAUDE.md prompts templates plan implement review fix repository files',
  memory: 'notes session remember forget review clean up cleanup schedule overlap contradict',
  skills: 'SKILL.md local repository workspace tools',
  mcpServers: 'model context protocol tools servers integrations',
  pullRequests: 'auto keep mergeable fix runs tasks defaults model notifications merge queue blocked labels human comments',
  codeReview: 'automatic reviews depth reviewers attention findings fixes inline comments summary',
  workspace: 'name logo delete',
  integrations: 'GitHub Anthropic Claude Codex PostHog providers API keys connect',
  slack: 'workspace bot emoji invite sessions channel',
  teams: 'members roles invite spaces home workspace seats',
  billing: 'plan usage box hours limits upgrade invoices orders payment auto top-up balance',
  account: 'email sign out privacy analytics usage data session replays',
  appearance: 'theme light dark system look',
  developer: 'build version commit GitHub rate limits events account delete data local storage',
  mcp: 'Claude Desktop Claude Code token command model context protocol',
  apiTokens: 'developer API access keys token scopes expiry revoke',
  about: 'version update changelog release notes software',
};

function matchesSearch(entry: NavEntry, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = `${entry.label} ${SETTINGS_SEARCH_TERMS[entry.id]}`.toLocaleLowerCase();
  return terms.every((term) => text.includes(term));
}

// These render their own content but no page title.
function SkillsPage() {
  return (
    <SettingsPage title="Skills">
      <SkillsSettings />
    </SettingsPage>
  );
}

function CodeReviewPage() {
  return (
    <SettingsPage title="Code review">
      <CodeReviewSettingsCard />
    </SettingsPage>
  );
}

function MovedToIntegrations({
  title,
  kind,
  text,
}: {
  title: string;
  kind: IntegrationKind;
  text: string;
}) {
  const navigate = useNavigationStore((s) => s.navigate);
  return (
    <SettingsPage title={title}>
      <p className="text-xs text-muted-foreground">
        {text}{' '}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => navigate({ view: 'integrations', kind })}
        >
          Moved to Integrations
        </button>
      </p>
    </SettingsPage>
  );
}

function SlackPage() {
  return <MovedToIntegrations title="Slack" kind="slack" text="Slack settings are now the Slack integration." />;
}

function PrivateRoutesPage() {
  return (
    <MovedToIntegrations
      title="Private routes"
      kind="tailscale"
      text="Private routes are now the Tailscale integration."
    />
  );
}

function McpServersPage() {
  const features = useWorkspaceStore((s) => s.features);
  if (!mcpServersOffered(features)) return null;
  return <McpServersPanel />;
}

function SandboxSetupPage() {
  const features = useWorkspaceStore((s) => s.features);
  if (!workbenchesOffered(features)) return null;
  return <SandboxSetupSettings />;
}

function TeamPage() {
  const offered = useWorkspaceStore((s) => spacesOffered(s.features));
  if (offered) return <TeamsSettings />;
  return (
    <SettingsPage title="Team">
      <TeamSettings />
    </SettingsPage>
  );
}

// Sections that fill the pane and scroll their own body, like the MCP servers
// panel with its fixed toolbar. The others scroll as one page.
const FULL_HEIGHT_SECTIONS: ReadonlySet<SettingsSection> = new Set(['mcpServers']);

const SECTION_BODY: Record<SettingsSection, ComponentType> = {
  sessions: SessionsSettings,
  agents: AgentsSettings,
  repositories: RepositoriesSettings,
  sandboxSetup: SandboxSetupPage,
  privateRoutes: PrivateRoutesPage,
  shortcuts: ShortcutsSettings,
  instructions: InstructionsPage,
  memory: MemoryPage,
  skills: SkillsPage,
  pullRequests: PullRequestsSettings,
  codeReview: CodeReviewPage,
  workspace: WorkspaceSettings,
  integrations: IntegrationsSettings,
  slack: SlackPage,
  teams: TeamPage,
  billing: BillingSettings,
  account: AccountSettings,
  appearance: AppearanceSettings,
  developer: DeveloperSettings,
  mcpServers: McpServersPage,
  mcp: MCPServerSettings,
  apiTokens: ApiTokensSettings,
  about: AboutSettings,
};

export function SettingsShell() {
  // Section lives in the store so other surfaces (e.g. the sidebar cloud-provider
  // status, the per-task "Set default" action) can deep-link to a section.
  const activeSection = useWorkspaceStore((s) => s.settingsSection);
  const setActiveSection = useWorkspaceStore((s) => s.setSettingsSection);
  const features = useWorkspaceStore((s) => s.features);
  const billingStatus = useBillingStore((s) => s.status);
  const [search, setSearch] = useState('');

  const groups: Array<{ label: string; entries: NavEntry[] }> = [
    {
      label: 'Coding',
      entries: [
        { id: 'sessions', icon: SquareTerminal, label: 'Sessions' },
        { id: 'agents', icon: Bot, label: 'Agents' },
        { id: 'repositories', icon: FolderGit2, label: 'Repositories' },
        ...(workbenchesOffered(features)
          ? [{ id: 'sandboxSetup' as const, icon: Box, label: 'Sandbox setup' }]
          : []),
        ...(privateRoutesOffered(features)
          ? [{ id: 'privateRoutes' as const, icon: Network, label: 'Private routes' }]
          : []),
        { id: 'shortcuts', icon: Keyboard, label: 'Shortcuts' },
        { id: 'instructions', icon: FileText, label: 'Instructions' },
        ...(workbenchesOffered(features)
          ? [{ id: 'memory' as const, icon: Brain, label: 'Memory' }]
          : []),
        { id: 'skills', icon: Wand2, label: 'Skills' },
        // Gated in the NAV, not only in the body: the page renders null when the
        // feature is not offered, so an unconditional entry would open onto nothing.
        ...(mcpServersOffered(features)
          ? [{ id: 'mcpServers' as const, icon: PlugZap, label: 'MCP servers' }]
          : []),
      ],
    },
    {
      label: 'Pull requests',
      entries: [
        { id: 'pullRequests', icon: GitPullRequest, label: 'Pull requests' },
        { id: 'codeReview', icon: ScanSearch, label: 'Code review' },
      ],
    },
    {
      label: 'Workspace',
      entries: [
        { id: 'workspace', icon: FolderKanban, label: 'Workspace' },
        { id: 'integrations', icon: Settings, label: 'Integrations' },
        // Slack starts sessions, so it shares the workbenches flag.
        ...(workbenchesOffered(features)
          ? [{ id: 'slack' as const, icon: MessageSquare, label: 'Slack' }]
          : []),
        // Drawn for anyone the flag offers teams to, and for anyone already on a
        // team whatever the flag says: a seated member must always be able to
        // see who pays for them, and leave.
        ...(spacesOffered(features) || features?.teams === true || billingStatus?.team
          ? [{ id: 'teams' as const, icon: Users, label: spacesOffered(features) ? 'Teams' : 'Team' }]
          : []),
        { id: 'billing', icon: CreditCard, label: hasUsageBilling(billingStatus) ? 'Plan and usage' : 'Billing' },
      ],
    },
    {
      label: 'App',
      entries: [
        { id: 'account', icon: User, label: 'Account' },
        { id: 'appearance', icon: Palette, label: 'Appearance' },
        { id: 'developer', icon: Bug, label: 'Developer' },
        { id: 'mcp', icon: Plug, label: 'Talyn MCP server' },
        // The body also lists existing tokens when the flag is off, but the nav
        // entry follows the flag.
        ...(features?.publicApi === true
          ? [{ id: 'apiTokens' as const, icon: KeyRound, label: 'API tokens' }]
          : []),
        { id: 'about', icon: Info, label: 'About' },
      ],
    },
  ];

  const filteredGroups = groups
    .map((group) => ({
      ...group,
      entries: group.entries.filter((entry) => matchesSearch(entry, search)),
    }))
    .filter((group) => group.entries.length > 0);

  const Body = SECTION_BODY[activeSection];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Settings" />
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-48 shrink-0 flex-col border-r" aria-label="Settings sections">
          <div className="border-b p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                aria-label="Search settings"
                placeholder="Search settings"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setSearch('');
                }}
                className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto p-2">
            {filteredGroups.map((group) => (
              <div key={group.label} className="space-y-0.5">
                <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </p>
                {group.entries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setActiveSection(entry.id)}
                    aria-current={activeSection === entry.id ? 'page' : undefined}
                    className={cn(
                      'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors',
                      activeSection === entry.id
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                  >
                    <entry.icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{entry.label}</span>
                  </button>
                ))}
              </div>
            ))}
            {filteredGroups.length === 0 && (
              <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
                No settings found.
              </p>
            )}
          </div>
        </nav>

        <div className="min-w-0 flex-1 overflow-hidden">
          {FULL_HEIGHT_SECTIONS.has(activeSection) ? (
            <div className="h-full">{Body ? <Body /> : null}</div>
          ) : (
            <ScrollArea className="h-full">
              {Body ? <Body /> : null}
            </ScrollArea>
          )}
        </div>
      </div>
    </div>
  );
}
