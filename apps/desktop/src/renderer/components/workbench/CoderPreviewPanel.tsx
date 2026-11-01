import { useEffect, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { workbenchesOffered, type EffectivePreview, type Workbench } from '@talyn/shared';
import type { CoderPreviewState, CoderProblem, CoderStep } from '../../../workbenchBridgeTypes';
import {
  checkCoderPreview, coderAction, coderPreviewBridge, coderProgress, errorText, startCoderPreview, startCoderWorkspace, syncCoderPreview,
} from '../../lib/coderPreview';
import { useWorkspaceStore } from '../../stores/workspace';
import { isArchivedWorkbench } from '../../lib/workbenchActions';

const buttonClass = 'rounded border bg-background px-2 py-1 text-xs text-foreground hover:bg-accent disabled:opacity-50';
// Each session is checked once per app run when its panel first opens. "Check again" runs it after that.
const autoChecked = new Set<string>();

type StepState = 'done' | 'current' | 'failed' | 'pending';

function StepIcon({ state }: { state: StepState }) {
  if (state === 'current') return <Loader2 className="inline h-3 w-3 animate-spin" aria-label="In progress" />;
  if (state === 'done') return <span aria-hidden>✓</span>;
  if (state === 'failed') return <span aria-hidden>✕</span>;
  return <span aria-hidden>○</span>;
}

function CopyCommand({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* The command stays on screen to select by hand. */ }
  };
  return (
    <div className="space-y-0.5">
      {label && <p className="text-muted-foreground">{label}</p>}
      <div className="flex items-center gap-1">
        <code className="min-w-0 flex-1 select-all break-all rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{command}</code>
        <button type="button" className={buttonClass} aria-label={`Copy ${command}`} onClick={() => void copy()}>
          {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
        </button>
      </div>
    </div>
  );
}

function ProblemView({ problem, busy, onStart }: { problem: CoderProblem; busy: boolean; onStart: () => void }) {
  return (
    <div role="alert" className="space-y-1.5 rounded border border-destructive/40 bg-destructive/5 p-2">
      <p className="whitespace-pre-wrap text-destructive">{problem.message}</p>
      {problem.commands?.map((item) => <CopyCommand key={item.command} {...item} />)}
      {problem.note && <p className="whitespace-pre-wrap text-muted-foreground">{problem.note}</p>}
      {problem.action === 'start_workspace' && (
        <button type="button" className={buttonClass} disabled={busy} onClick={onStart}>Start workspace</button>
      )}
      {problem.detail && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Output of the Coder CLI</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-1.5 font-mono">{problem.detail}</pre>
        </details>
      )}
    </div>
  );
}

export function CoderPreviewPanel({ workbench, config }: { workbench: Workbench; config: EffectivePreview }) {
  const enabled = useWorkspaceStore((s) => workbenchesOffered(s.features));
  const eligible = enabled && workbench.runtime === 'sandbox' && !isArchivedWorkbench(workbench) && config.target === 'coder';
  const [state, setState] = useState<CoderPreviewState | null>(null);
  const [local, setLocal] = useState(() => coderProgress(workbench.id));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    setError(null);
    if (!eligible) return;
    const refresh = () => {
      setLocal(coderProgress(workbench.id));
      void Promise.resolve().then(() => coderPreviewBridge().state(workbench.id)).then((value) => {
        if (cancelled) return;
        setState(value);
        setError(null);
        if (!value && !autoChecked.has(workbench.id) && !coderProgress(workbench.id).busy) {
          autoChecked.add(workbench.id);
          void checkCoderPreview(workbench, config).catch(() => undefined);
        }
      }).catch((err) => { if (!cancelled) setError(errorText(err)); });
    };
    refresh();
    window.addEventListener('coder-preview-changed', refresh);
    const timer = window.setInterval(refresh, 1000);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('coder-preview-changed', refresh); };
    // The automatic check uses the config of the first render. "Check again" uses the current one.
  }, [eligible, workbench.id]);

  if (!eligible) return null;
  const busy = local.busy;
  const act = (action: () => Promise<unknown>) => {
    autoChecked.add(workbench.id);
    setError(null);
    // The lib keeps the error for the panel, and the panel reads it on the next refresh.
    void action().catch(() => undefined);
  };
  const problem = state?.problem;
  const current = local.step ?? state?.step ?? null;
  const detail = local.detail ?? state?.stepDetail ?? null;
  const stepState = (key: CoderStep, done: boolean | undefined): StepState => {
    if (busy && current === key) return 'current';
    if (done) return 'done';
    if (!busy && problem?.step === key) return 'failed';
    return 'pending';
  };
  const steps: Array<[CoderStep, string, boolean | undefined]> = [
    ['cli', 'CLI installed', state?.cliReady],
    ['login', 'Signed in', state?.signedIn],
    ['workspace', 'Workspace running', state?.workspaceRunning],
    ['worktree', 'Worktree ready', state?.worktreeReady],
    ['sync', state?.turn === undefined ? 'Synced' : `Synced after turn ${state.turn}`, Boolean(state?.syncedAt)],
    ['run', 'Running', state?.running],
  ];
  // A problem carries the same message as the error, with the fix beside it.
  const plainError = error || (!problem ? local.error || state?.error : null);
  return (
    <section aria-label="Coder preview" className="h-full space-y-2 overflow-auto p-3 text-xs text-foreground">
      <p>{config.coder?.url || 'Set the Coder URL in Settings.'}</p>
      <p>Workspace: {state?.workspace || config.coder?.workspace || 'Select automatically'}</p>
      <ol className="flex flex-wrap gap-x-3 gap-y-1">
        {steps.map(([key, label, done]) => {
          const value = stepState(key, done);
          return (
            <li key={key} data-step={key} data-state={value} className={value === 'failed' ? 'text-destructive' : value === 'pending' ? 'text-muted-foreground' : 'text-foreground'}>
              <StepIcon state={value} /> {label}
            </li>
          );
        })}
      </ol>
      {busy && <p aria-live="polite" className="text-muted-foreground">{detail || 'Working…'}</p>}
      {problem && !busy && <ProblemView problem={problem} busy={busy} onStart={() => act(() => startCoderWorkspace(workbench.id))} />}
      {plainError && !busy && <p role="alert" className="whitespace-pre-wrap text-destructive">{plainError}</p>}
      <div className="flex flex-wrap gap-2">
        <button className={buttonClass} disabled={busy} onClick={() => act(() => startCoderPreview(workbench, config))}>Preview in Coder</button>
        <button className={buttonClass} disabled={busy} onClick={() => act(() => checkCoderPreview(workbench, config))}>{problem || plainError ? 'Check again' : 'Check setup'}</button>
        <button className={buttonClass} disabled={busy || !state?.active} onClick={() => act(() => coderAction(workbench.id, () => coderPreviewBridge().open(workbench.id)))}>Open</button>
        <button className={buttonClass} disabled={busy || !state?.active} onClick={() => act(() => coderAction(workbench.id, () => syncCoderPreview(workbench.id)))}>Sync now</button>
        <button className={buttonClass} disabled={busy || !state?.active} onClick={() => act(() => coderAction(workbench.id, () => coderPreviewBridge().stop(workbench.id)))}>Stop</button>
        <button className={buttonClass} disabled={busy || !state?.worktreeReady} onClick={() => act(() => coderAction(workbench.id, () => coderPreviewBridge().remove(workbench.id)))}>Remove</button>
      </div>
      <p className="text-muted-foreground">One preview per workspace: starting this stops the preview of another session.</p>
    </section>
  );
}
