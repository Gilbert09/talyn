import { shellQuote } from '@talyn/shared';
import { startDurableExec, followDurableExec } from './durableExec.js';
import { claimScript, renewScript, appendScriptOutput, finishScript, staleScripts, adoptScript, storedScriptNames, stopStoredScript, existingScript, type ScriptLease } from './scriptStore.js';
import { isWorkbenchDraining, isWorkbenchDetached } from './ownership.js';
import { getWorkbench } from './store.js';
import type { WorkbenchConfig } from '@talyn/shared';
import { emitWorkbenchScript } from './emit.js';
import { WorkbenchError } from './errors.js';
import { safeMarker } from './execFraming.js';
import {
  killMarker,
  loadWorkbenchConfig,
  recordWorkbenchEvent,
  sandboxScriptEnv,
} from './sandboxRuntime.js';
import type { WorkbenchRow } from './store.js';

/**
 * Setup, run and archive scripts in a sandbox workbench.
 *
 * The sandbox keeps a log. A leased follower stores its offset and recent
 * output before broadcasting. A new backend resumes from that offset.
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
  opts: { config?: WorkbenchConfig; timeoutMs?: number; resume?: boolean } = {},
): Promise<{ done: Promise<number | null> }> {
  if (isWorkbenchDraining()) throw new WorkbenchError('The session is reconnecting. Try again shortly.', 503, 'draining');
  if (opts.resume && await existingScript(row.id, name, row.sandboxId!)) {
    const done = (async () => {
      for (;;) {
        const state = await existingScript(row.id, name, row.sandboxId!);
        if (!state?.running) return state?.exitCode ?? null;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    })();
    return { done };
  }
  const config = opts.config ?? (await loadWorkbenchConfig(row));
  const resolved = commandFor(config, name);
  if (!resolved) {
    throw new WorkbenchError(`This session has no "${name}" script.`, 404, 'script_not_found');
  }
  const scripts = running.get(row.id) ?? new Map<string, RunningScript>();
  running.set(row.id, scripts);
  if (scripts.has(name)) {
    throw new WorkbenchError(`The "${name}" script is already running.`, 409, 'script_running');
  }
  if (resolved.isRun && config.runMode === 'nonconcurrent') {
    const others = (await storedScriptNames(row.id)).filter((n) => n !== name && commandFor(config, n)?.isRun);
    await Promise.all(others.map((n) => stopScript(row, n)));
  }

  const lease = await claimScript(row, name);
  if (!lease) throw new WorkbenchError(`The "${name}" script is already running.`, 409, 'script_running');
  const marker = scriptMarker(row.id, name);
  const command = opts.timeoutMs ? `timeout ${Math.ceil(opts.timeoutMs / 1000)} bash -c ${shellQuote(resolved.command)}` : resolved.command;
  try {
    await startDurableExec(row, lease.generation, marker, command, sandboxScriptEnv(row));
  } catch (err) {
    await finishScript(lease, null);
    throw err;
  }
  recordWorkbenchEvent(row, 'script_start', `script ${name} started`);
  return followScript(row, lease);
}

function followScript(row: WorkbenchRow, lease: ScriptLease): { done: Promise<number | null> } {
  const marker = scriptMarker(row.id, lease.name);
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (isWorkbenchDetached()) { controller.abort(); return; }
    void renewScript(lease).then((ok) => { if (!ok) controller.abort(); }).catch(() => controller.abort());
  }, 20_000);
  timer.unref();
  const done = followDurableExec(row, lease.generation, marker, lease.offset, async (record, offset) => {
    const data = `${record.line}\n`;
    if (!(await appendScriptOutput(lease, data, offset))) { controller.abort(); return; }
    emitWorkbenchScript(row.workspaceId, { workbenchId: row.id, name: lease.name,
      stream: record.stream, data, generation: lease.generation, offset });
  }, controller.signal).then(async (outcome) => {
    if (controller.signal.aborted || isWorkbenchDetached()) return null;
    if (await finishScript(lease, outcome.exitCode)) {
      emitWorkbenchScript(row.workspaceId, { workbenchId: row.id, name: lease.name, stream: 'exit',
        exitCode: outcome.exitCode, generation: lease.generation, offset: lease.offset });
    }
    return outcome.exitCode;
  }).catch((err: unknown) => {
    recordWorkbenchEvent(row, 'script_follow_failed', 'The script output will reconnect.', false, err);
    return null;
  }).finally(() => {
    clearInterval(timer);
    if (running.get(row.id)?.get(lease.name)?.controller === controller) running.get(row.id)?.delete(lease.name);
  });
  const scripts = running.get(row.id) ?? new Map<string, RunningScript>();
  scripts.set(lease.name, { controller, marker, done });
  running.set(row.id, scripts);
  return { done };
}

export async function sweepScripts(): Promise<void> {
  if (isWorkbenchDraining()) return;
  for (const lease of await staleScripts()) {
    const row = await getWorkbench(lease.workbenchId);
    if (!row?.sandboxId || row.sandboxId !== lease.sandboxId || (row.archivedAt && lease.name !== 'archive') || !(await adoptScript(lease))) continue;
    followScript(row, lease);
  }
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
  await stopStoredScript(row.id, name);
}

/** Stop every script this process follows for a workbench (archive, delete). */
export async function stopAllScripts(row: WorkbenchRow): Promise<void> {
  const names = [...new Set([...(running.get(row.id)?.keys() ?? []), ...await storedScriptNames(row.id)])];
  await Promise.all(names.map((n) => stopScript(row, n).catch(() => undefined)));
  running.delete(row.id);
}

export function runningScriptNames(workbenchId: string): string[] {
  return [...(running.get(workbenchId)?.keys() ?? [])];
}
