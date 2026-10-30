import { Suspense, useEffect } from 'react';
import { mcpServersOffered, workbenchesOffered } from '@talyn/shared';
import { useRouteUrlSync } from '../../hooks/useRouteUrlSync';
import { AppSidebar } from './AppSidebar';
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
import { useWorkspaceStore } from '../../stores/workspace';
import { useBillingStore } from '../../stores/billing';
import { useWorkbenchStore } from '../../stores/workbenches';
import { useNavigationStore } from '../../stores/navigation';
import { lazyWithReload } from '../../lib/lazyWithReload';

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
  useWorkbenchList();
  useAppShortcuts();
  const codeReviewIntro = useCodeReviewIntro();
  const whatsNewOpen = useWorkspaceStore((s) => s.whatsNewOpen);

  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden">
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
  const offered = workbenchesOffered(features);
  if (
    (route.view === 'workbench' ||
      route.view === 'history' ||
      (route.view === 'settings' && route.section === 'sessions')) &&
    !offered
  )
    return null;
  switch (route.view) {
    case 'home':
      return <HomePage />;
    case 'workbench':
      return <WorkbenchPage id={route.id} />;
    case 'history':
      return <HistoryView />;
    case 'prs':
      return <PullRequestsView tab={route.tab} />;
    case 'automations':
      return <AutomationsView tab={route.tab} />;
    case 'mcp_servers':
      return mcpServersOffered(features) ? <McpServersPanel /> : null;
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

  useEffect(() => {
    if (workspaceId && offered) void loadWorkbenches(workspaceId);
  }, [workspaceId, offered]);

  useEffect(() => {
    useNavigationStore.getState().reconcileWorkbenchRoute({ workbenches, listLoaded, offered });
  }, [route, workbenches, listLoaded, offered]);
}

const CommandPalette = lazyWithReload(() => import('../CommandPalette').then((m) => ({ default: m.CommandPalette })));

const WorkbenchPage = lazyWithReload(() => import('../../pages/WorkbenchPage').then((m) => ({ default: m.WorkbenchPage })));

const SettingsPanel = lazyWithReload(() => import('../panels/SettingsPanel').then((m) => ({ default: m.SettingsPanel })));

const McpServersPanel = lazyWithReload(() =>
  import('../panels/mcpServers/McpServersPanel').then((m) => ({ default: m.McpServersPanel }))
);
