import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Inbox,
  ListTodo,
  Settings,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  FolderKanban,
  Github,
  Archive,
  CircleDot,
  Check,
} from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { api, type CloudProviderInfo } from '../../lib/api';
import { useWorkspaceStore } from '../../stores/workspace';
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
    unreadCount,
    inboxView,
    setInboxView,
    tasks,
  } = useWorkspaceStore();

  const { user } = useAuth();

  // Count tasks that need attention (running with high/medium attention)
  const tasksNeedingAttention = tasks.filter(
    (t) => t.status === 'in_progress' && t.agentAttention && t.agentAttention !== 'none'
  ).length;

  // Count running tasks
  const runningTasksCount = tasks.filter((t) => t.status === 'in_progress').length;

  // Both badges (parent 'Inbox' + 'Active' sub-item) count unread items
  // so the numbers match. Read-but-not-actioned items remain visible in
  // the Active pane but don't inflate the attention-count.

  const navItems = [
    {
      id: 'inbox' as const,
      icon: Inbox,
      label: 'Inbox',
      badge: unreadCount > 0 ? unreadCount : undefined,
    },
    {
      id: 'queue' as const,
      icon: ListTodo,
      label: 'Tasks',
      badge: tasksNeedingAttention > 0 ? tasksNeedingAttention : runningTasksCount > 0 ? runningTasksCount : undefined,
      badgeVariant: tasksNeedingAttention > 0 ? 'warning' : 'secondary',
    },
    {
      id: 'github' as const,
      icon: Github,
      label: 'GitHub',
    },
  ];

  return (
    <div
      className={cn(
        'flex flex-col h-full bg-card border-r transition-all duration-200',
        sidebarCollapsed ? 'w-16' : 'w-56',
        className
      )}
    >
      {/* Header / Workspace Selector */}
      <div className="p-3 border-b">
        <WorkspaceSwitcher collapsed={sidebarCollapsed} />
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-2 space-y-1">
        {navItems.map((item) => {
          const isInbox = item.id === 'inbox';
          const showInboxChildren = isInbox && activePanel === 'inbox' && !sidebarCollapsed;
          return (
            <React.Fragment key={item.id}>
              <Button
                variant={activePanel === item.id ? 'secondary' : 'ghost'}
                className={cn(
                  'w-full justify-start gap-3',
                  sidebarCollapsed && 'justify-center px-2'
                )}
                onClick={() => {
                  setActivePanel(item.id);
                  // Default sub-view: clicking Inbox always lands on
                  // "Active" so the user sees what needs attention.
                  if (isInbox) setInboxView('active');
                }}
              >
                <item.icon className="w-4 h-4 flex-shrink-0" />
                {!sidebarCollapsed && (
                  <>
                    <span className="flex-1 text-left">{item.label}</span>
                    {item.badge && (
                      <Badge
                        variant={isInbox ? 'default' : (item.badgeVariant as 'warning' | 'secondary') || 'warning'}
                        className="ml-auto"
                      >
                        {item.badge}
                      </Badge>
                    )}
                  </>
                )}
              </Button>
              {showInboxChildren && (
                <div className="ml-3 border-l pl-2 space-y-1">
                  <Button
                    variant={inboxView === 'active' ? 'secondary' : 'ghost'}
                    size="sm"
                    className="w-full justify-start gap-2 h-8 text-xs"
                    onClick={() => setInboxView('active')}
                  >
                    <CircleDot className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="flex-1 text-left">Active</span>
                    {unreadCount > 0 && (
                      <Badge variant="default" className="ml-auto h-5">
                        {unreadCount}
                      </Badge>
                    )}
                  </Button>
                  <Button
                    variant={inboxView === 'archive' ? 'secondary' : 'ghost'}
                    size="sm"
                    className="w-full justify-start gap-2 h-8 text-xs"
                    onClick={() => setInboxView('archive')}
                  >
                    <Archive className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="flex-1 text-left">Archive</span>
                  </Button>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t p-2">
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
  const { workspaces, currentWorkspaceId, setCurrentWorkspace, setActivePanel } =
    useWorkspaceStore();
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
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <FolderKanban className="h-4 w-4 text-primary" />
        </div>
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
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              <span className="text-xs text-muted-foreground">{w.repos.length}</span>
            </button>
          ))}
          <div className="my-1 border-t" />
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
 * Cloud-provider connection status, shown just above the user chip. One row
 * per registered cloud provider with a dot: green = connected (credentials
 * configured for this workspace), grey = not connected.
 */
function CloudProviderStatus({ collapsed }: { collapsed: boolean }) {
  const { currentWorkspaceId } = useWorkspaceStore();
  const [providers, setProviders] = useState<CloudProviderInfo[]>([]);

  const refresh = useCallback(() => {
    if (!currentWorkspaceId) {
      setProviders([]);
      return;
    }
    api.cloudProviders
      .list(currentWorkspaceId)
      .then(setProviders)
      .catch(() => setProviders([]));
  }, [currentWorkspaceId]);

  useEffect(() => {
    refresh();
    // Re-check when a provider's env marker is (re)provisioned or its status
    // changes — e.g. right after the user connects credentials in Settings.
    const offCreated = api.ws.on('environment:created', refresh);
    const offStatus = api.ws.on('environment:status', refresh);
    return () => {
      offCreated();
      offStatus();
    };
  }, [refresh]);

  if (providers.length === 0) return null;

  return (
    <div
      className={cn(
        'mb-2 flex flex-col gap-0.5 border-b pb-2',
        collapsed && 'items-center',
      )}
    >
      {providers.map((p) => (
        <div
          key={p.type}
          title={`${p.displayName} — ${p.connected ? 'connected' : 'not connected'}`}
          className={cn(
            'flex items-center gap-2 rounded-md text-xs text-muted-foreground',
            collapsed ? 'h-6 w-6 justify-center' : 'px-2 py-1',
          )}
        >
          <span
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              p.connected ? 'bg-green-500' : 'bg-muted-foreground/40',
            )}
          />
          {!collapsed && <span className="min-w-0 flex-1 truncate">{p.displayName}</span>}
        </div>
      ))}
    </div>
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
      title={`Signed in as @${username} — click for account settings`}
      className={cn(
        'flex items-center gap-2 text-sm rounded-md hover:bg-accent transition-colors',
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
    </button>
  );
}
