import { spawn, type ChildProcess } from 'child_process';
import {
  buildPrDraftArgv,
  createClaudeStreamParser,
  createCodexStreamParser,
  LineBuffer,
  parsePrDraft,
  PR_DRAFT_TIMEOUT_MS,
  type WorkbenchLocalBridge,
  type WorkbenchPrDraft,
} from '@talyn/shared';
import { processEnv } from './environment';
import { stopGroup } from './processes';

type DraftInput = Parameters<WorkbenchLocalBridge['draftPullRequest']>[0];

/**
 * The Create PR draft for a local workbench: one hidden agent run in the
 * worktree, with the same argv the sandbox builds. Its output never reaches
 * the chat, and a Claude run forks the chat's session instead of continuing
 * it, so the chat's own session id does not change.
 */
export class PrDrafts {
  private readonly running = new Set<ChildProcess>();

  constructor(
    private readonly command?: (input: DraftInput) => string[],
    private readonly timeoutMs = PR_DRAFT_TIMEOUT_MS,
  ) {}

  async draft(input: DraftInput): Promise<WorkbenchPrDraft> {
    if (input.agent !== 'claude' && input.agent !== 'codex')
      throw new Error('Unknown agent');
    if (!input.path) throw new Error('The session has no local path');
    const argv =
      this.command?.(input) ??
      buildPrDraftArgv({
        agent: input.agent,
        prompt: input.prompt,
        resumeSessionId: input.resumeSessionId,
        model: input.model,
      });
    const parser =
      input.agent === 'claude'
        ? createClaudeStreamParser()
        : createCodexStreamParser();
    const lines = new LineBuffer();
    const child = spawn(argv[0], argv.slice(1), {
      cwd: input.path,
      env: await processEnv(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.running.add(child);
    let stderr = '';
    let spawnError: string | undefined;
    let timedOut = false;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) =>
      lines.push(chunk).forEach((line) => parser.push(line)),
    );
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8 * 1024);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) void stopGroup(child.pid).catch(() => undefined);
    }, this.timeoutMs);
    const exitCode = await new Promise<number | null>((resolve) => {
      child.once('error', (error) => {
        spawnError = error.message;
      });
      child.once('close', (code) => resolve(code));
    });
    clearTimeout(timer);
    this.running.delete(child);
    lines.flush().forEach((line) => parser.push(line));

    const result = parser.result;
    if (timedOut) throw new Error('The agent took too long to draft the pull request.');
    if (spawnError || !result || result.isError || exitCode !== 0) {
      const tail = stderr.trim().split('\n').slice(-4).join('\n');
      throw new Error(
        spawnError ??
          (result?.text.trim() ||
            tail ||
            `The agent exited with code ${exitCode ?? 'unknown'}.`),
      );
    }
    const parsed = parsePrDraft(result.text);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.draft;
  }

  shutdown(): void {
    for (const child of this.running)
      if (child.pid) void stopGroup(child.pid).catch(() => undefined);
  }
}
