import { Suspense, useEffect } from 'react';
import { mcpServersOffered, splitViewOffered, workbenchesOffered } from '@talyn/shared';
import { useRouteUrlSync } from '../../hooks/useRouteUrlSync';
import { AppSidebar } from './AppSidebar';
import { ContextRail } from './ContextRail';
import { SystemStatusBanner } from './SystemStatusBanner';
import { useAppShortcuts } from './appShortcuts';
import { CreateWorkspaceModal } from '../modals/CreateWorkspaceModal';
import { UpgradeModal } from '../modals/UpgradeModal';
import { ConnectAgentModal } from '../modals/ConnectAgentModal';
import { WhatsNewModal } from '../modals/WhatsNewModal';
import { CodeReviewIntroModal } from '../modals/CodeReviewIntroModal';
import { AddRepositoryModal } from '../modals/AddRepositoryModal';
import { HomePage } from '../../pages/HomePage';
import { HistoryView } from '../../pages/HistoryView';
import { PullRequestsView } from '../../pages/PullRequestsView';
import { AutomationsView } from '../../pages/AutomationsView';
import { loadWorkbenches } from '../../lib/workbenchData';
import { useCodeReviewIntro } from '../../hooks/useCodeReviewIntro';
import { useSystemStatus } from '../../hooks/useSystemStatus';
import { usePullRequestSync } from '../../hooks/usePullRequestSync';
import { useWhatsNew } from '../../hooks/useWhatsNew';
import { useDeferredRuns } from '../../hooks/useDeferredRuns';
import { useBillingLive } from '../../hooks/useBillingLive';
import { useWorkspaceStore } from '../../stores/workspace';
import { useBillingStore } from '../../stores/billing';
import { useWorkbenchStore } from '../../stores/workbenches';
import { useNavigationStore } from '../../stores/navigation';
import { lazyWithReload } from '../../lib/lazyWithReload';
import { useActiveSpace, loadExtraWorkbench, spacesOffered } from '../../lib/spaces';
import { useFollowSessionContext, useSpaceLive, useSpacesBoot } from '../../hooks/useSpaces';
import { useSpacesStore } from '../../stores/spaces';
import { SpaceDialogsHost } from '../spaces/SpaceDialogs';
import { MoveToSpaceDialog } from '../spaces/MoveToSpace';
import { SpaceHomePage } from '../spaces/SpaceHomePage';

export function AppShell() {
  const paletteOpen = useNavigationStore((s) => s.paletteOpen);
  const createWorkspaceOpen = useWorkspaceStore((s) => s.createWorkspaceOpen);
  const setCreateWorkspaceOpen = useWorkspaceStore((s) => s.setCreateWorkspaceOpen);
  const setActivePanel = useWorkspaceStore((s) => s.setActivePanel);
  const upgradeModalOpen = useBillingStore((s) => s.upgradeModalOpen);
  const setUpgradeModalOpen = useBillingStore((s) => s.setUpgradeModalOpen);
  useRouteUrlSync();
  useSystemStatus();
  usePullRequestSync();
  useWhatsNew();
  useDeferredRuns();
  useBillingLive();
  useWorkbenchList();
  useAppShortcuts();
  useSpacesBoot();
  useFollowSessionContext();
  const space = useActiveSpace();
  useSpaceLive(space?.space.id ?? null);
  const codeReviewIntro = useCodeReviewIntro();
  const whatsNewOpen = useWorkspaceStore((s) => s.whatsNewOpen);

  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ContextRail />
        <AppSidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <SystemStatusBanner />
          <div className="min-h-0 flex-1 overflow-hidden">
            <Suspense fallback={null}>
              <RoutedView />
            </Suspense>
          </div>
        </main>
      </div>
      <AddRepositoryModal />
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
      )}
      <CreateWorkspaceModal open={createWorkspaceOpen} onOpenChange={setCreateWorkspaceOpen} />
      <UpgradeModal open={upgradeModalOpen} onOpenChange={setUpgradeModalOpen} />
      <ConnectAgentModal />
      <WhatsNewModal />
      <SpaceDialogsHost />
      <MoveToSpaceDialog />
      <CodeReviewIntroModal
        open={codeReviewIntro.open && !whatsNewOpen}
        examplePrId={codeReviewIntro.examplePrId}
        onClose={codeReviewIntro.dismiss}
        onOpenPr={() => {
          setActivePanel('my_prs');
        }}
      />
    </div>
  );
}

export function RoutedView() {
  const route = useNavigationStore((s) => s.route);
  const features = useWorkspaceStore((s) => s.features);
  const space = useActiveSpace();
  const offered = workbenchesOffered(features);
  if (
    (route.view === 'workbench' ||
      route.view === 'history' ||
      (route.view === 'settings' && route.section === 'sessions')) &&
    !offered
  )
    return null;
  // A space shows its own feed where Personal shows pages that belong only to Personal.
  if (space && (route.view === 'home' || route.view === 'prs' || route.view === 'automations' || route.view === 'mcp_servers' || route.view === 'insights')) {
    return <SpaceHomePage active={space} />;
  }
  switch (route.view) {
    case 'home':
      return <HomePage />;
    case 'workbench':
      return <WorkbenchPage id={route.id} />;
    case 'history':
      return <HistoryView />;
    case 'split':
      if (splitViewOffered(features)) return <SplitView />;
      return features === null ? null : <HomePage />;
    case 'prs':
      return <PullRequestsView tab={route.tab} />;
    case 'automations':
      return <AutomationsView tab={route.tab} />;
    case 'mcp_servers':
      return mcpServersOffered(features) ? <McpServersPanel /> : null;
    case 'insights':
      return <InsightsView />;
    case 'settings':
      return <SettingsPanel />;
    default:
      return <HomePage />;
  }
}

function useWorkbenchList(): void {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const features = useWorkspaceStore((s) => s.features);
  const offered = features === null ? null : workbenchesOffered(features);
  const workbenches = useWorkbenchStore((s) => s.workbenches);
  const listLoaded = useWorkbenchStore((s) => s.listLoaded);
  const route = useNavigationStore((s) => s.route);
  const spacesOn = spacesOffered(features);
  const extraLoads = useSpacesStore((s) => s.extraLoads);

  useEffect(() => {
    if (workspaceId && offered) void loadWorkbenches(workspaceId);
  }, [workspaceId, offered]);

  useEffect(() => {
    // A teammate's session is not in my list: fetch it before deciding the route is gone.
    if (spacesOn && offered && listLoaded && route.view === 'workbench' && !workbenches[route.id]) {
      const state = extraLoads[route.id];
      if (!state) {
        void loadExtraWorkbench(route.id);
        return;
      }
      if (state === 'loading') return;
    }
    useNavigationStore.getState().reconcileWorkbenchRoute({ workbenches, listLoaded, offered });
  }, [route, workbenches, listLoaded, offered, spacesOn, extraLoads]);
}

const CommandPalette = lazyWithReload(() => import('../CommandPalette').then((m) => ({ default: m.CommandPalette })));

const WorkbenchPage = lazyWithReload(() => import('../../pages/WorkbenchPage').then((m) => ({ default: m.WorkbenchPage })));

const SplitView = lazyWithReload(() => import('../workbench/SplitView').then((m) => ({ default: m.SplitView })));

const SettingsPanel = lazyWithReload(() => import('../panels/SettingsPanel').then((m) => ({ default: m.SettingsPanel })));

const InsightsView = lazyWithReload(() => import('../../pages/InsightsView').then((m) => ({ default: m.InsightsView })));

const McpServersPanel = lazyWithReload(() =>
  import('../panels/mcpServers/McpServersPanel').then((m) => ({ default: m.McpServersPanel }))
);
