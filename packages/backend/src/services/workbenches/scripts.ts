import type { WorkbenchConfig } from '@talyn/shared';
import { emitWorkbenchScript } from './emit.js';
import { WorkbenchError } from './errors.js';
import { safeMarker } from './execFraming.js';
import {
  killMarker,
  loadWorkbenchConfig,
  recordWorkbenchEvent,
  runStream,
  sandboxScriptEnv,
} from './sandboxRuntime.js';
import type { WorkbenchRow } from './store.js';

/**
 * Setup, run and archive scripts in a sandbox workbench.
 *
 * Output streams to the client as `workbench:script` frames; nothing is
 * stored. A run script is a dev server more often than not, so it runs until
 * it is stopped — no timeout — and stopping it is a signal to its whole
 * process group by marker, which reaches whatever it spawned.
 */

interface RunningScript {
  controller: AbortController;
  marker: string;
  done: Promise<number | null>;
}

/** workbenchId → script name → the running process. In-process: the follower lives here. */
const running = new Map<string, Map<string, RunningScript>>();

export function scriptMarker(workbenchId: string, name: string): string {
  return safeMarker(`talyn-script-${workbenchId}-${name}`);
}

/** The command a script name stands for, or null when the config has none. */
export function commandFor(config: WorkbenchConfig, name: string): { command: string; isRun: boolean } | null {
  if (name === 'setup') return config.setup ? { command: config.setup.command, isRun: false } : null;
  if (name === 'archive') return config.archive ? { command: config.archive.command, isRun: false } : null;
  if (name === 'run') {
    const def = config.run.find((s) => s.default) ?? config.run[0];
    return def ? { command: def.command, isRun: true } : null;
  }
  const named = config.run.find((s) => s.name === name);
  return named ? { command: named.command, isRun: true } : null;
}

/**
 * Start a script and return once it has started; `done` settles with its exit
 * code. A script already running under this name is refused rather than
 * started twice — two dev servers on one port is the failure Conductor's
 * nonconcurrent mode exists to prevent.
 */
export async function startScript(
  row: WorkbenchRow,
  name: string,
  opts: { config?: WorkbenchConfig; timeoutMs?: number } = {},
): Promise<{ done: Promise<number | null> }> {
  const config = opts.config ?? (await loadWorkbenchConfig(row));
  const resolved = commandFor(config, name);
  if (!resolved) {
    throw new WorkbenchError(`This workbench has no "${name}" script.`, 404, 'script_not_found');
  }
  const scripts = running.get(row.id) ?? new Map<string, RunningScript>();
  running.set(row.id, scripts);
  if (scripts.has(name)) {
    throw new WorkbenchError(`The "${name}" script is already running.`, 409, 'script_running');
  }
  if (resolved.isRun && config.runMode === 'nonconcurrent') {
    const others = [...scripts.keys()].filter((n) => n !== name && commandFor(config, n)?.isRun);
    await Promise.all(others.map((n) => stopScript(row, n)));
  }

  const marker = scriptMarker(row.id, name);
  const controller = new AbortController();
  let pending: string[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  const flush = () => {
    flushTimer = null;
    if (pending.length === 0) return;
    const data = `${pending.join('\n')}\n`;
    pending = [];
    emitWorkbenchScript(row.workspaceId, { workbenchId: row.id, name, stream: 'stdout', data });
  };
  // Batched per 100ms: a build printing thousands of lines a second must not
  // become thousands of WebSocket frames.
  const push = (line: string) => {
    pending.push(line);
    if (!flushTimer) flushTimer = setTimeout(flush, 100);
  };
  const pushErr = (line: string) => {
    emitWorkbenchScript(row.workspaceId, { workbenchId: row.id, name, stream: 'stderr', data: `${line}\n` });
  };

  recordWorkbenchEvent(row, 'script_start', `script ${name} started`);
  const done = runStream(row, resolved.command, {
    marker,
    env: sandboxScriptEnv(row),
    signal: controller.signal,
    onStdoutLine: push,
    onStderrLine: pushErr,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  })
    .then((outcome) => outcome.exitCode)
    .catch((err) => {
      pushErr(`Talyn could not run this script: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    })
    .then((exitCode) => {
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      if (running.get(row.id)?.get(name)?.marker === marker) running.get(row.id)!.delete(name);
      emitWorkbenchScript(row.workspaceId, { workbenchId: row.id, name, stream: 'exit', exitCode });
      recordWorkbenchEvent(row, 'script_exit', `script ${name} exited ${exitCode}`, exitCode === 0);
      return exitCode;
    });
  scripts.set(name, { controller, marker, done });
  return { done };
}

/**
 * Stop a script by name. Works whether or not this process is following it:
 * the kill goes to the sandbox by marker, so a script started before a deploy
 * can still be stopped after it.
 */
export async function stopScript(row: WorkbenchRow, name: string): Promise<void> {
  const entry = running.get(row.id)?.get(name);
  await killMarker(row, scriptMarker(row.id, name));
  if (entry) {
    // The kill ends the exec, which ends the stream and emits `exit`. Waited
    // on briefly so a nonconcurrent start does not race the port; then the
    // follower is dropped either way.
    await Promise.race([entry.done, new Promise((r) => setTimeout(r, 10_000))]);
    entry.controller.abort();
    running.get(row.id)?.delete(name);
  }
}

/** Stop every script this process follows for a workbench (archive, delete). */
export async function stopAllScripts(row: WorkbenchRow): Promise<void> {
  const names = [...(running.get(row.id)?.keys() ?? [])];
  await Promise.all(names.map((n) => stopScript(row, n).catch(() => undefined)));
  running.delete(row.id);
}

export function runningScriptNames(workbenchId: string): string[] {
  return [...(running.get(workbenchId)?.keys() ?? [])];
}
