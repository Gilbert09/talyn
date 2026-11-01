import { useCallback, useEffect, useState } from 'react';
import { bridgeErrorMessage, getWorkbenchBridge } from '../../../lib/workbenchBridge';

export interface RepoPathsState {
  /** `owner/name` → local checkout. Empty outside the desktop app. */
  paths: Record<string, string>;
  ready: boolean;
  /** Null when there is no local bridge (an older main process, or a test). */
  available: boolean;
  /**
   * The native folder picker. The main process reads the folder's GitHub
   * remote and records the mapping itself. Resolves to the repository the
   * folder is a checkout of, or null when cancelled.
   */
  pickFolder: (expectRepo?: string) => Promise<{ path: string; repoFullName: string | null } | null>;
}

/** The per-machine map of repository to local checkout, kept in Electron userData. */
export function useRepoPaths(): RepoPathsState {
  const bridge = getWorkbenchBridge();
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!bridge?.repoPaths) return undefined;
    let cancelled = false;
    bridge.repoPaths
      .get()
      .then((map) => {
        if (!cancelled) {
          setPaths(map);
          setReady(true);
        }
      })
      .catch(() => { if (!cancelled) setReady(true); });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const pickFolder = useCallback(
    async (expectRepo?: string) => {
      if (!bridge) return null;
      let path: string | null;
      try {
        // Main refuses a folder that is not a checkout of `expectRepo`, and says why.
        path = await bridge.pickRepoFolder(expectRepo);
      } catch (err) {
        throw new Error(bridgeErrorMessage(err, 'Could not read that folder.'));
      }
      if (!path) return null;
      let map = (await bridge.repoPaths?.get().catch(() => null)) ?? {};
      const names = Object.keys(map).filter((name) => map[name] === path);
      let repoFullName = names.find((name) => name.toLowerCase() === expectRepo?.toLowerCase()) ?? names[0] ?? null;
      // An older main process does not record the folder for `expectRepo`. `set` checks it.
      if (!repoFullName && expectRepo && bridge.repoPaths) {
        map = await bridge.repoPaths.set({ repoFullName: expectRepo, path });
        repoFullName = expectRepo;
      }
      setPaths(map);
      return { path, repoFullName };
    },
    [bridge]
  );

  return { paths, ready, available: Boolean(bridge?.repoPaths), pickFolder };
}
