import type { ReactNode } from 'react';
import { codeReviewOffered, workbenchesOffered } from '@talyn/shared';
import {
  ChevronLeft,
  ChevronRight,
  FolderPlus,
  Eye,
  GitMerge,
  GitPullRequest,
  History,
  Plus,
  Search,
  Settings,
  Workflow,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatKeys } from '../../lib/shortcuts';
import { PR_PAGE_TABS, offeredAutomationTabs } from '../../lib/routeLabels';
import { useWorkspaceStore } from '../../stores/workspace';
import { useNavigationStore } from '../../stores/navigation';
import { usePrBadgeCounts } from '../../hooks/usePrBadgeCounts';
import { useAuth } from '../auth/AuthProvider';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { useWorkspaceWorkbenches } from '../workbench/workbenchSelectors';
import { openNewWorkbench } from '../workbench/new/openNewWorkbench';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { SidebarWorkbenchList } from './SidebarWorkbenchList';
import { CloudProviderStatus } from './CloudProviderStatus';
import { UserChip } from './UserChip';

export function AppSidebar() {
  const collapsed = useWorkspaceStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar);
  const features = useWorkspaceStore((s) => s.features);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const route = useNavigationStore((s) => s.route);
  const navigate = useNavigationStore((s) => s.navigate);
  const setPaletteOpen = useNavigationStore((s) => s.setPaletteOpen);
  const setAddRepositoryOpen = useNavigationStore((s) => s.setAddRepositoryOpen);
  const workbenches = useWorkspaceWorkbenches();
  const { user } = useAuth();

  const offered = workbenchesOffered(features);
  const prCounts = usePrBadgeCounts(codeReviewOffered(features));
  const automationTabs = offeredAutomationTabs(features);

  const newWorkbench = () => openNewWorkbench();

  return (
    <TooltipProvider delayDuration={400}>
      <aside
        data-attr="app-sidebar"
        className={cn(
          'flex h-full shrink-0 flex-col border-r bg-card text-[13px] transition-[width] duration-150',
          collapsed ? 'w-14' : 'w-60'
        )}
      >
        <div className="px-2 pb-1 pt-1">
          <WorkspaceSwitcher collapsed={collapsed} />
        </div>
        <div className="flex flex-col gap-0.5 px-1.5 pb-2">
          {offered && (
            <SidebarItem
              icon={Plus}
              label="New session"
              keys="mod+shift+o"
              collapsed={collapsed}
              active={route.view === 'home'}
              onClick={newWorkbench}
              dataAttr="sidebar-new-workbench"
            />
          )}
          <SidebarItem
            icon={Search}
            label="Search"
            keys="mod+k"
            collapsed={collapsed}
            onClick={() => setPaletteOpen(true)}
            dataAttr="sidebar-search"
          />
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-1.5" aria-label="Sessions">
          {offered && !collapsed && <SidebarWorkbenchList workbenches={workbenches} />}
          <div className="mt-2 space-y-0.5">
            {offered && (
              <SidebarItem
                icon={History}
                label="History"
                collapsed={collapsed}
                active={route.view === 'history'}
                onClick={() => navigate({ view: 'history' })}
                dataAttr="sidebar-history"
              />
            )}
            <SidebarItem
              icon={FolderPlus}
              label="Add repository"
              collapsed={collapsed}
              onClick={() => setAddRepositoryOpen(true)}
              dataAttr="sidebar-add-repository"
            />
          </div>
        </nav>

        <div className="space-y-0.5 border-t px-1.5 py-1.5">
          <SidebarItem
            icon={GitPullRequest}
            label="Pull requests"
            badge={prCounts.my_prs}
            collapsed={collapsed}
            active={route.view === 'prs' && PR_PAGE_TABS.includes(route.tab)}
            onClick={() => {
              if (route.view !== 'prs' || !PR_PAGE_TABS.includes(route.tab)) navigate({ view: 'prs', tab: 'my_prs' });
            }}
            dataAttr="nav-pull-requests"
          />
          <SidebarItem
            icon={Eye}
            label="Review requests"
            badge={prCounts.reviews}
            collapsed={collapsed}
            active={route.view === 'prs' && route.tab === 'reviews'}
            onClick={() => navigate({ view: 'prs', tab: 'reviews' })}
            dataAttr="nav-review-requests"
          />
          <SidebarItem
            icon={GitMerge}
            label="Merge queue"
            badge={prCounts.merge_queue}
            collapsed={collapsed}
            active={route.view === 'prs' && route.tab === 'merge_queue'}
            onClick={() => navigate({ view: 'prs', tab: 'merge_queue' })}
            dataAttr="nav-merge-queue"
          />
          {automationTabs.length > 0 && (
            <SidebarItem
              icon={Workflow}
              label="Automations"
              collapsed={collapsed}
              active={route.view === 'automations'}
              onClick={() => {
                if (route.view !== 'automations') navigate({ view: 'automations', tab: automationTabs[0] });
              }}
              dataAttr="nav-automations"
            />
          )}
        </div>

        <div className="border-t p-2">
          <CloudProviderStatus collapsed={collapsed} />
          <div className={cn('flex items-center gap-1', collapsed && 'flex-col')}>
            <IconButton label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} keys="mod+b" onClick={toggleSidebar}>
              {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            </IconButton>
            {user && <UserChip user={user} collapsed={collapsed} onClick={() => openSettings('account')} />}
            {!collapsed && (
              <IconButton
                label="Settings"
                keys="mod+,"
                active={route.view === 'settings'}
                onClick={() => openSettings()}
              >
                <Settings className="h-4 w-4" />
              </IconButton>
            )}
          </div>
        </div>
      </aside>
    </TooltipProvider>
  );
}

function SidebarItem({
  icon: Icon,
  label,
  keys,
  badge,
  active,
  collapsed,
  onClick,
  className,
  dataAttr,
}: {
  icon: typeof Search;
  label: string;
  keys?: string;
  badge?: number;
  active?: boolean;
  collapsed: boolean;
  onClick: () => void;
  className?: string;
  dataAttr?: string;
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      data-attr={dataAttr}
      aria-label={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-7 items-center gap-2 rounded-md px-2 text-left transition-colors',
        active ? 'bg-secondary text-foreground' : 'text-foreground/80 hover:bg-accent hover:text-foreground',
        collapsed ? 'w-full justify-center px-0' : 'w-full',
        className
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {badge !== undefined && badge > 0 && (
            <span
              data-attr={dataAttr ? `${dataAttr}-badge` : undefined}
              className="min-w-[1.5rem] shrink-0 rounded-full bg-foreground/10 px-1.5 text-center text-[11px] tabular-nums"
            >
              {badge}
            </span>
          )}
          {keys && badge === undefined && (
            <span className="shrink-0 text-[11px] text-muted-foreground">{formatKeys(keys)}</span>
          )}
        </>
      )}
      {collapsed && badge !== undefined && badge > 0 && <span className="sr-only">{badge}</span>}
    </button>
  );
  if (!collapsed) return button;
  return (
    <WithTooltip label={label} keys={keys} badge={badge}>
      {button}
    </WithTooltip>
  );
}

function IconButton({
  label,
  keys,
  active,
  onClick,
  children,
}: {
  label: string;
  keys?: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <WithTooltip label={label} keys={keys}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors',
          active ? 'bg-secondary' : 'hover:bg-accent'
        )}
      >
        {children}
      </button>
    </WithTooltip>
  );
}

function WithTooltip({
  label,
  keys,
  badge,
  children,
}: {
  label: string;
  keys?: string;
  badge?: number;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" className="flex items-center gap-2">
        <span>{label}</span>
        {badge !== undefined && badge > 0 && <span className="tabular-nums text-muted-foreground">{badge}</span>}
        {keys && <span className="text-muted-foreground">{formatKeys(keys)}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
