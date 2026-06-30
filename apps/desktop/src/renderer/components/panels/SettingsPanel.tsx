import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Settings,
  FolderKanban,
  Github,
  BarChart3,
  Plus,
  Trash2,
  Shuffle,
  Upload,
  Check,
  AlertCircle,
  Loader2,
  Unlink,
  RefreshCw,
  Palette,
  Sun,
  Moon,
  Monitor,
  User,
  LogOut,
  Pencil,
  Bug,
  Info,
  Globe,
  Download,
  Bot,
  Plug,
  Copy,
  KeyRound,
} from 'lucide-react';
import type { UpdaterEvent } from '../../../main/updaterEvents';
import { api, GitHubRepo, getMcpEndpoint } from '../../lib/api';
import { toast } from '../../stores/toast';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Card } from '../ui/card';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import { WorkspaceLogo } from '../widgets/WorkspaceLogo';
import { GithubInstallStatus } from '../widgets/GithubInstallStatus';
import { useGithubInstallations } from '../../hooks/useGithubInstallations';
import { isOwnerCovered } from '../../lib/githubInstall';
import { openExternal } from '../../lib/openExternal';
import type { WorkspaceLogo as WorkspaceLogoData, Workspace, McpToken } from '@talyn/shared';
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL_ID, type ClaudeModelId } from '@talyn/shared';
import { useWorkspaceStore, type Theme } from '../../stores/workspace';
import {
  useWorkspaceActions,
  getMergeBlockedNotifyEnabled,
  setMergeBlockedNotifyEnabled,
} from '../../hooks/useApi';
import { useAuth } from '../auth/AuthProvider';
import { trackEvent } from '../../lib/analytics';
import {
  REPO_CACHE_TTL_MS,
  readRepoCache,
  writeRepoCache,
  formatAge,
} from '../../lib/repoCache';

export function SettingsPanel() {
  // Section lives in the store so other surfaces (e.g. the sidebar cloud-provider
  // status, the per-task "Set default" action) can deep-link to a section.
  const activeSection = useWorkspaceStore((s) => s.settingsSection);
  const setActiveSection = useWorkspaceStore((s) => s.setSettingsSection);

  const sections = [
    { id: 'workspace' as const, icon: FolderKanban, label: 'Workspace' },
    { id: 'integrations' as const, icon: Settings, label: 'Integrations' },
    { id: 'account' as const, icon: User, label: 'Account' },
    { id: 'appearance' as const, icon: Palette, label: 'Appearance' },
    { id: 'developer' as const, icon: Bug, label: 'Developer' },
    { id: 'mcp' as const, icon: Plug, label: 'MCP server' },
    { id: 'about' as const, icon: Info, label: 'About' },
  ];

  return (
    <div className="flex h-full">
      {/* Settings Navigation */}
      <div className="w-56 border-r flex flex-col">
        <div className="app-region-drag p-4 border-b">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Settings className="w-5 h-5" />
            Settings
          </h2>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {sections.map((section) => (
            <Button
              key={section.id}
              variant={activeSection === section.id ? 'secondary' : 'ghost'}
              className="w-full justify-start gap-2"
              onClick={() => setActiveSection(section.id)}
            >
              <section.icon className="w-4 h-4" />
              {section.label}
            </Button>
          ))}
        </nav>
      </div>

      {/* Settings Content */}
      <div className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-6 max-w-2xl">
            {activeSection === 'workspace' && <WorkspaceSettings />}
            {activeSection === 'integrations' && <IntegrationsSettings />}
            {activeSection === 'account' && <AccountSettings />}
            {activeSection === 'appearance' && <AppearanceSettings />}
            {activeSection === 'developer' && <DeveloperSettings />}
            {activeSection === 'mcp' && <MCPServerSettings />}
            {activeSection === 'about' && <AboutSettings />}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

/**
 * Load an image file, downscale it to fit within `maxDim` px (preserving
 * aspect ratio), and return a PNG data URL. Keeps inline-stored logos small.
 */
function downscaleImage(file: File, maxDim: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      URL.revokeObjectURL(url);
      if (!ctx) return reject(new Error('no canvas context'));
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('could not load image'));
    };
    img.src = url;
  });
}

function WorkspaceSettings() {
  const {
    workspaces,
    currentWorkspaceId,
    setCreateWorkspaceOpen,
    setCurrentWorkspace,
    repositories: watchedRepos,
    setRepositories,
  } = useWorkspaceStore();
  const { refreshWorkspaces } = useWorkspaceActions();
  const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId);

  // Editable name, re-seeded whenever the active workspace changes.
  const [name, setName] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setName(currentWorkspace?.name ?? '');
    setConfirmDelete(false);
  }, [currentWorkspaceId, currentWorkspace?.name]);

  const metaDirty = !!currentWorkspace && name.trim() !== currentWorkspace.name;
  const isOnlyWorkspace = workspaces.length <= 1;

  async function handleSaveMeta() {
    if (!currentWorkspaceId || !name.trim() || !metaDirty) return;
    setSavingMeta(true);
    try {
      await api.workspaces.update(currentWorkspaceId, {
        name: name.trim(),
      });
      await refreshWorkspaces();
    } finally {
      setSavingMeta(false);
    }
  }

  async function handleDelete() {
    if (!currentWorkspaceId || isOnlyWorkspace) return;
    setDeleting(true);
    try {
      await api.workspaces.delete(currentWorkspaceId);
      // Switch to another workspace before the list refreshes so the UI never
      // sits on a deleted id.
      const next = workspaces.find((w) => w.id !== currentWorkspaceId);
      setCurrentWorkspace(next?.id ?? null);
      await refreshWorkspaces();
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  // ---------- Logo ----------
  const fileRef = useRef<HTMLInputElement>(null);
  const [savingLogo, setSavingLogo] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  async function saveLogo(logo: WorkspaceLogoData) {
    if (!currentWorkspaceId) return;
    setSavingLogo(true);
    setLogoError(null);
    try {
      await api.workspaces.update(currentWorkspaceId, { logo });
      await refreshWorkspaces();
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : 'Could not update logo');
    } finally {
      setSavingLogo(false);
    }
  }

  async function handleUploadLogo(file: File) {
    setLogoError(null);
    try {
      const dataUrl = await downscaleImage(file, 256);
      if (dataUrl.length > 512 * 1024) {
        setLogoError('That image is too detailed — try a smaller or simpler one.');
        return;
      }
      await saveLogo({ kind: 'image', dataUrl });
    } catch {
      setLogoError('Could not read that image.');
    }
  }

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

  const handleAddRepo = async (repo: GitHubRepo) => {
    if (!currentWorkspaceId) return;
    setLoadingRepos(true);
    try {
      const watched = await api.repositories.add(
        currentWorkspaceId,
        repo.owner.login,
        repo.name
      );
      setRepositories([...watchedRepos, watched]);
      void refreshWorkspaces();
      setShowRepoSelector(false);
      setRepoSearch('');
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
  const REPO_LIST_CAP = 500;
  const filteredRepos = matchedRepos.slice(0, REPO_LIST_CAP);
  const reposTruncated = matchedRepos.length > REPO_LIST_CAP;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium mb-1">Workspace Settings</h3>
        <p className="text-sm text-muted-foreground">
          Configure your current workspace
        </p>
      </div>

      {currentWorkspace ? (
        <>
          <Card className="p-4 space-y-4">
            <div>
              <label className="text-sm font-medium">Workspace Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1"
                disabled={savingMeta}
              />
            </div>

            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={handleSaveMeta}
                disabled={!metaDirty || !name.trim() || savingMeta}
              >
                {savingMeta ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save changes'}
              </Button>
            </div>
          </Card>

          <Card className="p-4">
            <h4 className="font-medium mb-3">Logo</h4>
            <div className="flex items-center gap-4">
              <WorkspaceLogo
                logo={currentWorkspace.logo}
                fallbackSeed={currentWorkspace.id}
                size={64}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void saveLogo({ kind: 'identicon', seed: crypto.randomUUID() })}
                  disabled={savingLogo}
                  title="Generate a new identicon"
                >
                  <Shuffle className="w-4 h-4 mr-1" />
                  Shuffle
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  disabled={savingLogo}
                >
                  <Upload className="w-4 h-4 mr-1" />
                  Upload image
                </Button>
                {savingLogo && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleUploadLogo(file);
                    e.target.value = ''; // allow re-picking the same file
                  }}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Uploads are downscaled to 256px. Shuffle to go back to a generated logo.
            </p>
            {logoError && <p className="text-xs text-destructive mt-1">{logoError}</p>}
          </Card>

          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-medium">Watched Repositories</h4>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleForcePoll}
                disabled={loadingRepos || watchedRepos.length === 0}
                title="Check for updates now"
              >
                <RefreshCw className={cn('w-4 h-4', loadingRepos && 'animate-spin')} />
              </Button>
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              Track PRs, reviews, and CI status for these repositories
            </p>

            {watchedRepos.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                No repositories being watched.
              </p>
            ) : (
              <div className="space-y-2 mb-3">
                {watchedRepos.map((repo) => (
                  <div key={repo.id} className="p-2 rounded bg-secondary">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <Github className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="text-sm truncate">{repo.fullName}</span>
                        {installsChecked && !isOwnerCovered(repo.owner, installations) && (
                          <Badge variant="warning" className="shrink-0 text-xs">
                            App not installed
                          </Badge>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                        onClick={() => handleRemoveRepo(repo.id)}
                        disabled={loadingRepos}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {githubConnected && (
              <div className="mb-3">
                <GithubInstallStatus
                  workspaceId={currentWorkspaceId ?? ''}
                  installations={installations}
                  checked={installsChecked}
                  loading={installsLoading}
                  watchedOwners={watchedRepos.map((r) => r.owner)}
                  onRefresh={refreshInstalls}
                />
              </div>
            )}

            {showRepoSelector ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="Search all your repositories…"
                    value={repoSearch}
                    onChange={(e) => setRepoSearch(e.target.value)}
                    autoFocus
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={refreshRepos}
                    disabled={reposLoading}
                    title="Re-fetch your repos + all your orgs' repos from GitHub"
                  >
                    <RefreshCw className={cn('w-4 h-4', reposLoading && 'animate-spin')} />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Your repos + every org you belong to.{' '}
                  {reposLoading
                    ? 'Refreshing…'
                    : reposFetchedAt
                      ? `Updated ${formatAge(reposFetchedAt)}.`
                      : ''}
                </p>

                {reposLoading && availableRepos.length === 0 ? (
                  <p className="text-sm text-muted-foreground p-2 flex items-center gap-2">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    Loading repositories…
                  </p>
                ) : filteredRepos.length > 0 ? (
                  <div className="border rounded-md max-h-48 overflow-y-auto">
                    {filteredRepos.map((repo) => (
                      <button
                        key={repo.id}
                        className="w-full flex items-center gap-2 p-2 hover:bg-secondary text-left text-sm"
                        onClick={() => handleAddRepo(repo)}
                        disabled={loadingRepos}
                      >
                        <Github className="w-4 h-4 text-muted-foreground" />
                        <span>{repo.full_name}</span>
                        <span className="ml-auto flex items-center gap-1">
                          {installsChecked && !isOwnerCovered(repo.owner.login, installations) && (
                            <Badge variant="warning" className="text-xs">App not installed</Badge>
                          )}
                          {repo.private && (
                            <Badge variant="outline" className="text-xs">Private</Badge>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground p-2">
                    {repoSearch
                      ? 'No matching repositories. Try Refresh if a repo is missing.'
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
                <Plus className="w-4 h-4 mr-1" />
                Add Repository
              </Button>
            )}

            {!githubConnected && (
              <p className="text-xs text-muted-foreground mt-2">
                Connect GitHub in Integrations to add repositories
              </p>
            )}
          </Card>

          <Card className="p-4 border-destructive/30">
            <h4 className="font-medium mb-1">Delete workspace</h4>
            <p className="text-sm text-muted-foreground mb-3">
              Permanently removes this workspace and its watched repos, tasks, and
              integration credentials. This cannot be undone.
            </p>
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    `Delete "${currentWorkspace.name}"`
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleting}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmDelete(true)}
                disabled={isOnlyWorkspace}
                title={
                  isOnlyWorkspace
                    ? 'You need at least one workspace'
                    : 'Delete this workspace'
                }
              >
                <Trash2 className="w-4 h-4 mr-1" />
                Delete workspace
              </Button>
            )}
          </Card>
        </>
      ) : (
        <Card className="p-6 text-center">
          <FolderKanban className="w-10 h-10 mx-auto text-muted-foreground/50 mb-3" />
          <h4 className="font-medium mb-1">No Workspace Selected</h4>
          <p className="text-sm text-muted-foreground mb-4">
            Create or select a workspace to configure settings
          </p>
          <Button onClick={() => setCreateWorkspaceOpen(true)}>
            <Plus className="w-4 h-4 mr-1" />
            Create Workspace
          </Button>
        </Card>
      )}
    </div>
  );
}

function IntegrationsSettings() {
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
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium mb-1">Integrations</h3>
        <p className="text-sm text-muted-foreground">
          Connect external services to enhance your workflow
        </p>
      </div>

      {error && (
        <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      <div className="space-y-4">
        {/* GitHub Integration */}
        <Card className="p-4">
          <div className="flex items-start gap-4">
            <div className={cn(
              'w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0',
              githubStatus?.connected ? 'bg-green-500/10' : 'bg-secondary'
            )}>
              <Github className={cn('w-5 h-5', githubStatus?.connected && 'text-green-500')} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h4 className="font-medium">GitHub</h4>
                {githubStatus?.configured === false && (
                  <Badge variant="secondary">Not Configured</Badge>
                )}
                {githubStatus?.connected && (
                  <Badge variant="default" className="bg-green-600">
                    <Check className="w-3 h-3 mr-1" />
                    Connected
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground mt-1">
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
                onClick={handleGitHubDisconnect}
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <Unlink className="w-4 h-4 mr-1" />
                    Disconnect
                  </>
                )}
              </Button>
            ) : (
              // The GitHub App (webhooks + realtime) is the only connect path —
              // a "connected" workspace always has webhooks.
              <Button
                onClick={handleGitHubAppConnect}
                disabled={isLoading || !githubStatus?.configured || !currentWorkspaceId}
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Connect GitHub'}
              </Button>
            )}
          </div>

          {githubStatus?.connected && currentWorkspaceId && (
            <div className="mt-4 border-t pt-4">
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

      </div>

      {/* Cloud providers — the vendors that run the agent loop and open PRs. */}
      <div className="space-y-3">
        <div>
          <h4 className="text-sm font-semibold">Cloud providers</h4>
          <p className="text-sm text-muted-foreground">
            Vendors that run your tasks and open PRs. Connect one or more, then choose which
            provider new tasks use by default.
          </p>
        </div>

        {/* PostHog Code (cloud tasks) */}
        <PostHogCodeCard />

        {/* Claude Code (Managed Agents). Generic card driven by the
            /cloud-providers routes — the template additional providers reuse. */}
        <CloudProviderCard
          type="claude_code"
          displayName="Claude Code"
          icon={Bot}
          blurb="Add an Anthropic API key to run tasks on Claude’s cloud sandbox (Managed Agents). GitHub access reuses this workspace’s GitHub connection."
          connectedBlurb="Cloud tasks run on Claude Managed Agents and open PRs via your GitHub connection."
          fields={[
            { key: 'anthropicApiKey', label: 'Anthropic API key', type: 'password', placeholder: 'sk-ant-...' },
          ]}
        />

        <ClaudeModelSelector />

        <CloudProviderDefaultSelector />
      </div>
    </div>
  );
}

/**
 * Which Claude model Claude Code tasks run on. Shown only when Claude Code is
 * connected. Defaults to Sonnet — PR fix/respond/review work doesn't warrant
 * Opus pricing. Persists to `workspace.settings.claudeModel`; editable without
 * re-entering the API key. Switching models just makes the next run use (and,
 * on first use, create) a reusable agent for that model.
 */
function ClaudeModelSelector() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const cloudProviders = useWorkspaceStore((s) => s.cloudProviders);
  const [saving, setSaving] = useState(false);

  const claudeConnected = (cloudProviders ?? []).some(
    (p) => p.type === 'claude_code' && p.connected,
  );
  if (!claudeConnected) return null;

  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const current = workspace?.settings?.claudeModel ?? DEFAULT_CLAUDE_MODEL_ID;

  const onChange = async (value: string) => {
    if (!currentWorkspaceId) return;
    setSaving(true);
    try {
      const claudeModel = value as ClaudeModelId;
      await api.workspaces.update(currentWorkspaceId, {
        settings: { claudeModel } as Workspace['settings'],
      });
      setWorkspaces(
        workspaces.map((w) =>
          w.id === currentWorkspaceId
            ? { ...w, settings: { ...w.settings, claudeModel } as Workspace['settings'] }
            : w,
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="flex items-center gap-4">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-secondary shrink-0">
          <Bot className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="font-medium">Claude model</h4>
          <p className="text-sm text-muted-foreground mt-1">
            Which model Claude Code tasks run on. Sonnet handles PR fixes well; Opus is more capable
            but costs more.
          </p>
        </div>
        <select
          value={current}
          disabled={saving}
          onChange={(e) => onChange(e.target.value)}
          className="shrink-0 rounded-md border bg-background px-2 py-1.5 text-sm"
        >
          {CLAUDE_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
    </Card>
  );
}

/**
 * Lets the workspace pick which cloud provider new tasks dispatch to — Auto
 * (prefer PostHog Code, else Claude), a specific connected provider, or "Ask
 * every time" (the desktop shows a per-task picker; backend auto-fixes fall
 * back to Auto). Always shown so the default is discoverable even with one (or
 * zero) providers connected. Persists to `workspace.settings.defaultCloudProvider`.
 */
function CloudProviderDefaultSelector() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  // One source of truth — preloaded + kept fresh by useSystemStatus.
  const cloudProviders = useWorkspaceStore((s) => s.cloudProviders);
  const connected = (cloudProviders ?? []).filter((p) => p.connected);
  const [saving, setSaving] = useState(false);

  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const current = (workspace?.settings?.defaultCloudProvider as string | undefined) ?? '';

  const onChange = async (value: string) => {
    if (!currentWorkspaceId) return;
    setSaving(true);
    try {
      const defaultCloudProvider = value === '' ? undefined : value;
      await api.workspaces.update(currentWorkspaceId, {
        settings: { defaultCloudProvider } as Workspace['settings'],
      });
      setWorkspaces(
        workspaces.map((w) =>
          w.id === currentWorkspaceId
            ? { ...w, settings: { ...w.settings, defaultCloudProvider } as Workspace['settings'] }
            : w
        )
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="flex items-center gap-4">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-secondary shrink-0">
          <Shuffle className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="font-medium">Default for new tasks</h4>
          <p className="text-sm text-muted-foreground mt-1">
            Which cloud provider new tasks use. “Ask every time” shows a picker on the Task button
            when more than one is connected.
          </p>
        </div>
        <select
          value={current}
          disabled={saving}
          onChange={(e) => onChange(e.target.value)}
          className="shrink-0 rounded-md border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">Auto (prefer PostHog Code)</option>
          {connected.map((p) => (
            <option key={p.type} value={p.type}>
              {p.displayName}
            </option>
          ))}
          <option value="ask">Ask every time</option>
        </select>
      </div>
    </Card>
  );
}

interface CloudProviderField {
  key: string;
  label: string;
  type?: 'text' | 'password';
  placeholder?: string;
}

/**
 * Generic Settings card for a cloud task provider, driven entirely by the
 * provider-agnostic `/cloud-providers` routes (list / config / disconnect).
 * A new provider needs only a descriptor here — no bespoke API client or
 * store wiring. (PostHogCodeCard predates this and keeps its richer
 * project/host display; it can migrate to this card later.)
 */
function CloudProviderCard({
  type,
  displayName,
  icon: Icon,
  blurb,
  connectedBlurb,
  fields,
}: {
  type: string;
  displayName: string;
  icon: React.ComponentType<{ className?: string }>;
  blurb: string;
  connectedBlurb: string;
  fields: CloudProviderField[];
}) {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  // Connection status comes from the shared store (preloaded + kept fresh by
  // useSystemStatus on focus / WS / reconnect), so leaving and returning to this
  // tab can't show a stale "Not Connected", and there's no flash on restart.
  const cloudProviders = useWorkspaceStore((s) => s.cloudProviders);
  const setCloudProviders = useWorkspaceStore((s) => s.setCloudProviders);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loaded = cloudProviders !== null;
  const connected = Boolean(cloudProviders?.find((p) => p.type === type)?.connected);

  // Reflect a connect/disconnect into the shared list so this badge, the sidebar
  // status row, and the default selector all update together (and persist across
  // tab switches) without waiting for the next focus refetch.
  const setConnectedInStore = useCallback(
    (isConnected: boolean) => {
      const list = useWorkspaceStore.getState().cloudProviders ?? [];
      const existing = list.find((p) => p.type === type);
      const next = existing
        ? list.map((p) => (p.type === type ? { ...p, connected: isConnected } : p))
        : [...list, { type, displayName, connected: isConnected }];
      setCloudProviders(next);
    },
    [type, displayName, setCloudProviders]
  );

  const handleSave = async () => {
    if (!currentWorkspaceId) return;
    const missing = fields.find((f) => !values[f.key]?.trim());
    if (missing) return;
    setIsSaving(true);
    setError(null);
    try {
      const config = Object.fromEntries(fields.map((f) => [f.key, values[f.key].trim()]));
      await api.cloudProviders.saveConfig(type, currentWorkspaceId, config);
      trackEvent('cloud_provider_connected', { provider: type });
      setConnectedInStore(true);
      setValues({});
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save credentials');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDisconnect = async () => {
    if (!currentWorkspaceId) return;
    setIsSaving(true);
    try {
      await api.cloudProviders.disconnect(type, currentWorkspaceId);
      setConnectedInStore(false);
      setValues({});
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect');
    } finally {
      setIsSaving(false);
    }
  };

  // Don't offer the form until we actually know the state — avoids flashing the
  // connect form (then the connected card) on first load / tab return.
  const showForm = editing || (loaded && !connected);
  const canSave = fields.every((f) => values[f.key]?.trim());

  return (
    <Card className="p-4">
      <div className="flex items-start gap-4">
        <div
          className={cn(
            'w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0',
            connected ? 'bg-green-500/10' : 'bg-secondary'
          )}
        >
          <Icon className={cn('w-5 h-5', connected && 'text-green-500')} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-medium">{displayName}</h4>
            {!loaded ? (
              <Badge variant="secondary">Checking…</Badge>
            ) : connected ? (
              <Badge variant="default" className="bg-green-600">
                <Check className="w-3 h-3 mr-1" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary">Not Connected</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {connected ? connectedBlurb : blurb}
          </p>

          {showForm && (
            <div className="mt-3 space-y-3">
              {fields.map((f) => (
                <Input
                  key={f.key}
                  label={f.label}
                  type={f.type ?? 'text'}
                  placeholder={f.placeholder}
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  disabled={isSaving}
                />
              ))}
              {error && (
                <div className="text-sm text-destructive flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={isSaving || !canSave || !currentWorkspaceId}
                >
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save & verify'}
                </Button>
                {connected && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(false);
                      setValues({});
                      setError(null);
                    }}
                    disabled={isSaving}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {connected && !showForm && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={isSaving}>
              <Pencil className="w-4 h-4 mr-1" />
              Edit
            </Button>
            <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={isSaving}>
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlink className="w-4 h-4" />}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * PostHog Code (cloud tasks) credentials, per workspace. The API key is
 * write-only — once saved, the backend never returns it, so we show
 * connection state + project id and let the user re-enter to rotate.
 */
function PostHogCodeCard() {
  // Status is preloaded into the store at startup (useSystemStatus), so the
  // card shows the connection state instantly. Mutations below write the fresh
  // status straight back to the store.
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const status = useWorkspaceStore((s) => s.posthogStatus);
  const setStatus = useWorkspaceStore((s) => s.setPostHogStatus);
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [projectId, setProjectId] = useState('');
  const [host, setHost] = useState('https://us.posthog.com');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the edit-form fields from the preloaded status. Deps are the scalar
  // values, so this won't clobber in-progress edits (status is stable while
  // editing) — it only fires when the preload lands or after a save.
  useEffect(() => {
    if (status?.projectId) setProjectId(status.projectId);
    if (status?.host) setHost(status.host);
  }, [status?.projectId, status?.host]);

  const handleSave = async () => {
    if (!currentWorkspaceId || !apiKey.trim() || !projectId.trim()) return;
    setIsSaving(true);
    setError(null);
    try {
      const s = await api.posthog.saveConfig(currentWorkspaceId, {
        apiKey: apiKey.trim(),
        projectId: projectId.trim(),
        host: host.trim() || undefined,
      });
      trackEvent('cloud_provider_connected', { provider: 'posthog_code' });
      setStatus(s);
      setApiKey('');
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save credentials');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDisconnect = async () => {
    if (!currentWorkspaceId) return;
    setIsSaving(true);
    try {
      await api.posthog.disconnect(currentWorkspaceId);
      setStatus({ connected: false });
      setProjectId('');
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect');
    } finally {
      setIsSaving(false);
    }
  };

  const connected = Boolean(status?.connected);
  const showForm = editing || !connected;

  return (
    <Card className="p-4">
      <div className="flex items-start gap-4">
        <div
          className={cn(
            'w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0',
            connected ? 'bg-green-500/10' : 'bg-secondary'
          )}
        >
          <BarChart3 className={cn('w-5 h-5', connected && 'text-green-500')} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-medium">PostHog Code</h4>
            {connected ? (
              <Badge variant="default" className="bg-green-600">
                <Check className="w-3 h-3 mr-1" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary">Not Connected</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {connected
              ? `Cloud tasks run under project ${status?.projectId} on ${status?.host}.`
              : 'Add a personal API key + project id to run tasks on PostHog Code’s cloud sandbox.'}
          </p>

          {showForm && (
            <div className="mt-3 space-y-3">
              <Input
                label="Personal API key"
                type="password"
                placeholder="phx_..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={isSaving}
              />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Project (team) id"
                  placeholder="e.g. 2"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  disabled={isSaving}
                />
                <Input
                  label="Host"
                  placeholder="https://us.posthog.com"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  disabled={isSaving}
                />
              </div>
              {error && (
                <div className="text-sm text-destructive flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={isSaving || !apiKey.trim() || !projectId.trim() || !currentWorkspaceId}
                >
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save & verify'}
                </Button>
                {connected && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(false);
                      setApiKey('');
                      setError(null);
                    }}
                    disabled={isSaving}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {connected && !showForm && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={isSaving}>
              <Pencil className="w-4 h-4 mr-1" />
              Edit
            </Button>
            <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={isSaving}>
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlink className="w-4 h-4" />}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function AppearanceSettings() {
  const { theme, setTheme } = useWorkspaceStore();
  const [notifyBlocked, setNotifyBlocked] = useState(getMergeBlockedNotifyEnabled());
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  );

  const toggleNotifyBlocked = async (next: boolean) => {
    setMergeBlockedNotifyEnabled(next);
    setNotifyBlocked(next);
    // Request OS permission eagerly on enable so the first real block doesn't
    // race the browser permission prompt.
    if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        setNotifyPermission(await Notification.requestPermission());
      } catch {
        // ignore
      }
    }
  };

  const themeOptions: { value: Theme; label: string; icon: typeof Sun; description: string }[] = [
    {
      value: 'light',
      label: 'Light',
      icon: Sun,
      description: 'A clean, bright interface for well-lit environments',
    },
    {
      value: 'dark',
      label: 'Dark',
      icon: Moon,
      description: 'Easy on the eyes in low-light conditions',
    },
    {
      value: 'system',
      label: 'System',
      icon: Monitor,
      description: 'Automatically matches your operating system theme',
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium mb-1">Appearance</h3>
        <p className="text-sm text-muted-foreground">
          Customize the look and feel of Talyn
        </p>
      </div>

      <Card className="p-4">
        <h4 className="font-medium mb-3">Theme</h4>
        <div className="grid grid-cols-3 gap-3">
          {themeOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => setTheme(option.value)}
              className={cn(
                'flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-colors',
                theme === option.value
                  ? 'border-primary bg-primary/5'
                  : 'border-transparent bg-secondary hover:bg-secondary/80'
              )}
            >
              <div
                className={cn(
                  'w-10 h-10 rounded-lg flex items-center justify-center',
                  theme === option.value ? 'bg-primary text-primary-foreground' : 'bg-muted'
                )}
              >
                <option.icon className="w-5 h-5" />
              </div>
              <span className="font-medium text-sm">{option.label}</span>
            </button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground mt-4">
          {themeOptions.find((o) => o.value === theme)?.description}
        </p>
      </Card>

      <Card className="p-4">
        <h4 className="font-medium mb-3">Notifications</h4>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={notifyBlocked}
            onChange={(e) => void toggleNotifyBlocked(e.target.checked)}
            className="mt-1"
          />
          <div className="flex-1">
            <div className="font-medium text-sm">
              Notify me when a merge-queue PR is blocked
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Shows a desktop notification and an in-app alert when a PR in the merge
              queue gives up after its retry budget and needs manual intervention.
              Click the notification to jump to it.
            </p>
            {notifyPermission === 'denied' && (
              <p className="text-xs text-yellow-500 mt-1">
                Desktop notifications are blocked at the OS level — grant Talyn
                permission in your system settings to receive them. (The in-app alert
                still shows.)
              </p>
            )}
          </div>
        </label>
      </Card>
    </div>
  );
}

function DeveloperSettings() {
  const { debugMode, setDebugMode } = useWorkspaceStore();
  const [wipeArmed, setWipeArmed] = useState(false);
  const [wiping, setWiping] = useState(false);

  async function handleWipe() {
    setWiping(true);
    try {
      await api.users.wipeMe();
    } catch {
      // The wipe severs our own auth mid-flight, so a late failure here is
      // expected — proceed with the local reset regardless.
    }
    try {
      localStorage.clear();
    } catch {
      // Privacy mode — nothing persisted to clear anyway.
    }
    if (isSupabaseConfigured()) {
      await getSupabase().auth.signOut({ scope: 'local' });
    }
    window.location.reload();
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium mb-1">Developer</h3>
        <p className="text-sm text-muted-foreground">
          Tools for looking under the hood of Talyn
        </p>
      </div>

      <Card className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h4 className="font-medium flex items-center gap-2">
              <Bug className="w-4 h-4" />
              Debug tools
            </h4>
            <p className="text-sm text-muted-foreground mt-1">
              Adds a <strong>Debug</strong> panel to the sidebar that surfaces app
              internals live — external requests, polling cycles, and WebSocket
              activity. Metadata only; tokens and request bodies are never shown.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={debugMode}
            onClick={() => setDebugMode(!debugMode)}
            className={cn(
              'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
              debugMode ? 'bg-primary' : 'bg-muted'
            )}
          >
            <span
              className={cn(
                'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
                debugMode ? 'translate-x-5' : 'translate-x-0.5'
              )}
            />
          </button>
        </div>
      </Card>

      <Card className="p-4 border-destructive/50">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h4 className="font-medium flex items-center gap-2 text-destructive">
              <Trash2 className="w-4 h-4" />
              Wipe account &amp; start fresh
            </h4>
            <p className="text-sm text-muted-foreground mt-1">
              Deletes your user profile, every workspace it owns (integrations,
              watched repos, PRs, tasks), and this app's local storage, then
              signs you out. The next sign-in runs onboarding from scratch.
            </p>
          </div>
          {wipeArmed ? (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setWipeArmed(false)}
                disabled={wiping}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleWipe}
                disabled={wiping}
              >
                {wiping ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  'Yes, wipe everything'
                )}
              </Button>
            </div>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              className="shrink-0"
              onClick={() => setWipeArmed(true)}
            >
              Wipe…
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

/**
 * MCP server settings — mint a long-lived personal token and copy the one-line
 * `claude mcp add` command that points a Claude client at the hosted endpoint.
 * The token authenticates the backend's `/api/v1/mcp` endpoint; it's shown in
 * full exactly once at creation, then only its prefix is ever displayed.
 */
function MCPServerSettings() {
  const endpoint = getMcpEndpoint();
  const [tokens, setTokens] = useState<McpToken[] | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The full plaintext token + command, held only until the user dismisses it
  // (we can never retrieve the secret again).
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setTokens(await api.mcpTokens.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load tokens');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const installCommand = (token: string) =>
    `claude mcp add --transport http fastowl ${endpoint} --header "Authorization: Bearer ${token}"`;

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await api.mcpTokens.create(name.trim() ? { name: name.trim() } : {});
      setFreshToken(res.token);
      setName('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create token');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await api.mcpTokens.revoke(id);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to revoke token');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-1">MCP server</h3>
        <p className="text-sm text-muted-foreground">
          Drive Talyn from a Claude client (Claude Code or Claude Desktop). Generate a
          personal token, then run the command below to connect.
        </p>
      </div>

      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Plug className="w-4 h-4" />
          <span className="font-medium">Endpoint</span>
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-muted rounded px-2 py-1.5 truncate">{endpoint}</code>
          <Button size="sm" variant="outline" onClick={() => void copy(endpoint, 'Endpoint')}>
            <Copy className="w-3.5 h-3.5" />
          </Button>
        </div>
      </Card>

      {/* Generate */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4" />
          <span className="font-medium">Generate a token</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Tokens are long-lived (90 days) and tied to your account. The full token is shown
          once — copy it now. You can revoke it any time below.
        </p>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Optional label (e.g. Laptop)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1"
          />
          <Button size="sm" onClick={() => void handleCreate()} disabled={creating}>
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
            Generate
          </Button>
        </div>
        {error && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="w-3.5 h-3.5" /> {error}
          </p>
        )}

        {freshToken && (
          <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
            <p className="text-xs font-medium flex items-center gap-1">
              <Check className="w-3.5 h-3.5 text-green-600" /> Token created — copy it now, it
              won&apos;t be shown again.
            </p>
            <div>
              <label className="text-xs text-muted-foreground">Token</label>
              <div className="flex items-center gap-2 mt-1">
                <code className="flex-1 text-xs bg-muted rounded px-2 py-1.5 truncate">
                  {freshToken}
                </code>
                <Button size="sm" variant="outline" onClick={() => void copy(freshToken, 'Token')}>
                  <Copy className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Install command</label>
              <div className="flex items-start gap-2 mt-1">
                <code className="flex-1 text-xs bg-muted rounded px-2 py-1.5 break-all whitespace-pre-wrap">
                  {installCommand(freshToken)}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void copy(installCommand(freshToken), 'Command')}
                >
                  <Copy className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setFreshToken(null)}>
              Done
            </Button>
          </div>
        )}
      </Card>

      {/* Existing tokens */}
      <Card className="p-4 space-y-3">
        <span className="font-medium">Your tokens</span>
        {tokens === null ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
          </p>
        ) : tokens.length === 0 ? (
          <p className="text-xs text-muted-foreground">No tokens yet.</p>
        ) : (
          <div className="space-y-2">
            {tokens.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-3 text-sm border-b last:border-b-0 pb-2 last:pb-0"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{t.name}</div>
                  <div className="text-xs text-muted-foreground">
                    <code>{t.tokenPrefix}…</code> · created{' '}
                    {new Date(t.createdAt).toLocaleDateString()}
                    {t.lastUsedAt
                      ? ` · last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                      : ' · never used'}
                    {t.expiresAt ? ` · expires ${new Date(t.expiresAt).toLocaleDateString()}` : ''}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => void handleRevoke(t.id)}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

const REPO_URL = 'https://github.com/Gilbert09/owl';
const SITE_URL = 'https://talyn.dev';

function openRepo() {
  if (window.electron?.auth?.openExternal) {
    void window.electron.auth.openExternal(REPO_URL);
  } else {
    window.open(REPO_URL, '_blank');
  }
}

function AboutSettings() {
  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdaterEvent | null>(null);
  const [checking, setChecking] = useState(false);
  // Set when a check runs in dev / an unpackaged build, where auto-update
  // can't operate and no events fire.
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    window.electron?.app
      ?.getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  useEffect(() => {
    return window.electron?.updater?.onEvent((e) => {
      setStatus(e);
      // A terminal event ends the in-flight check spinner.
      if (e.kind !== 'checking' && e.kind !== 'progress') setChecking(false);
    });
  }, []);

  const handleCheck = async () => {
    setUnsupported(false);
    setChecking(true);
    setStatus({ kind: 'checking' });
    try {
      const res = await window.electron?.updater?.check();
      if (res && res.started === false) {
        setUnsupported(true);
        setChecking(false);
        setStatus(null);
      }
    } catch {
      setChecking(false);
    }
  };

  const downloaded = status?.kind === 'downloaded';
  const downloading =
    status?.kind === 'available' || status?.kind === 'progress';

  let statusText: string | null = null;
  if (unsupported) {
    statusText = 'Auto-update only runs in the installed app, not in development.';
  } else if (status?.kind === 'checking') {
    statusText = 'Checking for updates…';
  } else if (status?.kind === 'not-available') {
    statusText = "You're on the latest version.";
  } else if (status?.kind === 'available') {
    statusText = `Update ${status.version} found — downloading…`;
  } else if (status?.kind === 'progress') {
    statusText = `Downloading update… ${status.percent}%`;
  } else if (status?.kind === 'downloaded') {
    statusText = `Update ${status.version} downloaded and ready to install.`;
  } else if (status?.kind === 'error') {
    statusText = `Couldn't check for updates: ${status.message}`;
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium mb-1">About</h3>
        <p className="text-sm text-muted-foreground">
          Version information and software updates
        </p>
      </div>

      <Card className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h4 className="font-medium">Talyn</h4>
            <p className="text-sm text-muted-foreground mt-1">
              Version {version ?? '—'}
            </p>
          </div>
          {downloaded ? (
            <Button
              size="sm"
              onClick={() => window.electron?.updater?.quitAndInstall()}
            >
              <Download className="w-4 h-4 mr-1.5" />
              Restart to install
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={handleCheck}
              disabled={checking || downloading}
            >
              {checking || downloading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                'Check for updates'
              )}
            </Button>
          )}
        </div>

        {statusText && (
          <p
            className={cn(
              'text-sm',
              status?.kind === 'error'
                ? 'text-destructive'
                : 'text-muted-foreground'
            )}
          >
            {statusText}
          </p>
        )}

        <div className="border-t pt-3 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void openExternal(SITE_URL)}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <Globe className="w-4 h-4" />
            talyn.dev
          </button>
          <button
            type="button"
            onClick={openRepo}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <Github className="w-4 h-4" />
            View source on GitHub
          </button>
        </div>
      </Card>
    </div>
  );
}

function AccountSettings() {
  const { user, signOut } = useAuth();

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">Account</h3>
        <Card className="p-4 space-y-4">
          <div>
            <p className="text-sm text-muted-foreground">Signed in as</p>
            <p className="font-medium">{user?.email ?? '—'}</p>
          </div>
          <Button variant="outline" onClick={signOut} className="gap-2">
            <LogOut className="w-4 h-4" /> Sign out
          </Button>
        </Card>
      </div>
    </div>
  );
}
