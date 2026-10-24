import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Github, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import type { WorkbenchConfig } from '@talyn/shared';
import { api, GitHubRepo } from '../../../lib/api';
import { cn } from '../../../lib/utils';
import { isOwnerCovered, parseRepoInput } from '../../../lib/githubInstall';
import { autoDetectCheckouts } from '../../../lib/checkoutDetection';
import { getWorkbenchBridge } from '../../../lib/workbenchBridge';
import {
  REPO_CACHE_TTL_MS,
  readRepoCache,
  writeRepoCache,
  formatAge,
} from '../../../lib/repoCache';
import { useGithubInstallations } from '../../../hooks/useGithubInstallations';
import { useWorkspaceActions } from '../../../hooks/useApi';
import { useWorkspaceStore, type WatchedRepo } from '../../../stores/workspace';
import { localPathFor } from '../../../pages/NewWorkbenchPage';
import { useRepoPaths } from '../../workbench/new/useRepoPaths';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { SettingsPage, SettingsSection } from '../../ui/settings';
import { GithubInstallStatus } from '../../widgets/GithubInstallStatus';
import { RepositoryPreviewSettings } from './RepositoryPreviewSettings';
import { PollingOnlyBadge } from '../../widgets/PollingOnlyBadge';

export function RepositoriesSettings() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const watchedRepos = useWorkspaceStore((s) => s.repositories);
  const setRepositories = useWorkspaceStore((s) => s.setRepositories);
  const { refreshWorkspaces } = useWorkspaceActions();
  const local = useLocalCheckouts(watchedRepos);

  // Repository state. The watched-repo list lives in the shared workspace
  // store (not local state) so adds/removes here propagate immediately to
  // every other repo dropdown in the app — GitHub panel, task composer —
  // instead of going stale until the next app refresh.
  // The full set of repos the user can watch (own + every org's),
  // hydrated from a localStorage cache and refreshed on demand.
  const [availableRepos, setAvailableRepos] = useState<GitHubRepo[]>([]);
  const [reposFetchedAt, setReposFetchedAt] = useState<number | null>(null);
  const [reposLoading, setReposLoading] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [showRepoSelector, setShowRepoSelector] = useState(false);
  const [repoSearch, setRepoSearch] = useState('');
  const [addRepoError, setAddRepoError] = useState<string | null>(null);
  // App-installation coverage for the watched repos' orgs.
  const {
    installations,
    checked: installsChecked,
    loading: installsLoading,
    refresh: refreshInstalls,
  } = useGithubInstallations(currentWorkspaceId, githubConnected);

  // Fetch the full repo set from GitHub (user + all orgs) and cache it.
  // This is the expensive call, so it only runs on a cache miss/stale or
  // an explicit refresh — never on every picker open.
  const refreshRepos = useCallback(async () => {
    if (!currentWorkspaceId) return;
    setReposLoading(true);
    try {
      const repos = await api.github.listAllRepos(currentWorkspaceId);
      const now = Date.now();
      setAvailableRepos(repos);
      setReposFetchedAt(now);
      writeRepoCache(currentWorkspaceId, repos, now);
    } catch (_e) {
      // Keep whatever the cache gave us.
    } finally {
      setReposLoading(false);
    }
  }, [currentWorkspaceId]);

  // Load watched repos + GitHub status. Repos hydrate from the
  // localStorage cache for instant render; a stale/empty cache triggers
  // a background refresh.
  const loadRepos = useCallback(async () => {
    if (!currentWorkspaceId) return;

    try {
      const watched = await api.repositories.list(currentWorkspaceId);
      setRepositories(watched);
    } catch (_e) {
      // Ignore errors
    }

    try {
      const status = await api.github.getStatus(currentWorkspaceId);
      setGithubConnected(status.connected);
      if (!status.connected) return;

      const cached = readRepoCache(currentWorkspaceId);
      if (cached) {
        setAvailableRepos(cached.repos);
        setReposFetchedAt(cached.fetchedAt);
      }
      if (!cached || Date.now() - cached.fetchedAt > REPO_CACHE_TTL_MS) {
        void refreshRepos();
      }
    } catch (_e) {
      setGithubConnected(false);
    }
  }, [currentWorkspaceId, refreshRepos, setRepositories]);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  // Takes owner/name rather than a picker entry, so a repo the user does not
  // belong to (an open-source repo they contribute to) can be added by name.
  const handleAddRepo = async (owner: string, repoName: string) => {
    if (!currentWorkspaceId) return;
    setLoadingRepos(true);
    setAddRepoError(null);
    try {
      const watched = await api.repositories.add(currentWorkspaceId, owner, repoName);
      setRepositories([...watchedRepos, watched]);
      void refreshWorkspaces();
      setShowRepoSelector(false);
      setRepoSearch('');
    } catch (err) {
      setAddRepoError(err instanceof Error ? err.message : `Could not add ${owner}/${repoName}`);
    } finally {
      setLoadingRepos(false);
    }
  };

  const handleRemoveRepo = async (repoId: string) => {
    setLoadingRepos(true);
    try {
      await api.repositories.remove(repoId);
      setRepositories(watchedRepos.filter((r) => r.id !== repoId));
      void refreshWorkspaces();
    } finally {
      setLoadingRepos(false);
    }
  };

  const handleForcePoll = async () => {
    setLoadingRepos(true);
    try {
      await api.repositories.forcePoll();
    } finally {
      setLoadingRepos(false);
    }
  };

  // Candidate repos (all accessible), minus already-watched, sorted
  // alphabetically so owners cluster and the list is browsable without
  // searching. Capped only to keep the DOM bounded on huge accounts.
  const matchedRepos = availableRepos
    .filter((repo) => !watchedRepos.some((w) => w.fullName === repo.full_name))
    .filter((repo) =>
      repoSearch
        ? repo.full_name.toLowerCase().includes(repoSearch.toLowerCase())
        : true
    )
    .sort((a, b) =>
      a.full_name.toLowerCase().localeCompare(b.full_name.toLowerCase())
    );
  // A typed `owner/name` or URL that the picker does not list yet: the user's
  // repo list only covers their own account and orgs.
  const typedRepo = parseRepoInput(repoSearch);
  const typedRepoAddable =
    typedRepo !== null &&
    !watchedRepos.some((w) => w.fullName.toLowerCase() === `${typedRepo.owner}/${typedRepo.repo}`.toLowerCase()) &&
    !matchedRepos.some((r) => r.full_name.toLowerCase() === `${typedRepo.owner}/${typedRepo.repo}`.toLowerCase());
  const REPO_LIST_CAP = 500;
  const filteredRepos = matchedRepos.slice(0, REPO_LIST_CAP);
  const reposTruncated = matchedRepos.length > REPO_LIST_CAP;

  return (
    <SettingsPage title="Repositories" description="Track PRs, reviews, and CI status for these repositories">
      <SettingsSection
        title="Watched repositories"
        actions={
          <div className="flex items-center gap-1">
            {local.available && (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void local.addScanRoot()}>
                Scan another folder…
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => { void handleForcePoll(); void local.refresh(); }}
              disabled={loadingRepos || watchedRepos.length === 0}
              title="Check for updates now"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', (loadingRepos || local.detecting) && 'animate-spin')} />
            </Button>
          </div>
        }
      >
        {local.scanRoots.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 px-3 py-1 text-[11px] text-muted-foreground">
            <span>Also scanning:</span>
            {local.scanRoots.map((root) => (
              <span key={root} className="inline-flex items-center gap-1" title={root}>
                {local.displayPath(root)}
                <button type="button" aria-label={`Stop scanning ${root}`} onClick={() => void local.removeScanRoot(root)}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {watchedRepos.length === 0 ? (
          <p className="px-3 py-2 text-[13px] text-muted-foreground">
            No repositories being watched.
          </p>
        ) : (
          watchedRepos.map((repo) => (
            <RepoRow
              key={repo.id}
              repo={repo}
              local={local}
              disabled={loadingRepos}
              onRemove={() => void handleRemoveRepo(repo.id)}
            />
          ))
        )}

        <div className="space-y-2 px-3 py-2">
          {showRepoSelector ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Search your repositories, or type owner/name…"
                  value={repoSearch}
                  onChange={(e) => {
                    setRepoSearch(e.target.value);
                    setAddRepoError(null);
                  }}
                  autoFocus
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={refreshRepos}
                  disabled={reposLoading}
                  title="Re-fetch your repos + all your orgs' repos from GitHub"
                >
                  <RefreshCw className={cn('w-3.5 h-3.5', reposLoading && 'animate-spin')} />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Your repos + every org you belong to. For any other repo, type its
                owner/name or paste its URL.{' '}
                {reposLoading
                  ? 'Refreshing…'
                  : reposFetchedAt
                    ? `Updated ${formatAge(reposFetchedAt)}.`
                    : ''}
              </p>

              {typedRepo && typedRepoAddable && (
                <button
                  data-attr="settings-add-repo-by-name"
                  className="w-full flex items-center gap-2 rounded-md border px-2 py-1.5 hover:bg-secondary text-left text-[13px]"
                  onClick={() => void handleAddRepo(typedRepo.owner, typedRepo.repo)}
                  disabled={loadingRepos}
                >
                  <Plus className="w-3.5 h-3.5 text-muted-foreground" />
                  <span>
                    Add <span className="font-medium">{typedRepo.owner}/{typedRepo.repo}</span>
                  </span>
                  {installsChecked && !isOwnerCovered(typedRepo.owner, installations) && (
                    <Badge
                      variant="outline"
                      className="ml-auto"
                      title={`The Talyn GitHub App isn't installed on @${typedRepo.owner}. A public repo there is polled every few minutes instead of updated live.`}
                    >
                      Polled
                    </Badge>
                  )}
                </button>
              )}
              {addRepoError && <p className="text-xs text-destructive">{addRepoError}</p>}

              {reposLoading && availableRepos.length === 0 ? (
                <p className="text-[13px] text-muted-foreground p-2 flex items-center gap-2">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  Loading repositories…
                </p>
              ) : filteredRepos.length > 0 ? (
                <div className="border rounded-md max-h-48 overflow-y-auto">
                  {filteredRepos.map((repo) => (
                    <button
                      key={repo.id}
                      className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-secondary text-left text-[13px]"
                      onClick={() => void handleAddRepo(repo.owner.login, repo.name)}
                      disabled={loadingRepos}
                    >
                      <Github className="w-3.5 h-3.5 text-muted-foreground" />
                      <span>{repo.full_name}</span>
                      <span className="ml-auto flex items-center gap-1">
                        {installsChecked && !isOwnerCovered(repo.owner.login, installations) && (
                          <Badge
                            variant="outline"
                            title={`The Talyn GitHub App isn't installed on @${repo.owner.login}. Talyn polls this repo every few minutes instead of getting live updates.`}
                          >
                            App not installed
                          </Badge>
                        )}
                        {repo.private && (
                          <Badge variant="outline">Private</Badge>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              ) : typedRepoAddable ? null : (
                <p className="text-[13px] text-muted-foreground p-2">
                  {repoSearch
                    ? 'No matching repositories. Try Refresh, or type owner/name to add any repo.'
                    : 'No repositories found. Try Refresh.'}
                </p>
              )}
              {reposTruncated && (
                <p className="text-xs text-muted-foreground">
                  Showing first {REPO_LIST_CAP} of {matchedRepos.length}. Type to narrow.
                </p>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowRepoSelector(false);
                  setRepoSearch('');
                  setAddRepoError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowRepoSelector(true)}
              disabled={!githubConnected}
            >
              <Plus className="w-3.5 h-3.5" />
              Add Repository
            </Button>
          )}

          {!githubConnected && (
            <p className="text-xs text-muted-foreground">
              Connect GitHub in Integrations to add repositories
            </p>
          )}
        </div>
      </SettingsSection>

      {githubConnected && (
        <GithubInstallStatus
          workspaceId={currentWorkspaceId ?? ''}
          installations={installations}
          checked={installsChecked}
          loading={installsLoading}
          watchedOwners={watchedRepos.map((r) => r.owner)}
          onRefresh={refreshInstalls}
        />
      )}
    </SettingsPage>
  );
}

interface LocalCheckouts {
  available: boolean;
  detecting: boolean;
  scanRoots: string[];
  addScanRoot: () => Promise<void>;
  removeScanRoot: (root: string) => Promise<void>;
  pathFor: (repoFullName: string) => string | null;
  candidatesFor: (repoFullName: string) => string[];
  displayPath: (path: string) => string;
  foundAutomatically: (repoFullName: string) => boolean;
  refresh: () => Promise<void>;
  select: (repoFullName: string, path: string) => Promise<void>;
  choose: (repoFullName: string) => Promise<string | null>;
  clear: (repoFullName: string) => Promise<void>;
}

/**
 * `useRepoPaths` plus Clear. After a clear the hook's own map is stale until
 * the next pick (which re-reads it), so the bridge's answer is kept here.
 */
function useLocalCheckouts(watchedRepos: WatchedRepo[]): LocalCheckouts {
  const repoPaths = useRepoPaths();
  const [afterClear, setAfterClear] = useState<Record<string, string> | null>(null);
  const [candidates, setCandidates] = useState<Record<string, string[]>>({});
  const [found, setFound] = useState<Record<string, string>>({});
  const [detecting, setDetecting] = useState(false);
  const [scanRoots, setScanRoots] = useState<string[]>([]);
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    void getWorkbenchBridge()?.repoPaths?.homeDir?.().then(setHome).catch(() => undefined);
  }, []);
  const paths = afterClear ?? repoPaths.paths;
  const names = watchedRepos.map((repo) => repo.fullName).join('\n');

  const refresh = useCallback(async () => {
    if (!repoPaths.ready) return;
    setDetecting(true);
    try {
      const result = await autoDetectCheckouts(names.split('\n'));
      if (result.map) setAfterClear(result.map);
      setFound((previous) => ({ ...previous, ...result.found }));
      setCandidates(result.choices);
    } catch {
      setCandidates({});
    } finally {
      setDetecting(false);
    }
  }, [names, repoPaths.ready]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const bridge = getWorkbenchBridge();
    if (!bridge?.repoPaths?.scanRoots) return;
    let active = true;
    void bridge.repoPaths.scanRoots.get().then((roots) => {
      if (active) setScanRoots(roots);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const addScanRoot = async () => {
    const roots = await getWorkbenchBridge()?.repoPaths?.scanRoots?.add();
    if (!roots) return;
    setScanRoots(roots);
    await refresh();
  };

  const removeScanRoot = async (root: string) => {
    const roots = await getWorkbenchBridge()?.repoPaths?.scanRoots?.remove(root);
    if (roots) setScanRoots(roots);
  };

  const pathFor = (repoFullName: string) => localPathFor(paths, repoFullName);

  const choose = async (repoFullName: string): Promise<string | null> => {
    const picked = await repoPaths.pickFolder(repoFullName);
    setAfterClear(null);
    if (picked?.repoFullName && picked.repoFullName.toLowerCase() !== repoFullName.toLowerCase()) {
      return `That folder is a checkout of ${picked.repoFullName}, not ${repoFullName}.`;
    }
    if (picked) {
      setCandidates((previous) => ({ ...previous, [repoFullName.toLowerCase()]: [] }));
      setFound((previous) => ({ ...previous, [repoFullName.toLowerCase()]: '' }));
    }
    return null;
  };

  const select = async (repoFullName: string, path: string) => {
    const bridge = getWorkbenchBridge();
    if (!bridge?.repoPaths) return;
    const map = await bridge.repoPaths.set({ repoFullName, path });
    setAfterClear(map);
    setCandidates((previous) => ({ ...previous, [repoFullName.toLowerCase()]: [] }));
    setFound((previous) => ({ ...previous, [repoFullName.toLowerCase()]: '' }));
  };

  const clear = async (repoFullName: string) => {
    const bridge = getWorkbenchBridge();
    if (!bridge?.repoPaths) return;
    const want = repoFullName.toLowerCase();
    const key = Object.keys(paths).find((k) => k.toLowerCase() === want) ?? repoFullName;
    setAfterClear(await bridge.repoPaths.remove(key));
    setFound((previous) => ({ ...previous, [want]: '' }));
  };

  return {
    available: repoPaths.available,
    detecting,
    scanRoots,
    addScanRoot,
    removeScanRoot,
    pathFor,
    candidatesFor: (name) => candidates[name.toLowerCase()] ?? [],
    displayPath: (candidate) => {
      if (!home) return candidate;
      const separator = home.includes('\\') ? '\\' : '/';
      return candidate === home || candidate.startsWith(`${home}${separator}`)
        ? `~${candidate.slice(home.length)}`
        : candidate;
    },
    foundAutomatically: (name) => found[name.toLowerCase()] === pathFor(name),
    refresh,
    select,
    choose,
    clear,
  };
}

function RepoRow({
  repo,
  local,
  disabled,
  onRemove,
}: {
  repo: WatchedRepo;
  local: LocalCheckouts;
  disabled: boolean;
  onRemove: () => void;
}) {
  const path = local.pathFor(repo.fullName);
  const candidates = path ? [] : local.candidatesFor(repo.fullName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<string | null | void>) => {
    setBusy(true);
    setError(null);
    try {
      setError((await fn()) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that folder.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1 px-3 py-2 text-[13px]">
      <div className="flex items-center gap-2">
        <Github className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{repo.fullName}</span>
        <PollingOnlyBadge owner={repo.owner} />
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 w-7 p-0 text-red-500 hover:bg-red-500/10 hover:text-red-600"
          onClick={onRemove}
          disabled={disabled}
          title="Stop watching"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {local.available && (
        <div className="flex items-center gap-2 pl-[22px]">
          {path ? (
            <>
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={path}>
                {path}
              </span>
              {local.foundAutomatically(repo.fullName) && (
                <span className="shrink-0 text-[11px] text-muted-foreground">Found automatically</span>
              )}
            </>
          ) : candidates.length > 1 ? (
            <>
              <span className="shrink-0 text-[11px] text-muted-foreground">Found {candidates.length} checkouts</span>
              <select
                aria-label={`Choose checkout for ${repo.fullName}`}
                className="min-w-0 max-w-48 rounded border border-input bg-background px-1 py-0.5 text-[11px] text-foreground"
                defaultValue=""
                onChange={(event) => void run(() => local.select(repo.fullName, event.target.value))}
                disabled={busy}
              >
                <option value="" disabled>Choose checkout</option>
                {candidates.map((candidate) => (
                  <option key={candidate} value={candidate}>{local.displayPath(candidate)}</option>
                ))}
              </select>
            </>
          ) : (
            <span className="text-[11px] text-muted-foreground">No local checkout on this computer</span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => void run(() => local.choose(repo.fullName))} disabled={busy}>
              <FolderOpen className="h-3.5 w-3.5" />
              Choose folder…
            </Button>
            {path && (
              <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => void run(() => local.clear(repo.fullName))} disabled={busy}>
                <X className="h-3.5 w-3.5" />
                Clear
              </Button>
            )}
          </div>
        </div>
      )}
      {error && <p className="pl-[22px] text-xs text-destructive">{error}</p>}
      <RepositoryPreviewSettings repositoryId={repo.id} repoName={repo.fullName} />
      {path && <RepoScripts path={path} />}
    </div>
  );
}

/** The repository's scripts as the local runtime resolves them, read from the checkout. */
function RepoScripts({ path }: { path: string }) {
  const [config, setConfig] = useState<WorkbenchConfig | null>(null);

  useEffect(() => {
    const bridge = getWorkbenchBridge();
    if (!bridge) return undefined;
    let cancelled = false;
    setConfig(null);
    void bridge.readConfig(path).then((value) => {
      if (!cancelled) setConfig(value);
    }).catch(() => {
      if (!cancelled) setConfig(null);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (!config) return null;
  const scripts: Array<[string, string]> = [
    ...(config.source === 'none' && config.detected?.setup
      ? [['Detected setup', config.detected.setup.command] as [string, string]] : []),
    ...(config.source === 'none' && config.detected?.run
      ? [['Detected run', config.detected.run.command] as [string, string]] : []),
    ...(config.setup ? [['Setup', config.setup.command] as [string, string]] : []),
    ...config.run.map((r) => [config.run.length > 1 ? `Run · ${r.name}` : 'Run', r.command] as [string, string]),
    ...(config.archive ? [['Archive', config.archive.command] as [string, string]] : []),
  ];

  return (
    <div className="space-y-0.5 pl-[22px] text-[11px] text-muted-foreground">
      {scripts.length === 0 ? (
        <p>No scripts. Add them in .talyn/settings.toml.</p>
      ) : (
        scripts.map(([label, command]) => (
          <p key={label} className="flex gap-2">
            <span className="w-24 shrink-0">{label}</span>
            <span className="min-w-0 truncate font-mono" title={command}>
              {command}
            </span>
          </p>
        ))
      )}
      {config.errors.map((e) => (
        <p key={e} className="text-destructive">
          {e}
        </p>
      ))}
    </div>
  );
}
