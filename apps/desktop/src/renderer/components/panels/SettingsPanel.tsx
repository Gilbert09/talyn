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
  Copy,
  LogOut,
  Pencil,
  Bug,
} from 'lucide-react';
import {
  api,
  GitHubStatus,
  GitHubUser,
  GitHubRepo,
  type PostHogCodeStatus,
} from '../../lib/api';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Card } from '../ui/card';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import { WorkspaceLogo } from '../widgets/WorkspaceLogo';
import type { WorkspaceLogo as WorkspaceLogoData } from '@fastowl/shared';
import { useWorkspaceStore, type Theme } from '../../stores/workspace';
import { useWorkspaceActions } from '../../hooks/useApi';
import { useAuth } from '../auth/AuthProvider';
import { getSupabase } from '../../lib/supabase';

// Repo-list cache (localStorage). The full repo set (user + all orgs) is
// expensive to fetch, so we cache it per workspace and only re-fetch on
// an explicit refresh or once the cache ages past the TTL.
const REPO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const repoCacheKey = (workspaceId: string) => `fastowl:github-repos:${workspaceId}`;

function readRepoCache(
  workspaceId: string
): { repos: GitHubRepo[]; fetchedAt: number } | null {
  try {
    const raw = localStorage.getItem(repoCacheKey(workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.repos) || typeof parsed.fetchedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeRepoCache(workspaceId: string, repos: GitHubRepo[], fetchedAt: number): void {
  try {
    localStorage.setItem(repoCacheKey(workspaceId), JSON.stringify({ repos, fetchedAt }));
  } catch {
    // Quota/serialization failure — non-fatal, we just won't cache.
  }
}

/** Coarse "x ago" for the repo-cache freshness hint. */
function formatAge(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

type SettingsSection =
  | 'workspace'
  | 'integrations'
  | 'account'
  | 'appearance'
  | 'developer';

export function SettingsPanel() {
  const [activeSection, setActiveSection] = useState<SettingsSection>('workspace');

  const sections = [
    { id: 'workspace' as const, icon: FolderKanban, label: 'Workspace' },
    { id: 'integrations' as const, icon: Settings, label: 'Integrations' },
    { id: 'account' as const, icon: User, label: 'Account' },
    { id: 'appearance' as const, icon: Palette, label: 'Appearance' },
    { id: 'developer' as const, icon: Bug, label: 'Developer' },
  ];

  return (
    <div className="flex h-full">
      {/* Settings Navigation */}
      <div className="w-56 border-r flex flex-col">
        <div className="p-4 border-b">
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

  // Editable name/description, re-seeded whenever the active workspace changes.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setName(currentWorkspace?.name ?? '');
    setDescription(currentWorkspace?.description ?? '');
    setConfirmDelete(false);
  }, [currentWorkspaceId, currentWorkspace?.name, currentWorkspace?.description]);

  const metaDirty =
    !!currentWorkspace &&
    (name.trim() !== currentWorkspace.name ||
      description.trim() !== (currentWorkspace.description ?? ''));
  const isOnlyWorkspace = workspaces.length <= 1;

  async function handleSaveMeta() {
    if (!currentWorkspaceId || !name.trim() || !metaDirty) return;
    setSavingMeta(true);
    try {
      await api.workspaces.update(currentWorkspaceId, {
        name: name.trim(),
        description: description.trim(),
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

            <div>
              <label className="text-sm font-medium">Description</label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Add a description..."
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
                        {repo.private && (
                          <Badge variant="outline" className="ml-auto text-xs">Private</Badge>
                        )}
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
  const { currentWorkspaceId } = useWorkspaceStore();
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [githubUser, setGithubUser] = useState<GitHubUser | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load GitHub status on mount and when workspace changes
  const loadGitHubStatus = useCallback(async () => {
    if (!currentWorkspaceId) return;

    try {
      const status = await api.github.getStatus(currentWorkspaceId);
      setGithubStatus(status);

      // If connected, load user info
      if (status.connected) {
        try {
          const user = await api.github.getUser(currentWorkspaceId);
          setGithubUser(user);
        } catch (_e) {
          // User fetch failed, but connection might still be valid
        }
      } else {
        setGithubUser(null);
      }
    } catch (_e) {
      setGithubStatus({ configured: false, connected: false });
    }
  }, [currentWorkspaceId]);

  useEffect(() => {
    loadGitHubStatus();
  }, [loadGitHubStatus]);

  // OAuth happens in the system browser, not the renderer, so we can't
  // read query params off window.location. Instead, re-check status
  // whenever the app regains focus — the user will naturally come back
  // to FastOwl after completing the flow in their browser.
  useEffect(() => {
    const onFocus = () => { void loadGitHubStatus(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [loadGitHubStatus]);

  const handleGitHubConnect = async () => {
    if (!currentWorkspaceId) return;

    setIsLoading(true);
    setError(null);

    try {
      const { authUrl } = await api.github.connect(currentWorkspaceId);
      // Open GitHub OAuth in a new window/tab
      window.open(authUrl, '_blank', 'width=600,height=700');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to start OAuth flow');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGitHubDisconnect = async () => {
    if (!currentWorkspaceId) return;

    setIsLoading(true);
    try {
      await api.github.disconnect(currentWorkspaceId);
      setGithubStatus({ configured: true, connected: false });
      setGithubUser(null);
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
                {!githubStatus?.configured && (
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
                  githubStatus?.message || 'Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET environment variables'
                )}
              </p>
            </div>
            {githubStatus?.connected ? (
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
              <Button
                onClick={handleGitHubConnect}
                disabled={isLoading || !githubStatus?.configured || !currentWorkspaceId}
              >
                {isLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  'Connect'
                )}
              </Button>
            )}
          </div>
        </Card>

        {/* PostHog Code (cloud tasks) */}
        <PostHogCodeCard />
      </div>
    </div>
  );
}

/**
 * PostHog Code (cloud tasks) credentials, per workspace. The API key is
 * write-only — once saved, the backend never returns it, so we show
 * connection state + project id and let the user re-enter to rotate.
 */
function PostHogCodeCard() {
  const { currentWorkspaceId } = useWorkspaceStore();
  const [status, setStatus] = useState<PostHogCodeStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [projectId, setProjectId] = useState('');
  const [host, setHost] = useState('https://us.posthog.com');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentWorkspaceId) return;
    try {
      const s = await api.posthog.getStatus(currentWorkspaceId);
      setStatus(s);
      if (s.projectId) setProjectId(s.projectId);
      if (s.host) setHost(s.host);
    } catch {
      setStatus({ connected: false });
    }
  }, [currentWorkspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

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
          Customize the look and feel of FastOwl
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
    </div>
  );
}

function DeveloperSettings() {
  const { debugMode, setDebugMode } = useWorkspaceStore();

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium mb-1">Developer</h3>
        <p className="text-sm text-muted-foreground">
          Tools for looking under the hood of FastOwl
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
    </div>
  );
}

function AccountSettings() {
  const { user, signOut } = useAuth();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [tokenExpiry, setTokenExpiry] = useState<string | null>(null);

  useEffect(() => {
    // Surface token expiry so users know when the CLI copy needs refreshing.
    getSupabase().auth.getSession().then(({ data }) => {
      if (data.session?.expires_at) {
        setTokenExpiry(new Date(data.session.expires_at * 1000).toLocaleString());
      }
    });
  }, []);

  async function copyCliToken() {
    setCopyError(null);
    try {
      const { data } = await getSupabase().auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        setCopyError('No active session');
        return;
      }
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : 'copy failed');
    }
  }

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

      <div>
        <h3 className="text-lg font-semibold mb-2">CLI / MCP token</h3>
        <p className="text-sm text-muted-foreground mb-3">
          Copy your current access token so the <code>fastowl</code> CLI and the MCP server can
          authenticate. Tokens rotate hourly — if a CLI request starts returning 401, copy again.
        </p>
        <Card className="p-4 space-y-3">
          <Button onClick={copyCliToken} className="gap-2">
            <Copy className="w-4 h-4" />
            {copied ? 'Copied!' : 'Copy CLI token'}
          </Button>
          {copyError && <p className="text-sm text-destructive">{copyError}</p>}
          {tokenExpiry && (
            <p className="text-xs text-muted-foreground">Current token expires: {tokenExpiry}</p>
          )}
          <div className="text-xs text-muted-foreground space-y-1">
            <p>After copying, paste into:</p>
            <pre className="bg-muted p-2 rounded text-xs overflow-x-auto">fastowl token set</pre>
            <p>or set <code>FASTOWL_AUTH_TOKEN</code> for MCP / CI use.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
