import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Workbench } from '@talyn/shared';
import { api } from '../../lib/api';
import { previewPortAnswers } from '../../lib/previewProbe';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { toast } from '../../stores/toast';
import { useWorkbenchStore } from '../../stores/workbenches';
import { usePreviewStatusStore } from '../../stores/previewStatus';
import { usePreviewActivity } from '../../hooks/usePreviewActivity';

// The backend sets TALYN_PORT to 3000.
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
  const { config, ports, portStatus } = usePreviewActivity(workbench);
  const busy = useRef(false);
  const [opening, setOpening] = useState(false);
  if (!config || config.target === 'coder' || config.target === 'off') return null;

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
    setOpening(true);
    usePreviewStatusStore.getState().set(workbench.id, port, 'starting');
    try {
      if (!runScriptRunning(workbench.id)) {
        // Show the install and the dev server coming up.
        useWorkbenchStore.getState().setTerminalTab('run');
        useWorkbenchStore.getState().setTerminalOpen(true);
        showWaiting(tab, port);
        await ops.runScript('run');
      }
      await waitForPort(workbench.id, port);
      usePreviewStatusStore.getState().set(workbench.id, port, 'live');
      const link = await api.workbenches.previewLink(workbench.id, port);
      if (tab.closed) return;
      tab.location.replace(link.url);
    } catch (error) {
      usePreviewStatusStore.getState().set(workbench.id, port, null);
      tab.close();
      toast.error('Could not open the preview', error instanceof Error ? error.message : undefined);
    } finally {
      busy.current = false;
      setOpening(false);
    }
  };

  return <>{ports.map(({ port, label }) => (
    <button
      key={port}
      type="button"
      className="inline-flex min-w-0 max-w-[15rem] shrink items-center gap-1.5 rounded border bg-background px-2 py-0.5 text-xs text-foreground hover:bg-accent disabled:opacity-50"
      disabled={opening || Boolean(ops.unavailable)}
      onClick={() => void open(port)}
      data-attr="session-preview-link"
      title={portStatus(port).label}
    >
      {portStatus(port).status === 'starting' && <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />}
      {portStatus(port).status === 'running' && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />}
      {portStatus(port).status === 'failed' && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" aria-hidden />}
      <span className="truncate">
        {portStatus(port).status === 'starting' ? `Starting port ${port}…`
          : portStatus(port).status === 'failed' ? `Preview failed :${port}`
            : `Open preview${ports.length > 1 || label ? ` (${label ?? port})` : ''}`}
      </span>
    </button>
  ))}</>;
}
