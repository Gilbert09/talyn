// Merge the three skill sources for the picker / Settings: backend list
// (platform + repo-discovered + usage stats) and the local ~/.claude/skills
// listing over IPC. Refetches on every mount — the picker opens rarely and
// local skills have no watcher.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListSkillsResponse, SkillSummary, SkillUsageEntry } from '@talyn/shared';
import { api } from '../lib/api';
import { toLocalSkillSummaries } from '../lib/skills';
import type { LocalSkillFile } from '../../main/preload';

export interface UseSkillsResult {
  /** All sources merged: repo skills, platform skills, local skills. */
  skills: SkillSummary[];
  /** Raw IPC listing — the launch flow reads local content from here. */
  localFiles: LocalSkillFile[];
  usage: Record<string, SkillUsageEntry>;
  repoStatus: ListSkillsResponse['repoStatus'];
  loading: boolean;
  error: string | null;
  /** Re-fetch; `refreshRepo` busts the backend's repo-skill cache. */
  refresh: (opts?: { refreshRepo?: boolean }) => Promise<void>;
}

export function useSkills(
  workspaceId: string | null,
  repositoryId: string | null
): UseSkillsResult {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [localFiles, setLocalFiles] = useState<LocalSkillFile[]>([]);
  const [usage, setUsage] = useState<Record<string, SkillUsageEntry>>({});
  const [repoStatus, setRepoStatus] = useState<ListSkillsResponse['repoStatus']>('none');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const refresh = useCallback(
    async (opts: { refreshRepo?: boolean } = {}) => {
      if (!workspaceId) return;
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      // Local listing must not fail the whole load (and vice versa).
      const [backend, local] = await Promise.allSettled([
        api.skills.list(workspaceId, repositoryId ?? undefined, opts.refreshRepo),
        window.electron.skills.listLocal(),
      ]);
      if (seq !== requestSeq.current) return; // stale response — a newer refresh ran
      const files = local.status === 'fulfilled' ? local.value : [];
      setLocalFiles(files);
      const localSummaries = toLocalSkillSummaries(files);
      if (backend.status === 'fulfilled') {
        setSkills([...backend.value.repo, ...backend.value.platform, ...localSummaries]);
        setUsage(backend.value.usage);
        setRepoStatus(backend.value.repoStatus);
      } else {
        setSkills(localSummaries);
        setUsage({});
        setRepoStatus('error');
        setError(
          backend.reason instanceof Error ? backend.reason.message : 'Failed to load skills'
        );
      }
      setLoading(false);
    },
    [workspaceId, repositoryId]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { skills, localFiles, usage, repoStatus, loading, error, refresh };
}
