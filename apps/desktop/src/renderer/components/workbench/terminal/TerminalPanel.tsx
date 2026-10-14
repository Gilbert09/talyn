import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, Play, Square } from 'lucide-react';
import type { Workbench } from '@talyn/shared';
import { cn } from '../../../lib/utils';
import { formatKeys } from '../../../lib/shortcuts';
import { clampDockHeight } from '../../../lib/workbenchLayout';
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

/**
 * The terminal dock under the right panel: setup and run script output, and
 * a shell. Closed, it is one bar of tabs; open, it takes `terminalHeight`
 * (dragged from its top edge, remembered). The body stays mounted while
 * closed, so the shell session survives a collapse.
 */
export function TerminalPanel({ workbench, ops }: { workbench: Workbench; ops: WorkbenchOps }) {
  const open = useWorkbenchStore((s) => s.terminalOpen);
  const height = useWorkbenchStore((s) => s.terminalHeight);
  const setHeight = useWorkbenchStore((s) => s.setTerminalHeight);
  const tab = useWorkbenchStore((s) => s.terminalTab);
  const setTab = useWorkbenchStore((s) => s.setTerminalTab);
  const setOpen = useWorkbenchStore((s) => s.setTerminalOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number | undefined>(undefined);
  // The shell mounts on first visit and then stays, so switching tabs keeps the session.
  const [shellStarted, setShellStarted] = useState(open && tab === 'terminal');
  useEffect(() => {
    if (open && tab === 'terminal') setShellStarted(true);
  }, [open, tab]);
  useEffect(() => setShellStarted(open && tab === 'terminal'), [workbench.id]);

  // The column the dock shares with the panel above: its height caps the dock.
  useEffect(() => {
    const column = rootRef.current?.parentElement;
    if (!column || typeof ResizeObserver === 'undefined') return undefined;
    const update = () => setAvailable(column.clientHeight || undefined);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(column);
    return () => observer.disconnect();
  }, []);

  const shown = clampDockHeight(height, available);

  const onDragStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = shown;
    const move = (ev: PointerEvent) => setHeight(clampDockHeight(startHeight + (startY - ev.clientY), available));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      ref={rootRef}
      className="relative flex shrink-0 flex-col border-t bg-background"
      style={open ? { height: shown } : undefined}
      data-testid="terminal-dock"
      data-open={open ? 'true' : 'false'}
    >
      {open && (
        <div
          onPointerDown={onDragStart}
          className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the terminal"
        />
      )}
      <div className="flex h-7 shrink-0 items-center gap-0.5 px-1.5 text-xs" role="tablist" aria-label="Terminal">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={open && tab === t.id}
            onClick={() => (open && tab === t.id ? setOpen(false) : setTab(t.id))}
            className={cn(
              'rounded px-2 py-0.5',
              open && tab === t.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
          </button>
        ))}
        <div className="flex-1" />
        {open && (tab === 'setup' || tab === 'run') && <ScriptControls workbench={workbench} ops={ops} name={tab} />}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title={`${open ? 'Collapse' : 'Open'} the terminal (${formatKeys('mod+j')})`}
          aria-label={open ? 'Collapse the terminal' : 'Open the terminal'}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className={cn('relative min-h-0 flex-1 border-t', !open && 'hidden')}>
        {open && (tab === 'setup' || tab === 'run') && (
          <ScriptOutput key={`${workbench.id}:${tab}`} workbenchId={workbench.id} name={tab} />
        )}
        {shellStarted && (
          <div className={cn('absolute inset-0', tab !== 'terminal' && 'invisible')}>
            <ShellTerminal key={workbench.id} workbench={workbench} active={open && tab === 'terminal'} />
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
