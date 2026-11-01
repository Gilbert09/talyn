import { useState } from 'react';
import { Laptop, Link2, Loader2 } from 'lucide-react';
import type { Workbench } from '@talyn/shared';
import { useSessionPreview } from '../../hooks/useSessionPreview';
import { api } from '../../lib/api';
import { useWorkspaceStore } from '../../stores/workspace';
import { startCoderPreview } from '../../lib/coderPreview';
import { useWorkbenchStore } from '../../stores/workbenches';
import { toast } from '../../stores/toast';
import type { WorkbenchOps } from '../../lib/workbenchOps';

export function SessionPreviewChips({ workbench, ops }: { workbench: Workbench; ops: WorkbenchOps }) {
  const { config, ports, busy, openPreview, status } = useSessionPreview(workbench);
  const [coderBusy, setCoderBusy] = useState(false);
  const shareable = useWorkspaceStore((s) => Boolean(s.features?.previewLinks));
  const [sharing, setSharing] = useState<number | null>(null);
  const copyShareLink = async (port: number) => {
    setSharing(port);
    try {
      const link = await api.workbenches.previewLink(workbench.id, port);
      await navigator.clipboard.writeText(link.url);
      toast.success('Share link copied', 'It opens this app in any browser. It works once, for 10 minutes.');
    } catch (error) {
      toast.error('Could not copy the share link', error instanceof Error ? error.message : undefined);
    } finally {
      setSharing(null);
    }
  };
  const startCoder = async () => {
    if (!config || coderBusy) return;
    useWorkbenchStore.getState().setTerminalTab('run');
    useWorkbenchStore.getState().setTerminalOpen(true);
    setCoderBusy(true);
    try { await startCoderPreview(workbench, config); }
    catch (error) { toast.error('Could not start the Coder preview', error instanceof Error ? error.message : undefined); }
    finally { setCoderBusy(false); }
  };
  if (config?.target === 'coder') return (
    <button
      type="button"
      className="app-region-no-drag shrink-0 rounded border bg-background px-2 py-0.5 text-xs text-foreground hover:bg-accent disabled:opacity-50"
      disabled={coderBusy || Boolean(ops.unavailable)}
      onClick={() => void startCoder()}
    >Preview in Coder</button>
  );
  return <>{ports.map(({ port, label }) => {
    const state = status(port);
    // With preview links on, the chip opens the hosted link and takes no local port.
    const name = `${shareable ? `preview :${port}` : `localhost:${port}`}${label ? ` (${label})` : ''}`;
    return (
      <span key={port} className="inline-flex min-w-0 shrink items-center gap-0.5">
        <button
          type="button"
          className="app-region-no-drag inline-flex min-w-0 max-w-[15rem] shrink items-center gap-1.5 rounded border bg-background px-2 py-0.5 text-xs text-foreground hover:bg-accent disabled:opacity-50"
          disabled={(busy && state !== 'starting') || Boolean(ops.unavailable)}
          onClick={() => void openPreview(port, ops)}
          data-attr="session-preview-chip"
          data-state={state ?? 'stopped'}
          title={state === 'live'
            ? `The app is running. Open ${name} in your browser.`
            : state === 'starting'
              ? `Starting the run script. ${name} opens when the app answers.`
              : 'Start the run script if needed, then open the preview'}
        >
          {state === 'live' && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />}
          {state === 'starting' && <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />}
          <span className="truncate">{state === 'live' ? name : state === 'starting' ? `Starting ${name}…` : `Open ${name}`}</span>
        </button>
        {shareable && state === 'live' && (
          <button
            type="button"
            className="app-region-no-drag shrink-0 rounded border bg-background p-1 text-foreground hover:bg-accent disabled:opacity-50"
            disabled={busy || Boolean(ops.unavailable)}
            onClick={() => void openPreview(port, ops, { via: 'localhost' })}
            data-attr="session-preview-localhost"
            title={`Open on localhost:${port} instead. This takes a local port.`}
            aria-label={`Open port ${port} on localhost`}
          >
            <Laptop className="h-3 w-3" aria-hidden />
          </button>
        )}
        {shareable && state === 'live' && (
          <button
            type="button"
            className="app-region-no-drag shrink-0 rounded border bg-background p-1 text-foreground hover:bg-accent disabled:opacity-50"
            disabled={sharing !== null || Boolean(ops.unavailable)}
            onClick={() => void copyShareLink(port)}
            data-attr="session-preview-share"
            title="Copy a link that opens this app in any browser. It works once, for 10 minutes."
            aria-label={`Copy a share link for port ${port}`}
          >
            {sharing === port ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Link2 className="h-3 w-3" aria-hidden />}
          </button>
        )}
      </span>
    );
  })}</>;
}
