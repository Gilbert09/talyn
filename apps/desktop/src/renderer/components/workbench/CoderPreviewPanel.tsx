import { useEffect, useState } from 'react';
import { workbenchesOffered, type EffectivePreview, type Workbench } from '@talyn/shared';
import type { CoderPreviewState } from '../../../workbenchBridgeTypes';
import { coderAction, coderPreviewBridge, startCoderPreview, syncCoderPreview } from '../../lib/coderPreview';
import { useWorkspaceStore } from '../../stores/workspace';
import { isArchivedWorkbench } from '../../lib/workbenchActions';

const buttonClass = 'rounded border bg-background px-2 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-50';

export function CoderPreviewPanel({ workbench, config }: { workbench: Workbench; config: EffectivePreview }) {
  const enabled = useWorkspaceStore((s) => workbenchesOffered(s.features));
  const eligible = enabled && workbench.runtime === 'sandbox' && !isArchivedWorkbench(workbench) && config.target === 'coder';
  const [state, setState] = useState<CoderPreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    setError(null);
    if (!eligible) return;
    const refresh = () => {
      void Promise.resolve().then(() => coderPreviewBridge().state(workbench.id)).then((value) => {
        if (!cancelled) setState(value);
      }).catch((err) => { if (!cancelled) setError(String(err)); });
    };
    try { refresh(); } catch (err) { setError(String(err)); }
    window.addEventListener('coder-preview-changed', refresh);
    const timer = window.setInterval(refresh, 2000);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('coder-preview-changed', refresh); };
  }, [eligible, workbench.id]);

  if (!eligible) return null;
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const steps = [
    ['CLI ready', state?.cliReady],
    ['Workspace running', state?.workspaceRunning],
    ['Worktree ready', state?.worktreeReady],
    [state?.turn === undefined ? 'Synced' : `Synced after turn ${state.turn}`, Boolean(state?.syncedAt)],
    ['Running', state?.running],
  ] as const;
  return (
    <section aria-label="Coder preview" className="h-full space-y-2 overflow-auto p-3 text-xs text-foreground">
      <p>{config.coder?.url || 'Set the Coder URL in Settings.'}</p>
      <p>Workspace: {state?.workspace || config.coder?.workspace || 'Select automatically'}</p>
      <ol className="flex flex-wrap gap-x-3 gap-y-1">
        {steps.map(([label, ready]) => <li key={label} className={ready ? 'text-foreground' : 'text-muted-foreground'}>{ready ? '✓' : '○'} {label}</li>)}
      </ol>
      <div className="flex flex-wrap gap-2">
        <button className={buttonClass} disabled={busy} onClick={() => void act(() => startCoderPreview(workbench, config))}>Preview in Coder</button>
        <button className={buttonClass} disabled={busy || !state?.active} onClick={() => void act(() => coderAction(workbench.id, () => coderPreviewBridge().open(workbench.id)))}>Open</button>
        <button className={buttonClass} disabled={busy || !state?.active} onClick={() => void act(() => coderAction(workbench.id, () => syncCoderPreview(workbench.id)))}>Sync now</button>
        <button className={buttonClass} disabled={busy || !state?.active} onClick={() => void act(() => coderAction(workbench.id, () => coderPreviewBridge().stop(workbench.id)))}>Stop</button>
        <button className={buttonClass} disabled={busy || !state?.worktreeReady} onClick={() => void act(() => coderAction(workbench.id, () => coderPreviewBridge().remove(workbench.id)))}>Remove</button>
      </div>
      <p className="text-muted-foreground">One preview per workspace: starting this stops the preview of another session.</p>
      {(error || state?.error) && <p role="alert" className="whitespace-pre-wrap text-destructive">{error || state?.error}</p>}
    </section>
  );
}
