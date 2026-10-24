import { useState } from 'react';
import type { Workbench } from '@talyn/shared';
import { useSessionPreview } from '../../hooks/useSessionPreview';
import { startCoderPreview } from '../../lib/coderPreview';
import { useWorkbenchStore } from '../../stores/workbenches';
import { toast } from '../../stores/toast';
import type { WorkbenchOps } from '../../lib/workbenchOps';

export function SessionPreviewChips({ workbench, ops }: { workbench: Workbench; ops: WorkbenchOps }) {
  const { config, ports, busy, openPreview } = useSessionPreview(workbench);
  const [coderBusy, setCoderBusy] = useState(false);
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
  return <>{ports.map(({ port, label }) => (
    <button
      key={port}
      type="button"
      className="app-region-no-drag shrink-0 rounded border bg-background px-2 py-0.5 text-xs text-foreground hover:bg-accent disabled:opacity-50"
      disabled={busy || Boolean(ops.unavailable)}
      onClick={() => void openPreview(port, ops)}
      title="Start the run script if needed, then open the preview"
    >
      Open localhost:{port}{label ? ` (${label})` : ''}
    </button>
  ))}</>;
}
