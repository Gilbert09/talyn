import {
  buildWorkbenchTitleArgv,
  CLAUDE_SANDBOX_ENV,
  sanitizeWorkbenchTitle,
  shellQuote,
  workbenchTitlePrompt,
  WORKBENCH_TITLE_TIMEOUT_MS,
} from '@talyn/shared';
import { emitWorkbenchUpdated } from './emit.js';
import { publicWorkbench } from './prLink.js';
import { recordWorkbenchEvent, runCapture, sandboxScriptEnv, type SandboxExecResult } from './sandboxRuntime.js';
import { setGeneratedTitle, type WorkbenchRow } from './store.js';

/**
 * A display title for a sandbox session, from its first message.
 *
 * Runs the session's own agent CLI in its sandbox, on the subscription the
 * sandbox already has, with the cheapest catalogue model. It runs beside the
 * first turn and never blocks or fails it: any failure keeps the name. The
 * write only lands while the session has no title, so a person's rename wins.
 */

/** Workbenches this process has already asked about. One attempt each. */
const attempted = new Set<string>();

type Run = (row: WorkbenchRow, script: string, opts: Parameters<typeof runCapture>[2]) => Promise<SandboxExecResult>;

/** Start the title call once per workbench, in the background. */
export function startTitleGeneration(row: WorkbenchRow, firstMessage: string): void {
  if (row.title || row.runtime !== 'sandbox' || attempted.has(row.id)) return;
  attempted.add(row.id);
  void generateSandboxTitle(row, firstMessage).catch((err) => {
    console.warn(`[workbench] title for ${row.id} failed:`, err);
  });
}

/** The new row when a title was written; null when the name stays. */
export async function generateSandboxTitle(
  row: WorkbenchRow,
  firstMessage: string,
  opts: { run?: Run; timeoutMs?: number; graceMs?: number } = {},
): Promise<WorkbenchRow | null> {
  const run = opts.run ?? runCapture;
  const timeoutMs = opts.timeoutMs ?? WORKBENCH_TITLE_TIMEOUT_MS;
  if (!firstMessage.trim()) return null;
  const agent = row.agent === 'codex' ? 'codex' : 'claude';
  const argv = buildWorkbenchTitleArgv(agent, workbenchTitlePrompt(firstMessage));
  const env = { ...sandboxScriptEnv(row), ...(agent === 'claude' ? CLAUDE_SANDBOX_ENV : {}) };
  let timer: NodeJS.Timeout | undefined;
  // The guest bounds the command; this bounds a fleet call that never answers.
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs + (opts.graceMs ?? 5_000));
  });
  let result: SandboxExecResult | null;
  try {
    result = await Promise.race([
      // `/tmp`, not the repository: the title needs no project instructions.
      run(row, argv.map(shellQuote).join(' '), { cwd: '/tmp', env, timeoutMs, quiet: true }).catch(() => null),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
  const title = result && result.exitCode === 0 ? sanitizeWorkbenchTitle(result.stdout) : null;
  if (!title) {
    recordWorkbenchEvent(row, 'title', result ? `no usable title (exit ${result.exitCode})` : 'no answer from the sandbox', false);
    return null;
  }
  const updated = await setGeneratedTitle(row.id, title);
  if (!updated) return null;
  recordWorkbenchEvent(row, 'title', 'title set');
  await emitWorkbenchUpdated(await publicWorkbench(updated));
  return updated;
}
