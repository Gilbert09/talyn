import { useEffect, useState } from 'react';
import { api, type GitHubOwnerCoverage } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';

export function useGithubCoverage(workspaceId: string | null, uncovered: string[]) {
  const key = JSON.stringify([workspaceId, uncovered]);
  const enabled = Boolean(workspaceId && uncovered.length > 0);
  const [result, setResult] = useState<{
    key: string;
    coverage: GitHubOwnerCoverage[] | null;
  } | null>(null);

  useEffect(() => {
    if (!workspaceId || !enabled) return;
    let disposed = false;
    let request = 0;
    const refresh = async () => {
      const current = ++request;
      try {
        const coverage = await api.github.coverage(workspaceId);
        if (!disposed && current === request) setResult({ key, coverage });
      } catch {
        if (!disposed && current === request) setResult({ key, coverage: null });
      }
    };
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      disposed = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [workspaceId, enabled, key]);

  // undefined while the answer for this set of owners is loading, null when it failed.
  const coverage = result?.key === key ? result.coverage : undefined;

  // Publish the same answer the banner renders, so PR rows label polled repos
  // without a second request.
  const setGitHubCoverage = useWorkspaceStore((s) => s.setGitHubCoverage);
  useEffect(() => {
    setGitHubCoverage(coverage ?? null);
  }, [coverage, setGitHubCoverage]);

  return coverage;
}
