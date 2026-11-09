import { github, type GitHubInstallation, type GitHubStatus, type GitHubUser } from '@talyn/client/native';
import { useCallback, useEffect } from 'react';

import { useMobileRuntime } from '../../auth/AuthProvider';
import { appReturnBase, openReturnFlow } from '../../lib/returnTo';
import { useRemote } from '../more/useRemote';
import { onGithubReturn } from './githubReturn';

export type GithubFlowMode = 'connect' | 'manage';

interface InstallUrls { installUrl: string; manageUrl: string }
type InstallViaApp = (workspaceId: string, options?: { returnTo?: string }) => Promise<InstallUrls>;
const defaultInstall: InstallViaApp = (workspaceId, options) => github.installViaApp(workspaceId, options);

/**
 * The install URLs, asking the server to finish in this app. A backend that
 * predates the mobile return refuses the option with a 400, so the request is
 * sent again without it. The flow then ends on GitHub's page, and the app
 * re-checks the connection when the browser closes or the app returns.
 */
export async function installUrls(workspaceId: string, install: InstallViaApp = defaultInstall,
  returnTo = appReturnBase()): Promise<InstallUrls> {
  try {
    return await install(workspaceId, { returnTo });
  } catch (error) {
    if ((error as { status?: unknown } | null)?.status !== 400) throw error;
    return install(workspaceId);
  }
}

/**
 * `connect` runs the first authorization. `manage` opens GitHub's install page
 * to add the app to another account. Resolves when the browser closes.
 */
export async function openGithubAppFlow(workspaceId: string, mode: GithubFlowMode): Promise<'returned' | 'dismissed'> {
  const urls = await installUrls(workspaceId);
  return openReturnFlow(mode === 'manage' ? urls.manageUrl : urls.installUrl, 'github');
}

/** Lowercased account logins with an active installation. */
export function installedAccounts(installations: readonly GitHubInstallation[]): Set<string> {
  return new Set(installations.filter((item) => !item.suspended).map((item) => item.accountLogin.toLowerCase()));
}

export function isOwnerCovered(owner: string, installations: readonly GitHubInstallation[]): boolean {
  return installedAccounts(installations).has(owner.toLowerCase());
}

/** Owners, in their own case and sorted, that have no active installation. */
export function uncoveredOwners(owners: readonly string[], installations: readonly GitHubInstallation[]): string[] {
  const covered = installedAccounts(installations);
  const seen = new Map<string, string>();
  for (const owner of owners) {
    const key = owner.toLowerCase();
    if (!covered.has(key) && !seen.has(key)) seen.set(key, owner);
  }
  return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** "@a, @b and @c". */
export function formatOwnerList(owners: readonly string[]): string {
  const tagged = owners.map((owner) => `@${owner}`);
  if (tagged.length <= 1) return tagged.join('');
  if (tagged.length === 2) return `${tagged[0]} and ${tagged[1]}`;
  return `${tagged.slice(0, -1).join(', ')} and ${tagged[tagged.length - 1]}`;
}

/**
 * The GitHub connection, the signed-in GitHub user and the app installations.
 * Each read refreshes when the app returns to the foreground. A return from the
 * install flow refreshes them too, and the workspace the onboarding gate reads.
 */
export function useGithubConnection(workspaceId: string | null) {
  const { workflow } = useMobileRuntime();
  const status = useRemote<GitHubStatus>(workspaceId ? `github-status:${workspaceId}` : null, () => github.getStatus(workspaceId ?? undefined));
  const connected = status.data?.connected === true;
  const user = useRemote<GitHubUser>(workspaceId && connected ? `github-user:${workspaceId}` : null, () => github.getUser(workspaceId as string));
  const installations = useRemote<GitHubInstallation[]>(workspaceId && connected ? `github-installations:${workspaceId}` : null,
    () => github.listInstallations(workspaceId as string));
  const { refresh: refreshStatus } = status;
  const { refresh: refreshUser } = user;
  const { refresh: refreshInstallations } = installations;
  const refresh = useCallback(async () => {
    workflow.refresh('workspace');
    await Promise.all([refreshStatus(), refreshUser(), refreshInstallations()]);
  }, [workflow, refreshStatus, refreshUser, refreshInstallations]);
  useEffect(() => onGithubReturn(() => { void refresh(); }), [refresh]);
  return { status, user, installations, connected, refresh };
}
