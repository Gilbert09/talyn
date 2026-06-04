import React from 'react';
import { Sidebar } from './Sidebar';
import { InboxPanel } from '../panels/InboxPanel';
import { QueuePanel } from '../panels/QueuePanel';
import { GitHubPanel } from '../panels/GitHubPanel';
import { SettingsPanel } from '../panels/SettingsPanel';
import { DebugPanel } from '../panels/DebugPanel';
import { CreateWorkspaceModal } from '../modals/CreateWorkspaceModal';
import { useWorkspaceStore } from '../../stores/workspace';

export function MainLayout() {
  const { activePanel, createWorkspaceOpen, setCreateWorkspaceOpen } = useWorkspaceStore();

  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <div className="flex-1 overflow-hidden">
          {activePanel === 'inbox' && <InboxPanel />}
          {activePanel === 'queue' && <QueuePanel />}
          {activePanel === 'github' && <GitHubPanel />}
          {activePanel === 'settings' && <SettingsPanel />}
          {activePanel === 'debug' && <DebugPanel />}
        </div>
      </main>
      <CreateWorkspaceModal
        open={createWorkspaceOpen}
        onOpenChange={setCreateWorkspaceOpen}
      />
    </div>
  );
}
