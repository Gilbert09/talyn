import { useEffect, useRef, useState } from 'react';
import type { PreviewPort, RepositoryPreviewResponse, Workbench } from '@talyn/shared';
import { api, API_BASE_URL, getAccessToken } from '../lib/api';
import { openExternal } from '../lib/openExternal';
import { getWorkbenchBridge } from '../lib/workbenchBridge';
import type { WorkbenchOps } from '../lib/workbenchOps';
import { isArchivedWorkbench } from '../lib/workbenchActions';
import { toast } from '../stores/toast';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';

// The backend sets TALYN_PORT to 3000. It does not export SANDBOX_PORT_BASE.
const DEFAULT_PORTS: PreviewPort[] = [{ port: 3000 }];
const NO_PORTS: PreviewPort[] = [];

export function sessionPreviewsOffered(features: { sessionPreviews?: boolean } | null | undefined): boolean {
  return features?.sessionPreviews === true;
}

export function useSessionPreview(workbench: Workbench) {
  const offered = useWorkspaceStore((s) => sessionPreviewsOffered(s.features));
  const enabled = offered && workbench.runtime === 'sandbox' && !isArchivedWorkbench(workbench);
  const [loaded, setLoaded] = useState<{ repositoryId: string; config: RepositoryPreviewResponse } | null>(null);
  const [busy, setBusy] = useState(false);
  const opening = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    if (enabled && workbench.repositoryId) {
      void api.repositories.preview.get(workbench.repositoryId).then((config) => {
        if (!cancelled) setLoaded({ repositoryId: workbench.repositoryId, config });
      }).catch(() => {
        if (!cancelled) toast.error('Could not load the preview config');
      });
    }
    return () => { cancelled = true; };
  }, [enabled, workbench.repositoryId]);

  const config = enabled && loaded?.repositoryId === workbench.repositoryId ? loaded.config : null;
  const ports = config && config.target !== 'coder' && config.target !== 'off'
    ? config.ports.length ? config.ports : DEFAULT_PORTS
    : NO_PORTS;

  const openPreview = async (port: number, ops: WorkbenchOps) => {
    if (opening.current || !ports.some((item) => item.port === port) || ops.unavailable) return;
    opening.current = true;
    setBusy(true);
    try {
      const preview = getWorkbenchBridge()?.preview;
      if (!preview) throw new Error('Restart Talyn to enable previews.');
      let token = await getAccessToken();
      if (!token) throw new Error('Sign in to open the preview.');
      if (!useWorkbenchStore.getState().scriptOutput[workbench.id]?.run?.running) {
        await ops.runScript('run');
        token = await getAccessToken();
        if (!token) throw new Error('Sign in to open the preview.');
      }
      const current = useWorkbenchStore.getState().workbenches[workbench.id] ?? workbench;
      if (isArchivedWorkbench(current) || !sessionPreviewsOffered(useWorkspaceStore.getState().features)) return;
      const forward = await preview.start({ workbenchId: workbench.id, port, token, apiBaseUrl: API_BASE_URL });
      await openExternal(forward.url);
    } catch (error) {
      toast.error('Could not open the preview', error instanceof Error ? error.message : undefined);
    } finally {
      opening.current = false;
      setBusy(false);
    }
  };

  return { ports, busy, openPreview };
}
