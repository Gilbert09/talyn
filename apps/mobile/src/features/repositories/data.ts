import { github, repositories, type GitHubRepo, type WatchedRepo } from '@talyn/client/native';
import type { RepositorySandboxSizeResponse, SandboxSizeSetting } from '@talyn/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useMobileRuntime } from '../../auth/AuthProvider';
import { useResource } from '../../workflow/hooks';
import { useRemote } from '../more/useRemote';
import { REPO_CACHE_TTL_MS } from './model';

interface Cached { repos: GitHubRepo[]; fetchedAt: number }
// The list covers every org the person belongs to, so it is kept for the app's life and refreshed on request.
const cache = new Map<string, Cached>();
export function clearRepoCache() { cache.clear(); }

/** Every repository the GitHub account can see, cached per workspace like web. */
export function useAllRepos(workspaceId: string) {
  const [state, setState] = useState<{ cached: Cached | null; loading: boolean; failed: boolean }>(
    () => ({ cached: cache.get(workspaceId) ?? null, loading: false, failed: false }));
  const latest = useRef(workspaceId);
  latest.current = workspaceId;

  const refresh = useCallback(async () => {
    const target = workspaceId;
    setState((prev) => ({ ...prev, loading: true, failed: false }));
    try {
      const repos = await github.listAllRepos(target);
      const next = { repos, fetchedAt: Date.now() };
      cache.set(target, next);
      if (latest.current === target) setState({ cached: next, loading: false, failed: false });
    } catch {
      // Keep what the cache gave.
      if (latest.current === target) setState((prev) => ({ ...prev, loading: false, failed: true }));
    }
  }, [workspaceId]);

  useEffect(() => {
    const cached = cache.get(workspaceId) ?? null;
    setState({ cached, loading: false, failed: false });
    if (!cached || Date.now() - cached.fetchedAt > REPO_CACHE_TTL_MS) void refresh();
  }, [workspaceId, refresh]);

  const { cached, loading, failed } = state;
  // Loading until the first answer, so an empty list never reads as "No repositories found".
  const firstLoad = !cached && !failed;
  return { repos: cached?.repos ?? [], fetchedAt: cached?.fetchedAt ?? null, loading, failed, firstLoad, refresh };
}

/**
 * The watched repositories, from the store the composer reads too. An add or a
 * remove shows at once and asks the store to fetch again, so the composer's
 * repository chip sees the change without a restart.
 */
export function useWatchedRepos(workspaceId: string) {
  const { workflow } = useMobileRuntime();
  const resource = useResource<WatchedRepo[]>('repositories');
  const [added, setAdded] = useState<WatchedRepo[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const server = resource.data;
  const list = useMemo(() => {
    const base = (server ?? []).filter((repo) => !removed.has(repo.id));
    const extra = added.filter((repo) => !removed.has(repo.id) && !base.some((item) => item.id === repo.id));
    return [...base, ...extra];
  }, [server, added, removed]);

  // Once the store's own copy agrees, the local changes are dropped.
  useEffect(() => {
    if (!server) return;
    setAdded((prev) => { const next = prev.filter((repo) => !server.some((item) => item.id === repo.id)); return next.length === prev.length ? prev : next; });
    setRemoved((prev) => { if (![...prev].some((id) => !server.some((item) => item.id === id))) return prev;
      return new Set([...prev].filter((id) => server.some((item) => item.id === id))); });
  }, [server]);

  const add = useCallback(async (repo: GitHubRepo) => {
    setBusy(repo.full_name);
    try {
      const watched = await repositories.add(workspaceId, repo.owner.login, repo.name);
      setAdded((prev) => [...prev, watched]);
      workflow.refresh('repositories');
      workflow.refresh('workspace');
      return watched;
    } finally { setBusy(null); }
  }, [workspaceId, workflow]);

  const remove = useCallback(async (id: string) => {
    setBusy(id);
    try {
      await repositories.remove(id);
      setRemoved((prev) => new Set(prev).add(id));
      workflow.refresh('repositories');
      workflow.refresh('workspace');
    } finally { setBusy(null); }
  }, [workflow]);

  return { list, resource, busy, add, remove };
}

/** One repository's sandbox size, and a save that keeps the screen's copy. */
export function useSandboxSize(repositoryId: string) {
  const remote = useRemote<RepositorySandboxSizeResponse>(`repo-size:${repositoryId}`, () => repositories.sandboxSize.get(repositoryId));
  const { mutate } = remote;
  const save = useCallback(async (setting: SandboxSizeSetting) => {
    const next = await repositories.sandboxSize.set(repositoryId, setting);
    mutate(() => next);
    return next;
  }, [repositoryId, mutate]);
  return { ...remote, save };
}
