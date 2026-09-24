import { useEffect, useRef, useState } from 'react';
import {
  cloudProviderStatus,
  loopsOffered,
  mcpServersOffered,
  workflowsOffered,
  type CloudProviderTone,
} from '@talyn/shared';
import {
  ListTodo,
  Settings,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  GitPullRequest,
  GitMerge,
  Eye,
  Plug,
  Repeat,
  Workflow,
  Check,
  Plus,
  Download,
} from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import type { UpdaterEvent } from '../../../main/updaterEvents';
import { cn, isMacDesktop } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { WorkspaceLogo } from '../widgets/WorkspaceLogo';
import { ProviderIcon } from '../../lib/providerMeta';
import { CLAUDE_LOGO, CODEX_LOGO } from '../../assets/providers/logos';
import { useWorkspaceStore } from '../../stores/workspace';
import { usePullRequestStore } from '../../stores/pullRequests';
import { visibleReviewCohort } from '../panels/github/reviewHidden';
import { useIsDevBuild } from '../../hooks/useIsDevBuild';
import { useAuth } from '../auth/AuthProvider';

interface SidebarProps {
  className?: string;
}

export function Sidebar({ className }: SidebarProps) {
  const {
    sidebarCollapsed,
    toggleSidebar,
    activePanel,
    setActivePanel,
    tasks,
    features,
    enabledWorkflowCount,
    enabledLoopCount,
    enabledMcpServerCount,
  } = useWorkspaceStore();

  const { user } = useAuth();

  // Count running tasks
  const runningTasksCount = tasks.filter((t) => t.status === 'in_progress').length;

  // Live PR counts for the three GitHub nav badges. The PR store is kept
  // current by usePullRequestSync, so these re-render on every WS update.
  const prRows = usePullRequestStore((s) => s.rows);
  // My PRs holds `authored || watching` — a manually tracked PR renders
  // there, so the badge must count it or it disagrees with the page.
  const myPrCount = prRows.filter((r) => r.authored || r.watching).length;
  // Through the page's own rule, not a copy of it: a badge that keeps counting
  // a PR the list has dropped is the nag the user was dismissing.
  const reviewCount = visibleReviewCohort(prRows).length;
  const queueCount = prRows.filter((r) => r.mergeQueued).length;

  /**
   * The two kinds of number in this nav, which used to look identical.
   *
   * `work` counts things happening TO you — PRs with your name on them, a
   * queue draining, runs in flight. It moves without you and a jump in it is
   * news. `inventory` counts things you MADE: workflows, loops, MCP servers.
   * It changes only when you change it, so it is a fact about your setup
   * rather than a call to look.
   *
   * Drawn as the same pill, seven numbers read as seven demands — Tom's word
   * was "overwhelming" — and the loudest of them (84 review requests) is the
   * one least likely to mean "do something now". So inventory keeps its count
   * and gives up the pill: same information, a quarter of the weight.
   */
  const navItems = [
    {
      id: 'my_prs' as const,
      icon: GitPullRequest,
      label: 'My PRs',
      badge: myPrCount > 0 ? myPrCount : undefined,
      badgeKind: 'work' as const,
    },
    {
      id: 'reviews' as const,
      icon: Eye,
      label: 'Reviews',
      badge: reviewCount > 0 ? reviewCount : undefined,
      badgeKind: 'work' as const,
    },
    {
      id: 'merge_queue' as const,
      icon: GitMerge,
      label: 'Merge Queue',
      badge: queueCount > 0 ? queueCount : undefined,
      badgeKind: 'work' as const,
    },
    {
      id: 'queue' as const,
      icon: ListTodo,
      label: 'Tasks',
      badge: runningTasksCount > 0 ? runningTasksCount : undefined,
      badgeKind: 'work' as const,
    },
    // Workflows is allow-listed. `features === null` is STILL LOADING and must
    // render nothing, exactly like `cloudProviderOffered` — treating it as
    // "off" and then flipping would flash the item in on every launch.
    ...(workflowsOffered(features)
      ? [
          {
            id: 'workflows' as const,
            icon: Workflow,
            label: 'Workflows',
            // Enabled rules only — a disabled workflow is not automation that
            // is running, so counting it would overstate what the app is doing
            // on the user's behalf. `null` is not yet counted and draws
            // nothing, so the badge never flashes in at 0 and then corrects.
            badge: enabledWorkflowCount ? enabledWorkflowCount : undefined,
            badgeKind: 'inventory' as const,
          },
        ]
      : []),
    // Loops, gated the same three-state way. The flag fails CLOSED on the
    // backend, so most workspaces answer `false` here and draw nothing.
    ...(loopsOffered(features)
      ? [
          {
            id: 'loops' as const,
            icon: Repeat,
            label: 'Loops',
            // Enabled loops only: a paused loop is not a schedule that is
            // running, and counting it would overstate what the app is doing
            // unattended — which is the one thing this feature does.
            badge: enabledLoopCount ? enabledLoopCount : undefined,
            badgeKind: 'inventory' as const,
          },
        ]
      : []),
    // MCP servers, gated the same three-state way and failing CLOSED for a
    // reason of its own: that page stores third-party credentials, so drawing
    // it during a PostHog outage would offer credential storage to accounts
    // nobody decided to offer it to.
    ...(mcpServersOffered(features)
      ? [
          {
            id: 'mcp_servers' as const,
            icon: Plug,
            label: 'MCP servers',
            // Enabled only: a switched-off server is not one the agents have,
            // and counting it would overstate what a run can reach.
            badge: enabledMcpServerCount ? enabledMcpServerCount : undefined,
            badgeKind: 'inventory' as const,
          },
        ]
      : []),
  ];

  return (
    <div
      className={cn(
        'flex flex-col h-full bg-card border-r transition-all duration-200',
        sidebarCollapsed ? 'w-16' : 'w-56',
        className
      )}
    >
      {/* macOS frameless window: the inset traffic lights float over this
          strip, which doubles as the window's drag handle. Kept just tall
          enough to clear the lights so the workspace picker hugs them. */}
      {isMacDesktop && (
        <div aria-hidden className="app-region-drag h-6 shrink-0" />
      )}

      {/* Header / Workspace Selector */}
      <div className="p-3 border-b">
        <WorkspaceSwitcher collapsed={sidebarCollapsed} />
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-2 space-y-1">
        {navItems.map((item) => (
          <Button
            key={item.id}
            data-attr={`nav-${item.id}`}
            variant={activePanel === item.id ? 'secondary' : 'ghost'}
            className={cn(
              'w-full justify-start gap-3',
              sidebarCollapsed && 'justify-center px-2'
            )}
            onClick={() => setActivePanel(item.id)}
          >
            <item.icon className="w-4 h-4 flex-shrink-0" />
            {!sidebarCollapsed && (
              <>
                <span className="flex-1 text-left">{item.label}</span>
                {item.badge !== undefined &&
                  (item.badgeKind === 'work' ? (
                    <Badge variant="secondary" className="ml-auto">
                      {item.badge}
                    </Badge>
                  ) : (
                    // No pill, no background, one size down and the muted
                    // foreground: it reads as a label on the row rather than
                    // as a count demanding to be cleared. `tabular-nums` so a
                    // count going 9 → 10 does not shift the row.
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground/70">
                      {item.badge}
                    </span>
                  ))}
              </>
            )}
          </Button>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t p-2">
        <UpdateNotice collapsed={sidebarCollapsed} />
        <CloudProviderStatus collapsed={sidebarCollapsed} />
        <div
          className={cn(
            'flex items-center gap-1',
            sidebarCollapsed && 'flex-col',
          )}
        >
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 flex-shrink-0"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </Button>
          {user && (
            <UserChip
              user={user}
              collapsed={sidebarCollapsed}
              onClick={() => setActivePanel('settings')}
            />
          )}
          {!sidebarCollapsed && (
            <Button
              variant={activePanel === 'settings' ? 'secondary' : 'ghost'}
              size="icon"
              className="h-8 w-8 flex-shrink-0"
              onClick={() => setActivePanel('settings')}
              aria-label="Settings"
              title="Settings"
            >
              <Settings className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Top-of-sidebar workspace switcher. Shows the active workspace and opens a
 * dropdown to switch between the user's workspaces, plus a shortcut into the
 * Workspace settings (where create / rename / delete live).
 */
function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const {
    workspaces,
    currentWorkspaceId,
    setCurrentWorkspace,
    setActivePanel,
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
          'flex w-full items-center gap-2 rounded-md p-1 text-left transition-colors hover:bg-accent',
          collapsed && 'justify-center',
        )}
      >
        <WorkspaceLogo
          logo={current?.logo}
          fallbackSeed={current?.id ?? 'talyn'}
          size={32}
          className="flex-shrink-0"
        />
        {!collapsed && (
          <>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{current?.name || 'No Workspace'}</p>
              <p className="truncate text-xs text-muted-foreground">
                {current ? `${current.repos.length} repos` : 'Select a workspace'}
              </p>
            </div>
            <ChevronsUpDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
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
              setActivePanel('settings');
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

/**
 * Auto-update notice, shown at the very top of the sidebar footer (above the
 * cloud-provider status and the user chip). Stays invisible until the main
 * process reports a download in progress or a downloaded update ready to
 * apply. Clicking the "ready" state quits and relaunches into the new version.
 */
function UpdateNotice({ collapsed }: { collapsed: boolean }) {
  const [state, setState] = useState<UpdaterEvent | null>(null);

  useEffect(() => {
    return window.electron?.updater?.onEvent(setState);
  }, []);

  if (!state) return null;

  if (state.kind === 'progress') {
    return collapsed ? (
      <div
        title={`Downloading update… ${state.percent}%`}
        className="mb-2 flex h-6 items-center justify-center border-b pb-2"
      >
        <Download className="h-4 w-4 animate-pulse text-muted-foreground" />
      </div>
    ) : (
      <div className="mb-2 flex items-center gap-2 border-b px-2 pb-2 text-xs text-muted-foreground">
        <Download className="h-3.5 w-3.5 shrink-0 animate-pulse" />
        <span className="min-w-0 flex-1 truncate">
          Downloading update… {state.percent}%
        </span>
      </div>
    );
  }

  if (state.kind === 'downloaded') {
    const apply = () => window.electron?.updater?.quitAndInstall();
    return collapsed ? (
      <button
        type="button"
        onClick={apply}
        title={`Update ${state.version} ready — restart now, or Talyn installs it once you've been away for a while`}
        className="mb-2 flex h-6 w-full items-center justify-center border-b pb-2 text-green-600 hover:text-green-500"
      >
        <Download className="h-4 w-4" />
      </button>
    ) : (
      <button
        type="button"
        onClick={apply}
        title={`Restart now to install version ${state.version}. Otherwise Talyn installs it by itself once you've been away from your machine for a while.`}
        className="mb-2 flex w-full items-center gap-2 rounded-md border-b px-2 pb-2 text-xs text-green-600 hover:text-green-500"
      >
        <Download className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">
          Update ready — Restart
        </span>
      </button>
    );
  }

  // checking / not-available / error: nothing to surface in the sidebar.
  return null;
}

const FLEET_AGENT_LOGOS: Record<string, string> = { claude: CLAUDE_LOGO, codex: CODEX_LOGO };

function CloudProviderStatus({ collapsed }: { collapsed: boolean }) {
  const providers = useWorkspaceStore((s) => s.cloudProviders);
  const openSettings = useWorkspaceStore((s) => s.openSettings);

  if (!providers || providers.length === 0) return null;

  return (
    <div className={cn('mb-2 border-b pb-2', collapsed && 'flex flex-col items-center gap-1')}>
      {!collapsed && (
        <p className="px-4 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
          Agents
        </p>
      )}
      {providers.map((p) => {
        const status = cloudProviderStatus(p);
        const title = `${p.displayName}: ${status.detail}`;
        const dimmed = status.tone === 'disconnected';
        if (collapsed) {
          return (
            <button
              key={p.type}
              type="button"
              onClick={() => openSettings('integrations')}
              title={title}
              aria-label={title}
              className="relative flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-accent"
            >
              <ProviderIcon
                provider={p.type}
                label={title}
                className={cn('h-4 w-4', dimmed && 'opacity-40 grayscale')}
              />
              <StatusDot tone={status.tone} className="absolute bottom-1 right-1 ring-2 ring-card" />
            </button>
          );
        }
        return (
          <button
            key={p.type}
            type="button"
            onClick={() => openSettings('integrations')}
            title={title}
            className="group flex h-7 w-full items-center gap-3 rounded-md px-4 text-xs transition-colors hover:bg-accent"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              <ProviderIcon
                provider={p.type}
                label={title}
                className={cn('h-3.5 w-3.5', dimmed && 'opacity-40 grayscale')}
              />
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-left',
                dimmed ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              {p.displayName}
            </span>
            {status.agents.map((agent) =>
              FLEET_AGENT_LOGOS[agent] ? (
                <img
                  key={agent}
                  src={FLEET_AGENT_LOGOS[agent]}
                  alt=""
                  aria-hidden
                  draggable={false}
                  className="h-3 w-3 shrink-0 rounded-[2px] object-contain"
                />
              ) : null,
            )}
            {status.tone === 'connected' ? (
              <StatusDot tone="connected" className="ring-[3px] ring-green-500/20" />
            ) : (
              <span
                className={cn(
                  'text-[10px] font-medium',
                  status.tone === 'reauth'
                    ? 'text-amber-500'
                    : 'text-muted-foreground/60 group-hover:text-foreground',
                )}
              >
                {status.tone === 'reauth' ? 'Reconnect' : 'Connect'}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function StatusDot({ tone, className }: { tone: CloudProviderTone; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        tone === 'connected' && 'bg-green-500',
        tone === 'reauth' && 'bg-amber-500',
        tone === 'disconnected' && 'bg-muted-foreground/40',
        className,
      )}
    />
  );
}

interface UserChipProps {
  user: User;
  collapsed: boolean;
  onClick: () => void;
}

/**
 * Bottom-of-sidebar identity chip. Shows the GitHub avatar + username
 * so users on machines with multiple GitHub accounts can see which
 * one is signed in at a glance. Clicking opens the Settings → Account
 * panel, which is where the Sign-out action lives.
 */
function UserChip({ user, collapsed, onClick }: UserChipProps) {
  const isDev = useIsDevBuild();
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  // GitHub's Supabase provider fills `user_name`; fall back to
  // `preferred_username` and finally the email local-part so something
  // meaningful always renders.
  const username =
    (typeof meta.user_name === 'string' && meta.user_name) ||
    (typeof meta.preferred_username === 'string' && meta.preferred_username) ||
    (user.email?.split('@')[0] ?? 'user');
  const avatarUrl =
    typeof meta.avatar_url === 'string' ? meta.avatar_url : undefined;
  const initials = username.slice(0, 1).toUpperCase();

  return (
    <button
      type="button"
      onClick={onClick}
      title={
        isDev
          ? `DEV build — signed in as @${username}. Click for account settings`
          : `Signed in as @${username} — click for account settings`
      }
      className={cn(
        'flex items-center gap-2 text-sm rounded-md transition-colors',
        // Dev builds get an amber chip so it's obvious at a glance you're not
        // looking at production data.
        isDev
          ? 'bg-amber-400/25 ring-1 ring-inset ring-amber-500/40 hover:bg-amber-400/35'
          : 'hover:bg-accent',
        collapsed
          ? 'h-8 w-8 justify-center flex-shrink-0'
          : 'flex-1 min-w-0 px-2 py-1.5',
      )}
    >
      <span className="relative flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="h-full w-full object-cover"
            // GitHub avatar hosts can fail transiently; fall back to the
            // initials bubble rather than a broken-image icon.
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          initials
        )}
      </span>
      {!collapsed && (
        <span className="min-w-0 flex-1 truncate text-left">
          @{username}
        </span>
      )}
      {!collapsed && isDev && (
        <span className="shrink-0 rounded bg-amber-500 px-1 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide text-amber-950">
          Dev
        </span>
      )}
    </button>
  );
}
