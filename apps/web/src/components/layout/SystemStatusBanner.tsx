import React, { useEffect, useState } from 'react';
import { AlertTriangle, Github, Info, Loader2, Plus, ServerCrash, Settings, WifiOff, X } from 'lucide-react';
import { Button } from '../ui/button';
import { useWorkspaceStore } from '../../stores/workspace';
import { openGithubAppFlow, openGithubExternalUrl, uncoveredOwners, formatOwnerList } from '../../lib/githubInstall';
import { useGithubCoverage } from '../../hooks/useGithubCoverage';
import type { GitHubOwnerCoverage, GitHubOwnerCoverageState } from '../../lib/api';

/**
 * A connectivity row. Deliberately styled apart from the amber warning rows:
 * losing the network is transient and usually nothing the user did wrong, so
 * it should read as informational rather than as a misconfiguration.
 */
/**
 * The backend answered, but with server errors or timeouts. A different fact
 * from offline — the user's connection is fine, and nothing on their side will
 * fix it — and it must not be dressed up as a GitHub configuration problem,
 * which is what a wedged database pool used to look like here.
 */
function DegradedRow() {
  return (
    <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-300">
      <ServerCrash className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        Talyn is having trouble on our side. What you see may be out of date — retrying
        automatically, nothing for you to do.
      </span>
    </div>
  );
}

function OfflineRow() {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return (
    <div className="flex items-center gap-3 border-b border-border bg-muted px-4 py-2 text-sm text-muted-foreground">
      <WifiOff className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {offline
          ? "You're offline — Talyn will reconnect and refresh automatically."
          : "Can't reach Talyn right now. Retrying — your data will refresh automatically."}
      </span>
    </div>
  );
}

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
 * A calm row for a choice with a consequence, not a fault. Dismissible,
 * because the user may have added the repo on purpose.
 */
function NoticeRow({
  message,
  action,
  onDismiss,
}: {
  message: string;
  action?: React.ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border bg-muted px-4 py-2 text-sm text-muted-foreground">
      <Info className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      <div className="flex shrink-0 items-center gap-1">
        {action}
        <Button size="sm" variant="ghost" onClick={onDismiss} title="Dismiss" aria-label="Dismiss">
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

const DISMISSED_KEY_PREFIX = 'talyn.pollingNotice.dismissed.';

function readDismissedOwners(workspaceId: string | null): string[] {
  if (!workspaceId) return [];
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY_PREFIX + workspaceId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissedOwners(workspaceId: string, owners: string[]): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY_PREFIX + workspaceId, JSON.stringify(owners));
  } catch {
    // Storage blocked: the dismissal lasts for this session only.
  }
}

/**
 * App-wide banner surfacing missing core functionality — currently a
 * disconnected GitHub, which silently pauses PR tracking, reviews, and the
 * merge queue. Renders nothing when everything's healthy. Designed to be
 * extended: push more rows as other core services gain hard requirements.
 */
export function SystemStatusBanner() {
  const {
    currentWorkspaceId,
    githubStatus,
    githubInstallations,
    repositories,
    setActivePanel,
    backendHealth,
  } = useWorkspaceStore();
  const [connecting, setConnecting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const uncovered = currentWorkspaceId && githubStatus?.connected && githubInstallations
    && backendHealth !== 'offline' && backendHealth !== 'degraded'
    ? uncoveredOwners(repositories.map((r) => r.owner), githubInstallations)
    : [];
  const coverage = useGithubCoverage(currentWorkspaceId, uncovered);
  // Owners whose "polled, not live" notice the user closed. Per workspace and
  // per owner, so a newly added owner without the App still gets one notice.
  const [dismissed, setDismissed] = useState<{ workspaceId: string | null; owners: string[] }>(
    () => ({ workspaceId: currentWorkspaceId, owners: readDismissedOwners(currentWorkspaceId) })
  );
  useEffect(() => {
    setDismissed({ workspaceId: currentWorkspaceId, owners: readDismissedOwners(currentWorkspaceId) });
  }, [currentWorkspaceId]);
  const dismissedOwners = new Set(
    dismissed.workspaceId === currentWorkspaceId ? dismissed.owners : []
  );

  function dismissOwners(owners: string[]) {
    if (!currentWorkspaceId) return;
    const next = [...new Set([...dismissedOwners, ...owners.map((o) => o.toLowerCase())])];
    writeDismissedOwners(currentWorkspaceId, next);
    setDismissed({ workspaceId: currentWorkspaceId, owners: next });
  }

  async function handleConnect() {
    if (!currentWorkspaceId) return;
    setConnecting(true);
    try {
      // The GitHub App install runs in the system browser; useSystemStatus
      // re-checks on focus when the user returns, which clears this banner.
      await openGithubAppFlow(currentWorkspaceId, 'connect');
    } catch {
      // Nothing to do — the banner persists until the connection succeeds.
    } finally {
      setConnecting(false);
    }
  }

  async function handleInstallApp() {
    if (!currentWorkspaceId) return;
    setInstalling(true);
    try {
      await openGithubAppFlow(currentWorkspaceId, 'manage');
    } catch {
      // Banner persists until the install lands + the focus re-check runs.
    } finally {
      setInstalling(false);
    }
  }

  const rows: React.ReactNode[] = [];

  // Backend unreachable: say exactly that, and say nothing else. Every other
  // row below describes remote state we could not read, so rendering them
  // would be guessing — which is how a dropped connection used to surface as
  // "GitHub OAuth isn't configured on the backend".
  if (backendHealth === 'offline' || backendHealth === 'degraded') {
    return (
      <div className="shrink-0">
        {backendHealth === 'offline' ? <OfflineRow /> : <DegradedRow />}
      </div>
    );
  }

  // GitHub — the core of the app. `githubStatus === null` means "not checked
  // yet", so we don't flash a banner before the first status load resolves.
  if (currentWorkspaceId && githubStatus && !githubStatus.connected) {
    rows.push(
      githubStatus.configured === false ? (
        <BannerRow
          key="gh-unconfigured"
          message="GitHub sign-in isn't set up on this Talyn server, so PR tracking is off. If you run this server, set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET."
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

  // App-installation coverage — only meaningful once GitHub is connected and the
  // installation list has actually loaded (null = not checked). A watched repo
  // whose owner has no active install gets no webhooks: a public one is still
  // polled, so that case reads as a notice, while suspension and sign-in
  // problems stay warnings with an action.
  if (currentWorkspaceId && githubStatus?.connected && githubInstallations) {
    // Wait for the diagnosis rather than flash a guess that may be wrong.
    if (uncovered.length > 0 && coverage !== undefined) {
      const problems = coverage ?? uncovered.map((owner): GitHubOwnerCoverage => ({
        owner, state: 'not_installed',
      }));
      const groups = new Map<GitHubOwnerCoverageState, GitHubOwnerCoverage[]>();
      const ownerSet = new Set(uncovered.map((owner) => owner.toLowerCase()));
      for (const problem of problems) {
        if (!ownerSet.has(problem.owner.toLowerCase())) continue;
        const group = groups.get(problem.state) ?? [];
        group.push(problem);
        groups.set(problem.state, group);
      }
      for (const [state, group] of groups) {
        const owners = formatOwnerList(group.map((problem) => problem.owner));
        if (state === 'suspended') {
          rows.push(
            <BannerRow
              key={`gh-app-${state}`}
              message={`The Talyn GitHub App is suspended on ${owners}. An owner of ${owners} must unsuspend it in GitHub before watched repos there are tracked.`}
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setActivePanel('settings')}
                  title="GitHub settings"
                >
                  <Settings className="h-4 w-4" />
                </Button>
              }
            />
          );
          continue;
        }
        if (state === 'sso_required' || state === 'not_accessible') {
          rows.push(
            <BannerRow
              key={`gh-app-${state}`}
              message={state === 'sso_required'
                ? `${owners} uses single sign-on, and your GitHub sign-in isn't authorized for it. Watched repos there aren't tracked until you authorize it and reconnect GitHub.`
                : `The Talyn GitHub App is installed on ${owners}, but your GitHub account can't reach it. Reconnect GitHub. If that doesn't help, ask an owner of ${owners} to give you access.`}
              action={
                <>
                  {state === 'sso_required' && group.map(({ owner, ssoUrl }) => ssoUrl && (
                    <Button
                      key={owner}
                      size="sm"
                      title={`Authorize SSO for @${owner}`}
                      onClick={() => void openGithubExternalUrl(ssoUrl).catch(() => undefined)}
                    >
                      Authorize SSO
                    </Button>
                  ))}
                  <Button size="sm" onClick={handleConnect} disabled={connecting}>
                    {connecting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Github className="mr-1 h-4 w-4" />
                        Reconnect GitHub
                      </>
                    )}
                  </Button>
                </>
              }
            />
          );
          continue;
        }
        // `not_installed`, and also `unknown` or a failed diagnosis, where the
        // install is the likeliest cause.
        const shown = group.map((problem) => problem.owner)
          .filter((owner) => !dismissedOwners.has(owner.toLowerCase()));
        if (shown.length === 0) continue;
        const shownList = formatOwnerList(shown);
        rows.push(
          <NoticeRow
            key={`gh-app-${state}`}
            message={`Talyn's GitHub App isn't installed on ${shownList}, so watched repos there are polled every few minutes, not updated live. Install the App on ${shownList} for live updates.`}
            onDismiss={() => dismissOwners(shown)}
            action={
              <>
                <Button size="sm" onClick={handleInstallApp} disabled={installing}>
                  {installing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <Plus className="mr-1 h-4 w-4" />
                      Install app
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
        );
      }
    }
  }

  if (rows.length === 0) return null;
  return <div className="shrink-0">{rows}</div>;
}
