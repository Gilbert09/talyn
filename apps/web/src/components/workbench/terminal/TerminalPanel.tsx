import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, Play, Square } from 'lucide-react';
import type { Workbench, WorkbenchConfig } from '@talyn/shared';
import { cn } from '../../../lib/utils';
import { formatKeys } from '../../../lib/shortcuts';
import { clampDockHeight } from '../../../lib/workbenchLayout';
import type { WorkbenchOps } from '../../../lib/workbenchOps';
import { toast } from '../../../stores/toast';
import { useWorkbenchStore, type WorkbenchTerminalTab } from '../../../stores/workbenches';
import { SessionPreviewLinks } from '../SessionPreviewLinks';
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
  const storedTab = useWorkbenchStore((s) => s.terminalTab);
  const setTab = useWorkbenchStore((s) => s.setTerminalTab);
  const setOpen = useWorkbenchStore((s) => s.setTerminalOpen);
  const runRunning = useWorkbenchStore((s) => s.scriptOutput[workbench.id]?.run?.running ?? false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number | undefined>(undefined);
  const [loaded, setLoaded] = useState<{
    id: string;
    config: WorkbenchConfig;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const config = loaded?.id === workbench.id ? loaded.config : null;
  const detected = config?.source === 'none' ? config.detected : undefined;
  const hideScripts = config?.source === 'none' && !detected?.setup && !detected?.run;
  const tab = hideScripts ? 'terminal' : storedTab;

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    if (!ops.unavailable) {
      void ops
        .config()
        .then((value) => {
          if (!cancelled) setLoaded({ id: workbench.id, config: value });
        })
        .catch((err) => {
          if (!cancelled)
            toast.error('Could not read the repository config', err instanceof Error ? err.message : undefined);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [workbench.id, ops]);

  useEffect(() => {
    if (hideScripts && storedTab !== 'terminal') {
      useWorkbenchStore.setState({ terminalTab: 'terminal' });
    }
  }, [hideScripts, storedTab]);

  const saveDetected = async () => {
    setSaving(true);
    try {
      await ops.saveDetectedConfig();
      setLoaded({ id: workbench.id, config: await ops.config() });
      toast.success('Config saved', "The file is now in this session's changes. You can commit it.");
    } catch (err) {
      toast.error('Could not save the repository config', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };
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
      <div className="flex h-7 min-w-0 shrink-0 items-center gap-0.5 overflow-hidden px-1.5 text-xs" role="tablist" aria-label="Terminal">
        {TABS.filter((t) => !hideScripts || t.id === 'terminal').map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={open && tab === t.id}
            onClick={() => (open && tab === t.id ? setOpen(false) : setTab(t.id))}
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5',
              open && tab === t.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
            {t.id === 'run' && runRunning && (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-label="running" />
            )}
          </button>
        ))}
        <div className="flex-1" />
        {open && tab === 'run' && <SessionPreviewLinks workbench={workbench} ops={ops} />}
        {open && config && (config.source !== 'none' || (tab === 'run' && detected?.run)) && (tab === 'setup' || tab === 'run') && (
          <ScriptControls workbench={workbench} ops={ops} name={tab} />
        )}
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
        {open &&
          (tab === 'setup' || tab === 'run') &&
          (tab === 'setup' && detected?.setup ? (
            <div className="m-3 space-y-2 rounded border bg-muted p-3 text-xs">
              <p>
                Detected: <code className="break-all">{detected.setup.command}</code>{' '}
                <span className="text-muted-foreground">({detected.setup.reason})</span>
              </p>
              <p className="text-muted-foreground">Talyn runs it once, before the first run of the app. Save it to change it.</p>
              <button
                type="button"
                className="rounded border bg-background px-2 py-1 hover:bg-accent disabled:opacity-50"
                disabled={saving || Boolean(ops.unavailable)}
                onClick={() => void saveDetected()}
              >
                Save to .talyn/settings.toml
              </button>
            </div>
          ) : (
            <div className="flex h-full flex-col">
              {tab === 'run' && detected?.run && (
                <div
                  className="flex min-w-0 items-center gap-2 border-b bg-muted px-3 py-1 text-xs"
                  title={`Talyn runs ${detected.run.command} (${detected.run.reason}). Save it to .talyn/settings.toml to change it.`}
                >
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    Runs <code className="whitespace-nowrap text-foreground">{detected.run.command}</code> ({detected.run.reason})
                  </span>
                  <button
                    type="button"
                    aria-label="Save to .talyn/settings.toml"
                    className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                    disabled={saving || Boolean(ops.unavailable)}
                    onClick={() => void saveDetected()}
                  >
                    Save
                  </button>
                </div>
              )}
              <div className="relative min-h-0 flex-1">
                <ScriptOutput
                  key={`${workbench.id}:${tab}`}
                  workbenchId={workbench.id}
                  name={tab}
                  emptyText={
                    !config
                      ? 'Loading the repository config.'
                      : tab === 'setup'
                        ? config.setup
                          ? 'The setup script has not run yet.'
                          : 'This repository has no setup script.'
                        : config.run.length
                          ? 'No run output yet. Press Run to start the run script from the repository config.'
                          : detected?.run
                            ? 'No run output yet. Press Run to start the detected command.'
                            : 'This repository has no run script.'
                  }
                />
              </div>
            </div>
          ))}
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
      toast.error(
        `Could not ${running ? 'stop' : 'run'} the ${name} script`,
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void act()}
      disabled={busy || Boolean(ops.unavailable)}
      className="mr-1 inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-foreground/80 hover:bg-accent disabled:opacity-50"
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
function ScriptOutput({ workbenchId, name, emptyText }: { workbenchId: string; name: string; emptyText: string }) {
  const { ref, term } = useXterm({ readOnly: true });
  const output = useWorkbenchStore((s) => s.scriptOutput[workbenchId]?.[name]);
  const written = useRef(0);
  const revision = useRef<number | undefined>(undefined);
  const lastExit = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    if (!term) return;
    const chunks = output?.chunks ?? [];
    const total = output?.total ?? 0;
    // A restart clears the output: start the screen over too.
    if (total < written.current || revision.current !== output?.revision) {
      revision.current = output?.revision;
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
      {!output && <p className="absolute left-3 top-2 z-10 text-xs text-muted-foreground">{emptyText}</p>}
      <div ref={ref} className="h-full w-full px-2 py-1" />
    </div>
  );
}
