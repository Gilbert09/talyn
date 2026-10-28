import {
  currentBranch,
  currentUpstream,
  isValidBranchName,
  renameBranch,
  type GitStep,
  type WorkbenchExecResult,
} from '@talyn/shared';

export type GitRunner = (cwd: string, steps: GitStep[]) => Promise<WorkbenchExecResult>;

export type RenameBranchResult = { ok: true } | { ok: false; reason: string };

/**
 * Rename a worktree's branch for Talyn's after-first-turn naming. Main checks
 * the facts itself and does not trust the renderer: `from` must be the branch
 * checked out in THIS worktree, and must have no upstream (a pushed branch is
 * not ours to move). `git branch -m` then refuses a name that already exists.
 */
export async function renameWorktreeBranch(
  input: { path: string; from: string; to: string },
  run: GitRunner,
): Promise<RenameBranchResult> {
  if (!isValidBranchName(input.from) || !isValidBranchName(input.to)) return { ok: false, reason: 'invalid_name' };
  if (input.from === input.to) return { ok: false, reason: 'same_name' };
  const head = await run(input.path, [currentBranch()]);
  if (head.exitCode !== 0) return { ok: false, reason: 'probe_failed' };
  if (head.stdout.trim() !== input.from) return { ok: false, reason: 'not_current' };
  const upstream = await run(input.path, [currentUpstream()]);
  if (upstream.exitCode === 0 && upstream.stdout.trim()) return { ok: false, reason: 'has_upstream' };
  const renamed = await run(input.path, [renameBranch(input.to, input.from)]);
  return renamed.exitCode === 0 ? { ok: true } : { ok: false, reason: 'rename_failed' };
}
