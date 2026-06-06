import React from 'react';
import { Sidebar } from './Sidebar';
import { SystemStatusBanner } from './SystemStatusBanner';
import { QueuePanel } from '../panels/QueuePanel';
import { MyPRsPanel } from '../panels/github/MyPRsPanel';
import { ReviewsPanel } from '../panels/github/ReviewsPanel';
import { MergeQueuePanel } from '../panels/github/MergeQueuePanel';
import { SettingsPanel } from '../panels/SettingsPanel';
import { DebugPanel } from '../panels/DebugPanel';
import { CreateWorkspaceModal } from '../modals/CreateWorkspaceModal';
import { useWorkspaceStore } from '../../stores/workspace';
import { useSystemStatus } from '../../hooks/useSystemStatus';
import { usePullRequestSync } from '../../hooks/usePullRequestSync';

export function MainLayout() {
  const { activePanel, createWorkspaceOpen, setCreateWorkspaceOpen } = useWorkspaceStore();
  useSystemStatus();
  // Owns the shared open-PR fetch + WS subscription for the Sidebar badges and
  // all three GitHub pages. Mounted once here.
  usePullRequestSync();

  return (
    <div className="flex h-screen flex-col bg-background">
      <SystemStatusBanner />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">
            {activePanel === 'queue' && <QueuePanel />}
            {activePanel === 'my_prs' && <MyPRsPanel />}
            {activePanel === 'reviews' && <ReviewsPanel />}
            {activePanel === 'merge_queue' && <MergeQueuePanel />}
            {activePanel === 'settings' && <SettingsPanel />}
            {activePanel === 'debug' && <DebugPanel />}
          </div>
        </main>
      </div>
      <CreateWorkspaceModal
        open={createWorkspaceOpen}
        onOpenChange={setCreateWorkspaceOpen}
      />
    </div>
  );
}
