import React from 'react';
import { codeReviewOffered, loopsOffered, mcpServersOffered, workflowsOffered } from '@talyn/shared';
import { Sidebar } from './Sidebar';
import { SystemStatusBanner } from './SystemStatusBanner';
import { QueuePanel } from '../panels/QueuePanel';
import { MyPRsPanel } from '../panels/github/MyPRsPanel';
import { ReviewsPanel } from '../panels/github/ReviewsPanel';
import { MergeQueuePanel } from '../panels/github/MergeQueuePanel';
import { SettingsPanel } from '../panels/SettingsPanel';
import { WorkflowsPanel } from '../panels/workflows/WorkflowsPanel';
import { LoopsPanel } from '../panels/loops/LoopsPanel';
// Eager, matching this fork's convention — the desktop ships one bundle, so the
// web fork's lazy split buys nothing here.
import { CodeReviewsPanel } from '../panels/codeReview/CodeReviewsPanel';
import { McpServersPanel } from '../panels/mcpServers/McpServersPanel';
import { CreateWorkspaceModal } from '../modals/CreateWorkspaceModal';
import { UpgradeModal } from '../modals/UpgradeModal';
import { ConnectAgentModal } from '../modals/ConnectAgentModal';
import { WhatsNewModal } from '../modals/WhatsNewModal';
import { CodeReviewIntroModal } from '../modals/CodeReviewIntroModal';
import { useCodeReviewIntro } from '../../hooks/useCodeReviewIntro';
import { useWorkspaceStore } from '../../stores/workspace';
import { useBillingStore } from '../../stores/billing';
import { useSystemStatus } from '../../hooks/useSystemStatus';
import { usePullRequestSync } from '../../hooks/usePullRequestSync';
import { useWhatsNew } from '../../hooks/useWhatsNew';
import { useDeferredRuns } from '../../hooks/useDeferredRuns';

export function MainLayout() {
  const { activePanel, setActivePanel, createWorkspaceOpen, setCreateWorkspaceOpen } =
    useWorkspaceStore();
  const features = useWorkspaceStore((s) => s.features);
  const upgradeModalOpen = useBillingStore((s) => s.upgradeModalOpen);
  const setUpgradeModalOpen = useBillingStore((s) => s.setUpgradeModalOpen);
  useSystemStatus();
  // Owns the shared open-PR fetch + WS subscription for the Sidebar badges and
  // all three GitHub pages. Mounted once here.
  usePullRequestSync();
  // Decides whether the release highlights since the user's last-seen version
  // are worth a modal. Mounted here so it can only run once onboarding is done.
  useWhatsNew();
  useDeferredRuns();
  // Introduces code review once, to somebody who already uses Talyn. Deferred
  // while What's-New is open: the release that flips this feature's availability
  // fires both on the same launch, and two modals stacked on one another is how
  // the second gets dismissed unread. It takes its turn next launch instead.
  const codeReviewIntro = useCodeReviewIntro();
  const whatsNewOpen = useWorkspaceStore((s) => s.whatsNewOpen);

  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        {/* Banner lives inside the main column (not above the sidebar) so the
            sidebar reaches the window top, where the macOS traffic lights sit. */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <SystemStatusBanner />
          <div className="flex-1 overflow-hidden">
            {activePanel === 'queue' && <QueuePanel />}
            {activePanel === 'my_prs' && <MyPRsPanel />}
            {activePanel === 'reviews' && <ReviewsPanel />}
            {activePanel === 'merge_queue' && <MergeQueuePanel />}
            {/* Gated the same way the nav item is. `activePanel` is remembered,
                so a user who loses the flag must not land back on a page the
                backend will refuse every request for. */}
            {activePanel === 'workflows' && workflowsOffered(features) && <WorkflowsPanel />}
            {activePanel === 'loops' && loopsOffered(features) && <LoopsPanel />}
      {activePanel === 'code_reviews' && codeReviewOffered(features) && (
        <CodeReviewsPanel />
      )}
          {activePanel === 'mcp_servers' && mcpServersOffered(features) && <McpServersPanel />}
            {activePanel === 'settings' && <SettingsPanel />}
          </div>
        </main>
      </div>
      <CreateWorkspaceModal
        open={createWorkspaceOpen}
        onOpenChange={setCreateWorkspaceOpen}
      />
      <UpgradeModal open={upgradeModalOpen} onOpenChange={setUpgradeModalOpen} />
      <ConnectAgentModal />
      <WhatsNewModal />
      <CodeReviewIntroModal
        open={codeReviewIntro.open && !whatsNewOpen}
        examplePrId={codeReviewIntro.examplePrId}
        onClose={codeReviewIntro.dismiss}
        onOpenPr={() => {
          // My PRs, not the sheet: the panels own their own row selection and
          // there is no store handle for it. The row is a good enough landing —
          // its phase bar is already moving, which is the demonstration.
          setActivePanel('my_prs');
        }}
      />
    </div>
  );
}
