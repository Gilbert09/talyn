import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { workbenchesOffered, type PreviewPort, type RepositoryPreviewResponse, type Workbench } from '@talyn/shared';
import { api } from '../../lib/api';
import { previewPortAnswers } from '../../lib/previewProbe';
import { isArchivedWorkbench } from '../../lib/workbenchActions';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { toast } from '../../stores/toast';
import { useWorkbenchStore } from '../../stores/workbenches';
import { useWorkspaceStore } from '../../stores/workspace';

// The backend sets TALYN_PORT to 3000.
const DEFAULT_PORTS: PreviewPort[] = [{ port: 3000 }];
const PROBE_EVERY_MS = 1500;
/** A first run installs dependencies before the dev server starts. */
const START_TIMEOUT_MS = 10 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const runScriptRunning = (workbenchId: string) =>
  useWorkbenchStore.getState().scriptOutput[workbenchId]?.run?.running ?? false;

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

/** Writes a short note into the new tab while the app starts. */
function showWaiting(tab: Window, port: number): void {
  try {
    tab.document.title = 'Starting the preview…';
    tab.document.body.style.font = '15px system-ui, sans-serif';
    tab.document.body.style.padding = '2rem';
    tab.document.body.textContent = `Starting the app on port ${port}. This tab opens it when it answers.`;
  } catch {
    // The tab is no longer ours to write to.
  }
}

/**
 * "Open preview" buttons for a sandbox session: one per port. The web app has
 * no local forward, so each opens the port on its hosted preview host
 * (`POST /workbenches/:id/ports/:port/ticket`). Hidden when the deployment has
 * no preview domain. Coder previews are desktop only.
 */
export function SessionPreviewLinks({ workbench, ops }: { workbench: Workbench; ops: WorkbenchOps }) {
  const features = useWorkspaceStore((s) => s.features);
  const enabled = Boolean(features?.previewLinks) && workbenchesOffered(features)
    && workbench.runtime === 'sandbox' && !isArchivedWorkbench(workbench);
  const [loaded, setLoaded] = useState<{ repositoryId: string; config: RepositoryPreviewResponse } | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    const repositoryId = workbench.repositoryId;
    const load = () => {
      if (!enabled || !repositoryId) return;
      void api.repositories.preview.get(repositoryId).then((config) => {
        if (!cancelled) setLoaded({ repositoryId, config });
      }).catch(() => undefined);
    };
    load();
    window.addEventListener('repository-preview-changed', load);
    return () => { cancelled = true; window.removeEventListener('repository-preview-changed', load); };
  }, [enabled, workbench.repositoryId]);

  const config = enabled && loaded?.repositoryId === workbench.repositoryId ? loaded.config : null;
  if (!config || config.target === 'coder' || config.target === 'off') return null;
  const ports = config.ports.length ? config.ports : DEFAULT_PORTS;

  const open = async (port: number) => {
    if (busy.current || ops.unavailable) return;
    // Open the tab now, while the click still allows a pop-up.
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      toast.error('Could not open the preview', 'Allow pop-ups for Talyn, then try again.');
      return;
    }
    tab.opener = null;
    busy.current = true;
    setOpening(port);
    try {
      if (!runScriptRunning(workbench.id)) {
        // Show the install and the dev server coming up.
        useWorkbenchStore.getState().setTerminalTab('run');
        useWorkbenchStore.getState().setTerminalOpen(true);
        showWaiting(tab, port);
        await ops.runScript('run');
      }
      await waitForPort(workbench.id, port);
      const link = await api.workbenches.previewLink(workbench.id, port);
      if (tab.closed) return;
      tab.location.replace(link.url);
    } catch (error) {
      tab.close();
      toast.error('Could not open the preview', error instanceof Error ? error.message : undefined);
    } finally {
      busy.current = false;
      setOpening(null);
    }
  };

  return <>{ports.map(({ port, label }) => (
    <button
      key={port}
      type="button"
      className="inline-flex min-w-0 max-w-[15rem] shrink items-center gap-1.5 rounded border bg-background px-2 py-0.5 text-xs text-foreground hover:bg-accent disabled:opacity-50"
      disabled={opening !== null || Boolean(ops.unavailable)}
      onClick={() => void open(port)}
      data-attr="session-preview-link"
      title="Start the run script if needed, then open the app in a new tab"
    >
      {opening === port && <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />}
      <span className="truncate">
        {opening === port ? `Starting port ${port}…` : `Open preview${ports.length > 1 || label ? ` (${label ?? port})` : ''}`}
      </span>
    </button>
  ))}</>;
}
