import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { joinRepositoryInstructions, type WorkbenchAgent } from '@talyn/shared';
import { processEnv } from './environment';

const run = promisify(execFile);

/**
 * The repository's Talyn instructions, written into the worktree before a
 * local turn: `CLAUDE.local.md` for Claude, `AGENTS.override.md` for Codex.
 * The sandbox does the same (see `instructions.ts` in the backend). Both
 * files are listed in `.git/info/exclude`, and a stamp file in the git
 * directory says the file is ours, so one the repository ships is never
 * replaced or removed.
 */

const FILE: Record<WorkbenchAgent, string> = { claude: 'CLAUDE.local.md', codex: 'AGENTS.override.md' };
const STAMP: Record<WorkbenchAgent, string> = { claude: 'talyn-claude-local', codex: 'talyn-agents-override' };

async function gitPath(cwd: string, name: string): Promise<string> {
  const { stdout } = await run('git', ['rev-parse', '--git-path', name], { cwd, env: await processEnv() });
  return path.resolve(cwd, stdout.trim());
}

async function readIfFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function exclude(cwd: string, file: string): Promise<void> {
  const target = await gitPath(cwd, 'info/exclude');
  const current = (await readIfFile(target)) ?? '';
  if (current.split('\n').includes(file)) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${file}\n`);
}

/**
 * `text` is the instructions when they apply to `agent`, and null when they
 * do not (none, deleted, or aimed at the other agent): a file we wrote earlier
 * is then removed. Never throws on a missing git directory: instructions are
 * worth one turn at most, not the turn.
 */
export async function applyRepositoryInstructions(
  worktree: string,
  agent: WorkbenchAgent,
  text: string | null,
): Promise<void> {
  const file = path.join(worktree, FILE[agent]);
  const stamp = await gitPath(worktree, STAMP[agent]);
  const ours = await exists(stamp);
  if (text === null) {
    if (ours) await Promise.all([fs.rm(file, { force: true }), fs.rm(stamp, { force: true })]);
    return;
  }
  if ((await exists(file)) && !ours) return;
  // Codex reads one of AGENTS.override.md and AGENTS.md per directory, so the
  // override carries the repository's own AGENTS.md.
  const own = agent === 'codex' ? await readIfFile(path.join(worktree, 'AGENTS.md')) : null;
  await exclude(worktree, FILE[agent]);
  await fs.writeFile(file, joinRepositoryInstructions(own && own.trim() ? own : null, text));
  await fs.writeFile(stamp, '');
}
