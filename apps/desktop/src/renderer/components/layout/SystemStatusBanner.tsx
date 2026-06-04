import React, { useState } from 'react';
import { AlertTriangle, Github, Loader2, Settings } from 'lucide-react';
import { Button } from '../ui/button';
import { api } from '../../lib/api';
import { useWorkspaceStore } from '../../stores/workspace';

/** One warning row in the global banner. */
function BannerRow({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-300">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
    </div>
  );
}

/**
 * App-wide banner surfacing missing core functionality — currently a
 * disconnected GitHub, which silently pauses PR tracking, reviews, and the
 * merge queue. Renders nothing when everything's healthy. Designed to be
 * extended: push more rows as other core services gain hard requirements.
 */
export function SystemStatusBanner() {
  const { currentWorkspaceId, githubStatus, setActivePanel } = useWorkspaceStore();
  const [connecting, setConnecting] = useState(false);

  async function handleConnect() {
    if (!currentWorkspaceId) return;
    setConnecting(true);
    try {
      const { authUrl } = await api.github.connect(currentWorkspaceId);
      // OAuth runs in the system browser; useSystemStatus re-checks on focus
      // when the user returns, which clears this banner.
      window.open(authUrl, '_blank', 'width=600,height=700');
    } catch {
      // Nothing to do — the banner persists until the connection succeeds.
    } finally {
      setConnecting(false);
    }
  }

  const rows: React.ReactNode[] = [];

  // GitHub — the core of the app. `githubStatus === null` means "not checked
  // yet", so we don't flash a banner before the first status load resolves.
  if (currentWorkspaceId && githubStatus && !githubStatus.connected) {
    rows.push(
      githubStatus.configured === false ? (
        <BannerRow
          key="gh-unconfigured"
          message="GitHub OAuth isn't configured on the backend — PR tracking is unavailable until GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set."
        />
      ) : (
        <BannerRow
          key="gh-disconnected"
          message="GitHub isn't connected for this workspace. PR tracking, reviews, and the merge queue are paused."
          action={
            <>
              <Button size="sm" onClick={handleConnect} disabled={connecting}>
                {connecting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Github className="mr-1 h-4 w-4" />
                    Connect GitHub
                  </>
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setActivePanel('settings')}
                title="GitHub settings"
              >
                <Settings className="h-4 w-4" />
              </Button>
            </>
          }
        />
      )
    );
  }

  if (rows.length === 0) return null;
  return <div className="shrink-0">{rows}</div>;
}
