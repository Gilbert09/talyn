import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Play, Square, X } from 'lucide-react';
import type { Workbench } from '@talyn/shared';
import { cn } from '../../../lib/utils';
import type { WorkbenchOps } from '../../../lib/workbenchOps';
import { toast } from '../../../stores/toast';
import { useWorkbenchStore, type WorkbenchTerminalTab } from '../../../stores/workbenches';
import { ShellTerminal } from './ShellTerminal';
import { useXterm } from './useXterm';

const TABS: Array<{ id: WorkbenchTerminalTab; label: string }> = [
  { id: 'setup', label: 'Setup' },
  { id: 'run', label: 'Run' },
  { id: 'terminal', label: 'Terminal' },
];

/** The bottom panel: setup and run script output, and a shell. Resized by dragging its top edge. */
export function TerminalPanel({ workbench, ops }: { workbench: Workbench; ops: WorkbenchOps }) {
  const height = useWorkbenchStore((s) => s.terminalHeight);
  const setHeight = useWorkbenchStore((s) => s.setTerminalHeight);
  const tab = useWorkbenchStore((s) => s.terminalTab);
  const setTab = useWorkbenchStore((s) => s.setTerminalTab);
  const setOpen = useWorkbenchStore((s) => s.setTerminalOpen);
  // The shell mounts on first visit and then stays, so switching tabs keeps the session.
  const [shellStarted, setShellStarted] = useState(tab === 'terminal');
  useEffect(() => {
    if (tab === 'terminal') setShellStarted(true);
  }, [tab]);
  useEffect(() => setShellStarted(tab === 'terminal'), [workbench.id]);

  const onDragStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;
    const max = Math.round(window.innerHeight * 0.75);
    const move = (ev: PointerEvent) => setHeight(Math.min(max, startHeight + (startY - ev.clientY)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="relative flex shrink-0 flex-col border-t bg-background" style={{ height }}>
      <div
        onPointerDown={onDragStart}
        className="absolute inset-x-0 -top-1 h-2 cursor-row-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the terminal"
      />
      <div className="flex items-center gap-0.5 border-b border-border px-2 text-xs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'border-b-2 px-2 py-1.5',
              tab === t.id ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
          </button>
        ))}
        <div className="flex-1" />
        {(tab === 'setup' || tab === 'run') && <ScriptControls workbench={workbench} ops={ops} name={tab} />}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Hide the terminal (⌘J)"
          aria-label="Hide the terminal"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {(tab === 'setup' || tab === 'run') && <ScriptOutput key={`${workbench.id}:${tab}`} workbenchId={workbench.id} name={tab} />}
        {shellStarted && (
          <div className={cn('absolute inset-0', tab !== 'terminal' && 'invisible')}>
            <ShellTerminal key={workbench.id} workbench={workbench} active={tab === 'terminal'} />
          </div>
        )}
      </div>
    </div>
  );
}

function ScriptControls({ workbench, ops, name }: { workbench: Workbench; ops: WorkbenchOps; name: 'setup' | 'run' }) {
  const running = useWorkbenchStore((s) => s.scriptOutput[workbench.id]?.[name]?.running ?? false);
  const [busy, setBusy] = useState(false);
  const act = async () => {
    setBusy(true);
    try {
      if (running) await ops.stopScript(name);
      else await ops.runScript(name);
    } catch (err) {
      toast.error(`Could not ${running ? 'stop' : 'run'} the ${name} script`, err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void act()}
      disabled={busy || Boolean(ops.unavailable)}
      className="mr-1 inline-flex items-center gap-1 rounded px-2 py-0.5 text-foreground/80 hover:bg-accent disabled:opacity-50"
      title={running ? `Stop the ${name} script` : `Run the ${name} script`}
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : running ? (
        <Square className="h-3 w-3" fill="currentColor" />
      ) : (
        <Play className="h-3 w-3" />
      )}
      {running ? 'Stop' : 'Run'}
    </button>
  );
}

/** A read-only xterm fed from the store's script output. */
function ScriptOutput({ workbenchId, name }: { workbenchId: string; name: string }) {
  const { ref, term } = useXterm({ readOnly: true });
  const output = useWorkbenchStore((s) => s.scriptOutput[workbenchId]?.[name]);
  const written = useRef(0);
  const lastExit = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    if (!term) return;
    const chunks = output?.chunks ?? [];
    const total = output?.total ?? 0;
    // A restart clears the output: start the screen over too.
    if (total < written.current) {
      term.reset();
      written.current = 0;
      lastExit.current = undefined;
    }
    const fresh = Math.min(total - written.current, chunks.length);
    for (let i = chunks.length - fresh; i < chunks.length; i++) term.write(chunks[i]);
    written.current = total;
    if (output && !output.running && lastExit.current !== output.exitCode) {
      lastExit.current = output.exitCode;
      term.writeln(`\r\n\x1b[90m[exited${output.exitCode === null ? '' : ` with code ${output.exitCode}`}]\x1b[0m`);
    }
  }, [term, output]);

  return (
    <div className="absolute inset-0">
      {!output && (
        <p className="absolute left-3 top-2 z-10 text-xs text-muted-foreground">
          No {name} output yet. Press Run to start the {name} script from the repository config.
        </p>
      )}
      <div ref={ref} className="h-full w-full px-2 py-1" />
    </div>
  );
}
