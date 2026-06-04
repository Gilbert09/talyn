import React from 'react';
import { Sidebar } from './Sidebar';
import { SystemStatusBanner } from './SystemStatusBanner';
import { QueuePanel } from '../panels/QueuePanel';
import { GitHubPanel } from '../panels/GitHubPanel';
import { SettingsPanel } from '../panels/SettingsPanel';
import { DebugPanel } from '../panels/DebugPanel';
import { CreateWorkspaceModal } from '../modals/CreateWorkspaceModal';
import { useWorkspaceStore } from '../../stores/workspace';
import { useSystemStatus } from '../../hooks/useSystemStatus';

export function MainLayout() {
  const { activePanel, createWorkspaceOpen, setCreateWorkspaceOpen } = useWorkspaceStore();
  useSystemStatus();

  return (
    <div className="flex h-screen flex-col bg-background">
      <SystemStatusBanner />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">
            {activePanel === 'queue' && <QueuePanel />}
            {activePanel === 'github' && <GitHubPanel />}
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
