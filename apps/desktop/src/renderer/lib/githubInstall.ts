import { api, type GitHubInstallation, type GitHubOwnerCoverage } from './api';

/**
 * Helpers shared by every surface that reasons about GitHub App *installation
 * coverage*: onboarding, Settings, the global banner and the PR rows. GitHub
 * sends webhooks only for repos whose owner has an active (non-suspended) App
 * installation. Talyn still tracks a public repo without one, but it refreshes
 * on the reconcile sweep every few minutes instead of live. These turn the raw
 * installation list into the owner-level checks the UI needs, and start the
 * install flow in the browser.
 */

/** Open the GitHub App flow in the system browser. `connect` runs OAuth authorize
 *  (first connection); `manage` opens the installations page to add the App to
 *  another org or change which repos it can access. */
export async function openGithubAppFlow(
  workspaceId: string,
  mode: 'connect' | 'manage'
): Promise<void> {
  const { installUrl, manageUrl } = await api.github.installViaApp(workspaceId);
  const url = mode === 'manage' ? manageUrl : installUrl;
  await openGithubExternalUrl(url);
}

export async function openGithubExternalUrl(url: string): Promise<void> {
  if (window.electron?.auth?.openExternal) {
    await window.electron.auth.openExternal(url);
  } else {
    window.open(url, '_blank');
  }
}

/** Lowercased account logins with an active (non-suspended) installation. */
export function installedAccounts(installations: GitHubInstallation[]): Set<string> {
  return new Set(
    installations.filter((i) => !i.suspended).map((i) => i.accountLogin.toLowerCase())
  );
}

/** True when the App is installed (and active) on `owner`. */
export function isOwnerCovered(
  owner: string,
  installations: GitHubInstallation[]
): boolean {
  return installedAccounts(installations).has(owner.toLowerCase());
}

/**
 * Distinct owners (original casing, sorted) from `owners` that have no active
 * installation — the accounts the user must install the App on for those repos
 * to be tracked.
 */
export function uncoveredOwners(
  owners: string[],
  installations: GitHubInstallation[]
): string[] {
  const covered = installedAccounts(installations);
  const seen = new Map<string, string>();
  for (const owner of owners) {
    const key = owner.toLowerCase();
    if (!covered.has(key) && !seen.has(key)) seen.set(key, owner);
  }
  return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** Human-readable "@a, @b and @c" list of account logins. */
export function formatOwnerList(owners: string[]): string {
  const tagged = owners.map((o) => `@${o}`);
  if (tagged.length <= 1) return tagged.join('');
  if (tagged.length === 2) return `${tagged[0]} and ${tagged[1]}`;
  return `${tagged.slice(0, -1).join(', ')} and ${tagged[tagged.length - 1]}`;
}

/**
 * True when GitHub sends no webhooks for `owner`'s repos, so its PRs refresh
 * on the poll and not live. It needs the backend's diagnosis to say so:
 * `not_installed` and `suspended` mean no webhooks. `sso_required` and
 * `not_accessible` mean the App IS installed and the problem is the user's
 * sign-in, which the banner reports with its own action, so no row label.
 * Not loaded and `unknown` give false too, because a guessed label is worse
 * than none. Owner-level only: a repo left out of a "selected repositories"
 * install also gets no webhooks, and this does not see that.
 */
export function isPollingOnlyOwner(
  owner: string,
  installations: GitHubInstallation[] | null,
  coverage: GitHubOwnerCoverage[] | null
): boolean {
  if (!Array.isArray(installations) || !Array.isArray(coverage)) return false;
  if (isOwnerCovered(owner, installations)) return false;
  const key = owner.toLowerCase();
  const diagnosis = coverage.find((entry) => entry.owner.toLowerCase() === key);
  return diagnosis?.state === 'not_installed' || diagnosis?.state === 'suspended';
}

export function pollingOnlyTooltip(owner: string): string {
  return `Talyn's GitHub App isn't installed on @${owner}, so this PR refreshes every few minutes instead of live.`;
}

/**
 * `owner/repo` from what a user types into the repo picker: the short form or
 * any github.com URL. Null for anything else, including a bare search word.
 */
export function parseRepoInput(input: string): { owner: string; repo: string } | null {
  const raw = input.trim();
  const m =
    raw.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i) ??
    raw.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) return null;
  if (m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') return null;
  return { owner: m[1], repo: m[2] };
}
