import { buildWorkbenchTitleArgv, CLAUDE_SANDBOX_ENV, shellQuote, WORKBENCH_TITLE_TIMEOUT_MS, type FleetAgent } from '@talyn/shared';
import { sandboxAgents } from './credentialPolicy.js';
import { runCapture, sandboxScriptEnv, type SandboxExecResult } from './sandboxRuntime.js';
import type { WorkbenchRow } from './store.js';

/** `runCapture`'s shape, so a test can answer for the box. */
export type SandboxRun = (row: WorkbenchRow, script: string, opts: Parameters<typeof runCapture>[2]) => Promise<SandboxExecResult>;

export interface CheapAgentOptions {
  run?: SandboxRun;
  timeoutMs?: number;
  graceMs?: number;
  /** The agent to prefer, such as the turn's. A box without its key uses an agent it has. */
  agent?: FleetAgent;
}

/**
 * The agent CLI that can answer in this box. The session's agent can differ
 * from the box's keys: a box started while one vendor had no usable key holds
 * only the other vendor's key.
 */
export function cheapAgentFor(row: WorkbenchRow, preferred?: FleetAgent): FleetAgent {
  const wanted = preferred ?? (row.agent === 'codex' ? 'codex' : 'claude');
  const held = sandboxAgents(row);
  return held.includes(wanted) ? wanted : held[0] ?? wanted;
}

/**
 * One prompt to the session's own agent CLI, in its sandbox, on the
 * subscription the sandbox already has, with the cheapest catalogue model and
 * no tools. Null when the box gave no answer in time or the call threw.
 */
export async function askSessionAgent(row: WorkbenchRow, prompt: string, opts: CheapAgentOptions = {}): Promise<SandboxExecResult | null> {
  const run = opts.run ?? runCapture;
  const timeoutMs = opts.timeoutMs ?? WORKBENCH_TITLE_TIMEOUT_MS;
  const agent = cheapAgentFor(row, opts.agent);
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
