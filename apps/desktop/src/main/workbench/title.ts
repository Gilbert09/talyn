import os from 'os';
import { spawn } from 'child_process';
import {
  buildWorkbenchTitleArgv,
  sanitizeWorkbenchTitle,
  workbenchBranchPrompt,
  workbenchTitlePrompt,
  WORKBENCH_TITLE_TIMEOUT_MS,
  type WorkbenchAgent,
} from '@talyn/shared';
import { processEnv } from './environment';

export interface TitleRunResult {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
}

export type TitleRunner = (argv: string[], timeoutMs: number) => Promise<TitleRunResult>;

/**
 * Run one CLI call to its end, or kill it at the timeout. stdin is closed:
 * both CLIs read a piped stdin as more prompt and would wait for it.
 */
export const runTitleCommand: TitleRunner = async (argv, timeoutMs) => {
  const env = await processEnv();
  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, timedOut });
    };
    const child = spawn(argv[0], argv.slice(1), {
      // Not the worktree: the title needs no project instructions.
      cwd: os.tmpdir(),
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      // A title is a few words. Much more than that is not one.
      if (stdout.length < 16 * 1024) stdout += chunk;
    });
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code));
  });
};

/**
 * A display title for a local session, from its first message, on the
 * user's own CLI and subscription. Null when the call fails, times out or
 * returns something that is not a title: the caller keeps the name.
 */
export async function generateWorkbenchTitle(
  input: { agent: WorkbenchAgent; message: string },
  run: TitleRunner = runTitleCommand,
  timeoutMs = WORKBENCH_TITLE_TIMEOUT_MS,
): Promise<string | null> {
  if (input.agent !== 'claude' && input.agent !== 'codex') return null;
  if (typeof input.message !== 'string' || !input.message.trim()) return null;
  try {
    const argv = buildWorkbenchTitleArgv(input.agent, workbenchTitlePrompt(input.message));
    const result = await run(argv, timeoutMs);
    if (result.timedOut || result.exitCode !== 0) return null;
    return sanitizeWorkbenchTitle(result.stdout);
  } catch {
    return null;
  }
}

/** A slug is a few words. An answer longer than this is not one, and Talyn refuses it anyway. */
const MAX_BRANCH_ANSWER = 200;

/**
 * A model's one-line branch name for a local session's work, by the same CLI
 * and cheap model as the title. The raw answer: the backend reads it and
 * decides. Null when the call fails or times out.
 */
export async function suggestWorkbenchBranchName(
  input: { agent: WorkbenchAgent; message: string; changedFiles: string[]; finalMessage: string },
  run: TitleRunner = runTitleCommand,
  timeoutMs = WORKBENCH_TITLE_TIMEOUT_MS,
): Promise<string | null> {
  if (input.agent !== 'claude' && input.agent !== 'codex') return null;
  try {
    const prompt = workbenchBranchPrompt({
      firstMessage: typeof input.message === 'string' ? input.message : '',
      changedFiles: Array.isArray(input.changedFiles) ? input.changedFiles.filter((f) => typeof f === 'string') : [],
      finalMessage: typeof input.finalMessage === 'string' ? input.finalMessage : '',
    });
    const result = await run(buildWorkbenchTitleArgv(input.agent, prompt), timeoutMs);
    if (result.timedOut || result.exitCode !== 0) return null;
    const answer = result.stdout.trim();
    return answer && answer.length <= MAX_BRANCH_ANSWER ? answer : null;
  } catch {
    return null;
  }
}
