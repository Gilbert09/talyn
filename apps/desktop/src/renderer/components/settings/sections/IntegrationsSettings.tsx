import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Github, Loader2, Unlink } from 'lucide-react';
import { api } from '../../../lib/api';
import { cn } from '../../../lib/utils';
import { useGithubInstallations } from '../../../hooks/useGithubInstallations';
import { useWorkspaceStore } from '../../../stores/workspace';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';
import { SettingsPage } from '../../ui/settings';
import { GithubInstallStatus } from '../../widgets/GithubInstallStatus';

export function IntegrationsSettings() {
  // GitHub status + user are preloaded into the store at startup
  // (useSystemStatus) and kept fresh there on window focus, so this panel
  // renders the connection state instantly instead of fetching on open. We
  // still kick a non-blocking refresh on mount to catch anything that changed
  // since the last focus; render never waits on it.
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const githubStatus = useWorkspaceStore((s) => s.githubStatus);
  const githubUser = useWorkspaceStore((s) => s.githubUser);
  const setGitHubStatus = useWorkspaceStore((s) => s.setGitHubStatus);
  const setGitHubUser = useWorkspaceStore((s) => s.setGitHubUser);
  const {
    installations,
    checked: installsChecked,
    loading: installsLoading,
    refresh: refreshInstalls,
  } = useGithubInstallations(currentWorkspaceId, Boolean(githubStatus?.connected));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshGitHubStatus = useCallback(async () => {
    if (!currentWorkspaceId) return;
    try {
      const status = await api.github.getStatus(currentWorkspaceId);
      setGitHubStatus(status);
      if (status.connected) {
        try {
          setGitHubUser(await api.github.getUser(currentWorkspaceId));
        } catch (_e) {
          // User fetch failed, but the connection might still be valid.
        }
      } else {
        setGitHubUser(null);
      }
    } catch (_e) {
      // Fetch failure ≠ "OAuth unconfigured" — claiming configured:false here
      // painted a misleading global banner whenever the request failed for
      // unrelated reasons (e.g. a stale workspace id 404ing). Status unknown.
      setGitHubStatus(null);
    }
  }, [currentWorkspaceId, setGitHubStatus, setGitHubUser]);

  useEffect(() => {
    void refreshGitHubStatus();
  }, [refreshGitHubStatus]);

  // Start the GitHub App install flow. The stateful install URL must be opened
  // in the real browser (it's a multi-step GitHub install + authorize page);
  // GitHub redirects back through /github/app/callback, which records the
  // installation + user token. Connection status refreshes on window focus.
  const handleGitHubAppConnect = async () => {
    if (!currentWorkspaceId) return;

    setIsLoading(true);
    setError(null);

    try {
      const { installUrl } = await api.github.installViaApp(currentWorkspaceId);
      if (window.electron?.auth?.openExternal) {
        await window.electron.auth.openExternal(installUrl);
      } else {
        window.open(installUrl, '_blank');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to start GitHub App install');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGitHubDisconnect = async () => {
    if (!currentWorkspaceId) return;

    setIsLoading(true);
    try {
      await api.github.disconnect(currentWorkspaceId);
      // Surface the change immediately across the banner + this panel.
      setGitHubStatus({ configured: true, connected: false });
      setGitHubUser(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SettingsPage title="Integrations" description="Connect external services to enhance your workflow">
      {error && (
        <div className="p-2.5 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      <Card className="p-3">
        <div className="flex items-start gap-3">
          <div className={cn(
            'w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0',
            githubStatus?.connected ? 'bg-green-500/10' : 'bg-secondary'
          )}>
            <Github className={cn('w-4 h-4', githubStatus?.connected && 'text-green-500')} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="text-[13px] font-semibold">GitHub</h4>
              {githubStatus?.configured === false && (
                <Badge variant="secondary">Not Configured</Badge>
              )}
              {githubStatus?.connected && (
                <Badge variant="default" className="bg-green-600">
                  <Check className="w-3 h-3 mr-0.5" />
                  Connected
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {githubStatus?.connected && githubUser ? (
                <>Connected as <strong>@{githubUser.login}</strong></>
              ) : githubStatus?.configured ? (
                'Connect to GitHub to track PRs, issues, and CI status'
              ) : (
                githubStatus?.message || 'Set up the GitHub App (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)'
              )}
            </p>
          </div>
          {githubStatus?.connected ? (
            // Connecting GitHub installs the App, so a connected workspace
            // always has webhooks — no separate "enable" step.
            <Button
              variant="outline"
              size="sm"
              onClick={handleGitHubDisconnect}
              disabled={isLoading}
            >
              {isLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <>
                  <Unlink className="w-3.5 h-3.5" />
                  Disconnect
                </>
              )}
            </Button>
          ) : (
            // The GitHub App (webhooks + realtime) is the only connect path —
            // a "connected" workspace always has webhooks.
            <Button
              size="sm"
              onClick={handleGitHubAppConnect}
              disabled={isLoading || !githubStatus?.configured || !currentWorkspaceId}
            >
              {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Connect GitHub'}
            </Button>
          )}
        </div>

        {githubStatus?.connected && currentWorkspaceId && (
          <div className="mt-3 border-t pt-3">
            <GithubInstallStatus
              workspaceId={currentWorkspaceId}
              installations={installations}
              checked={installsChecked}
              loading={installsLoading}
              onRefresh={refreshInstalls}
              showAddAccount
            />
          </div>
        )}
      </Card>
    </SettingsPage>
  );
}
