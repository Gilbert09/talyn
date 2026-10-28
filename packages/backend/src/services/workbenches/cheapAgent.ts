import { buildWorkbenchTitleArgv, CLAUDE_SANDBOX_ENV, shellQuote, WORKBENCH_TITLE_TIMEOUT_MS } from '@talyn/shared';
import { runCapture, sandboxScriptEnv, type SandboxExecResult } from './sandboxRuntime.js';
import type { WorkbenchRow } from './store.js';

/** `runCapture`'s shape, so a test can answer for the box. */
export type SandboxRun = (row: WorkbenchRow, script: string, opts: Parameters<typeof runCapture>[2]) => Promise<SandboxExecResult>;

export interface CheapAgentOptions {
  run?: SandboxRun;
  timeoutMs?: number;
  graceMs?: number;
}

/**
 * One prompt to the session's own agent CLI, in its sandbox, on the
 * subscription the sandbox already has, with the cheapest catalogue model and
 * no tools. Null when the box gave no answer in time or the call threw.
 */
export async function askSessionAgent(row: WorkbenchRow, prompt: string, opts: CheapAgentOptions = {}): Promise<SandboxExecResult | null> {
  const run = opts.run ?? runCapture;
  const timeoutMs = opts.timeoutMs ?? WORKBENCH_TITLE_TIMEOUT_MS;
  const agent = row.agent === 'codex' ? 'codex' : 'claude';
  const argv = buildWorkbenchTitleArgv(agent, prompt);
  const env = { ...sandboxScriptEnv(row), ...(agent === 'claude' ? CLAUDE_SANDBOX_ENV : {}) };
  let timer: NodeJS.Timeout | undefined;
  // The guest bounds the command; this bounds a fleet call that never answers.
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs + (opts.graceMs ?? 5_000));
  });
  try {
    return await Promise.race([
      // `/tmp`, not the repository: the call needs no project instructions.
      run(row, argv.map(shellQuote).join(' '), { cwd: '/tmp', env, timeoutMs, quiet: true }).catch(() => null),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
