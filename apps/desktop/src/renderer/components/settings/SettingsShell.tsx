import type { ComponentType } from 'react';
import {
  Bot,
  Bug,
  CreditCard,
  FileText,
  FolderGit2,
  FolderKanban,
  GitPullRequest,
  Info,
  Keyboard,
  MessageSquare,
  Palette,
  Plug,
  PlugZap,
  ScanSearch,
  Settings,
  SquareTerminal,
  User,
  Users,
  Wand2,
} from 'lucide-react';
import { mcpServersOffered, workbenchesOffered } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { useBillingStore } from '../../stores/billing';
import { useWorkspaceStore, type SettingsSection } from '../../stores/workspace';
import { CodeReviewSettingsCard } from '../panels/codeReview/CodeReviewSettingsCard';
import { InstructionsSettings } from '../panels/InstructionsSettings';
import { McpServersPanel } from '../panels/mcpServers/McpServersPanel';
import { SkillsSettings } from '../panels/SkillsSettings';
import { SlackSettings } from '../panels/SlackSettings';
import { TeamSettings } from '../panels/TeamBilling';
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
import { PullRequestsSettings } from './sections/PullRequestsSettings';
import { RepositoriesSettings } from './sections/RepositoriesSettings';
import { SessionsSettings } from './sections/SessionsSettings';
import { ShortcutsSettings } from './sections/ShortcutsSettings';
import { WorkspaceSettings } from './sections/WorkspaceSettings';

interface NavEntry {
  id: SettingsSection;
  icon: ComponentType<{ className?: string }>;
  label: string;
}

// These render their own content but no page title.
function SkillsPage() {
  return (
    <SettingsPage title="Skills">
      <SkillsSettings />
    </SettingsPage>
  );
}

function InstructionsPage() {
  return (
    <SettingsPage title="Instructions">
      <InstructionsSettings />
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

// SlackSettings draws its own heading, so it gets the page padding without a title.
function SlackPage() {
  return (
    <div className="mx-auto max-w-xl px-6 py-5">
      <SlackSettings />
    </div>
  );
}

function McpServersPage() {
  const features = useWorkspaceStore((s) => s.features);
  if (!mcpServersOffered(features)) return null;
  return <McpServersPanel />;
}

function TeamPage() {
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
  shortcuts: ShortcutsSettings,
  instructions: InstructionsPage,
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
  about: AboutSettings,
};

export function SettingsShell() {
  // Section lives in the store so other surfaces (e.g. the sidebar cloud-provider
  // status, the per-task "Set default" action) can deep-link to a section.
  const activeSection = useWorkspaceStore((s) => s.settingsSection);
  const setActiveSection = useWorkspaceStore((s) => s.setSettingsSection);
  const features = useWorkspaceStore((s) => s.features);
  const billingStatus = useBillingStore((s) => s.status);

  const groups: Array<{ label: string; entries: NavEntry[] }> = [
    {
      label: 'Coding',
      entries: [
        { id: 'sessions', icon: SquareTerminal, label: 'Sessions' },
        { id: 'agents', icon: Bot, label: 'Agents' },
        { id: 'repositories', icon: FolderGit2, label: 'Repositories' },
        { id: 'shortcuts', icon: Keyboard, label: 'Shortcuts' },
        { id: 'instructions', icon: FileText, label: 'Instructions' },
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
        ...(features?.teams === true || billingStatus?.team
          ? [{ id: 'teams' as const, icon: Users, label: 'Team' }]
          : []),
        { id: 'billing', icon: CreditCard, label: 'Billing' },
      ],
    },
    {
      label: 'App',
      entries: [
        { id: 'account', icon: User, label: 'Account' },
        { id: 'appearance', icon: Palette, label: 'Appearance' },
        { id: 'developer', icon: Bug, label: 'Developer' },
        { id: 'mcp', icon: Plug, label: 'Talyn MCP server' },
        { id: 'about', icon: Info, label: 'About' },
      ],
    },
  ];

  const Body = SECTION_BODY[activeSection];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Settings" />
      <div className="flex min-h-0 flex-1">
        <nav className="w-48 shrink-0 space-y-4 overflow-y-auto border-r p-2">
          {groups.map((group) => (
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
