import { useEffect, useRef, useState } from 'react';
import { workbenchesOffered, type PreviewPort, type RepositoryPreviewResponse, type Workbench } from '@talyn/shared';
import { api, API_BASE_URL, getAccessToken } from '../lib/api';
import { openExternal } from '../lib/openExternal';
import { getWorkbenchBridge } from '../lib/workbenchBridge';
import { previewPortAnswers } from '../lib/previewProbe';
import type { WorkbenchOps } from '../lib/workbenchOps';
import { isArchivedWorkbench } from '../lib/workbenchActions';
import { toast } from '../stores/toast';
import { useWorkbenchStore } from '../stores/workbenches';
import { usePreviewStatusStore, previewKey, type PreviewPortState } from '../stores/previewStatus';
import { useWorkspaceStore } from '../stores/workspace';

// The backend sets TALYN_PORT to 3000. It does not export SANDBOX_PORT_BASE.
const DEFAULT_PORTS: PreviewPort[] = [{ port: 3000 }];
const NO_PORTS: PreviewPort[] = [];
const PROBE_EVERY_MS = 1500;
/** A first run installs dependencies before the dev server starts. */
const START_TIMEOUT_MS = 10 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const runScriptRunning = (workbenchId: string) =>
  useWorkbenchStore.getState().scriptOutput[workbenchId]?.run?.running ?? false;

/**
 * Wait until the app answers on `port`. Fails when the run script stops, or
 * when the app has not answered after START_TIMEOUT_MS.
 */
async function waitForPort(workbenchId: string, port: number): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  // The run script's "running" state arrives over the WebSocket after the start call.
  const graceUntil = Date.now() + 10_000;
  for (;;) {
    if (await previewPortAnswers(workbenchId, port)) return;
    if (Date.now() > graceUntil && !runScriptRunning(workbenchId)) {
      throw new Error('The run script stopped before the app answered. See the Run tab.');
    }
    if (Date.now() > deadline) throw new Error(`Nothing answered on port ${port} after 10 minutes. See the Run tab.`);
    await sleep(PROBE_EVERY_MS);
  }
}

export function useSessionPreview(workbench: Workbench) {
  const offered = useWorkspaceStore((s) => workbenchesOffered(s.features));
  const enabled = offered && workbench.runtime === 'sandbox' && !isArchivedWorkbench(workbench);
  const [loaded, setLoaded] = useState<{ repositoryId: string; config: RepositoryPreviewResponse } | null>(null);
  const [busy, setBusy] = useState(false);
  const opening = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    const repositoryId = workbench.repositoryId;
    if (enabled && repositoryId) {
      void api.repositories.preview.get(repositoryId).then((config) => {
        if (!cancelled) setLoaded({ repositoryId, config });
      }).catch(() => {
        if (!cancelled) toast.error('Could not load the preview config');
      });
    }
    const refresh = () => {
      if (enabled && repositoryId) {
        void api.repositories.preview.get(repositoryId).then((config) => {
          if (!cancelled) setLoaded({ repositoryId, config });
        }).catch(() => undefined);
      }
    };
    window.addEventListener('repository-preview-changed', refresh);
    return () => { cancelled = true; window.removeEventListener('repository-preview-changed', refresh); };
  }, [enabled, workbench.repositoryId]);

  const config = enabled && loaded?.repositoryId === workbench.repositoryId ? loaded.config : null;
  const ports = config && config.target !== 'coder' && config.target !== 'off'
    ? config.ports.length ? config.ports : DEFAULT_PORTS
    : NO_PORTS;
  const portsKey = ports.map((p) => p.port).join(',');
  const running = useWorkbenchStore((s) => s.scriptOutput[workbench.id]?.run?.running ?? false);
  const statusMap = usePreviewStatusStore((s) => s.ports);
  const status = (port: number): PreviewPortState | null => statusMap[previewKey(workbench.id, port)] ?? null;

  // A stopped run script takes its app with it. A running one (from before
  // this window opened) is checked once, so the chip says when it is live.
  useEffect(() => {
    if (!running) {
      usePreviewStatusStore.getState().clearWorkbench(workbench.id);
      return;
    }
    let cancelled = false;
    for (const port of portsKey ? portsKey.split(',').map(Number) : []) {
      if (usePreviewStatusStore.getState().ports[previewKey(workbench.id, port)]) continue;
      void previewPortAnswers(workbench.id, port).then((live) => {
        if (!cancelled && live && runScriptRunning(workbench.id)) usePreviewStatusStore.getState().set(workbench.id, port, 'live');
      });
    }
    return () => { cancelled = true; };
  }, [running, portsKey, workbench.id]);

  const openPreview = async (port: number, ops: WorkbenchOps) => {
    if (opening.current || !ports.some((item) => item.port === port) || ops.unavailable) return;
    opening.current = true;
    setBusy(true);
    const statuses = usePreviewStatusStore.getState();
    try {
      const preview = getWorkbenchBridge()?.preview;
      if (!preview) throw new Error('Restart Talyn to enable previews.');
      if (!(await getAccessToken())) throw new Error('Sign in to open the preview.');
      if (statuses.ports[previewKey(workbench.id, port)] !== 'live') {
        statuses.set(workbench.id, port, 'starting');
        if (!runScriptRunning(workbench.id)) {
          // Show the install and the dev server coming up.
          useWorkbenchStore.getState().setTerminalTab('run');
          useWorkbenchStore.getState().setTerminalOpen(true);
          await ops.runScript('run');
        }
        await waitForPort(workbench.id, port);
      }
      const current = useWorkbenchStore.getState().workbenches[workbench.id] ?? workbench;
      if (isArchivedWorkbench(current) || !workbenchesOffered(useWorkspaceStore.getState().features)) return;
      const token = await getAccessToken();
      if (!token) throw new Error('Sign in to open the preview.');
      const forward = await preview.start({ workbenchId: workbench.id, port, token, apiBaseUrl: API_BASE_URL });
      usePreviewStatusStore.getState().set(workbench.id, port, 'live');
      await openExternal(forward.url);
    } catch (error) {
      if (usePreviewStatusStore.getState().ports[previewKey(workbench.id, port)] === 'starting') {
        usePreviewStatusStore.getState().set(workbench.id, port, null);
      }
      toast.error('Could not open the preview', error instanceof Error ? error.message : undefined);
    } finally {
      opening.current = false;
      setBusy(false);
    }
  };

  return { config, loading: enabled && Boolean(workbench.repositoryId) && !config, ports, busy, openPreview, status };
}
