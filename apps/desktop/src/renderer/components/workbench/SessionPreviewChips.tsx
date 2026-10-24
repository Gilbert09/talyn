import type { Workbench } from '@talyn/shared';
import { useSessionPreview } from '../../hooks/useSessionPreview';
import type { WorkbenchOps } from '../../lib/workbenchOps';

export function SessionPreviewChips({ workbench, ops }: { workbench: Workbench; ops: WorkbenchOps }) {
  const { ports, busy, openPreview } = useSessionPreview(workbench);
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
