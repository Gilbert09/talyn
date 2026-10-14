import { useEffect } from 'react';
import { workbenchesOffered } from '@talyn/shared';
import { AppSidebar } from './AppSidebar';
import { SystemStatusBanner } from './SystemStatusBanner';
import { useAppShortcuts } from './appShortcuts';
import { SettingsPanel } from '../panels/SettingsPanel';
import { CommandPalette } from '../CommandPalette';
import { NewWorkbenchDialog } from '../workbench/NewWorkbenchDialog';
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
import { WorkbenchPage } from '../../pages/WorkbenchPage';
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

/**
 * The signed-in, onboarded app: `[AppSidebar | main column]`, with the
 * system banner over the routed view. It also mounts the app-wide hooks and
 * modals, the command palette, and the one keyboard listener.
 */
export function AppShell() {
  const createWorkspaceOpen = useWorkspaceStore((s) => s.createWorkspaceOpen);
  const setCreateWorkspaceOpen = useWorkspaceStore((s) => s.setCreateWorkspaceOpen);
  const setActivePanel = useWorkspaceStore((s) => s.setActivePanel);
  const upgradeModalOpen = useBillingStore((s) => s.upgradeModalOpen);
  const setUpgradeModalOpen = useBillingStore((s) => s.setUpgradeModalOpen);
  useSystemStatus();
  // Owns the shared open-PR fetch + WS subscription for the sidebar badge and
  // the PR pages. Mounted once here.
  usePullRequestSync();
  // Decides whether the release highlights since the user's last-seen version
  // are worth a modal. Mounted here so it can only run once onboarding is done.
  useWhatsNew();
  useDeferredRuns();
  useWorkbenchList();
  useAppShortcuts();
  // Introduces code review once, to somebody who already uses Talyn. Deferred
  // while What's-New is open: the release that flips this feature's availability
  // fires both on the same launch, and two modals stacked on one another is how
  // the second gets dismissed unread. It takes its turn next launch instead.
  const codeReviewIntro = useCodeReviewIntro();
  const whatsNewOpen = useWorkspaceStore((s) => s.whatsNewOpen);

  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <AppSidebar />
        {/* The banner sits in the main column, so the sidebar reaches the window top where the traffic lights are. */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <SystemStatusBanner />
          <div className="min-h-0 flex-1 overflow-hidden">
            <RoutedView />
          </div>
        </main>
      </div>
      <NewWorkbenchDialog />
      <AddRepositoryModal />
      <CommandPalette />
      <CreateWorkspaceModal open={createWorkspaceOpen} onOpenChange={setCreateWorkspaceOpen} />
      <UpgradeModal open={upgradeModalOpen} onOpenChange={setUpgradeModalOpen} />
      <ConnectAgentModal />
      <WhatsNewModal />
      <CodeReviewIntroModal
        open={codeReviewIntro.open && !whatsNewOpen}
        examplePrId={codeReviewIntro.examplePrId}
        onClose={codeReviewIntro.dismiss}
        onOpenPr={() => {
          // My PRs, not the sheet: the panels own their own row selection and
          // there is no store handle for it.
          setActivePanel('my_prs');
        }}
      />
    </div>
  );
}

/** The main column's content for the current route. */
export function RoutedView() {
  const route = useNavigationStore((s) => s.route);
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
    case 'settings':
      return <SettingsPanel />;
    default:
      return <HomePage />;
  }
}

/**
 * Loads the workspace's workbenches (archived included, for History) and
 * keeps the workbench route honest: a route to a workbench that is gone, or
 * to workbenches on an account that is not offered them, goes home.
 */
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
