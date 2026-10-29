import {
  branchSlugFromSuggestion,
  branchSlugFromTitle,
  isValidBranchName,
  type ConfirmWorkbenchBranchNameResult,
  type NameWorkbenchBranchInput,
  type WorkbenchBranchNameDecision,
} from '@talyn/shared';
import { githubService } from '../github.js';
import { uniqueViolationConstraint } from './branchAllocation.js';
import { BRANCH_NAMING_MAX_TURNS, chooseBranchTarget, ineligible } from './branchName.js';
import { emitWorkbenchUpdated } from './emit.js';
import { WorkbenchError } from './errors.js';
import { publicWorkbench } from './prLink.js';
import { recordWorkbenchEvent } from './sandboxRuntime.js';
import {
  branchNamingDecided,
  claimBranchNaming,
  getWorkbench,
  localSessionTurnCount,
  otherRunningChats,
  renameAllocatedBranch,
  type WorkbenchRow,
} from './store.js';

/**
 * The branch rename after a LOCAL session's first turn (see `branchName.ts`
 * for the sandbox one). The desktop owns the git branch and Talyn owns the
 * row, so the rename is two calls and the row moves LAST:
 *
 * 1. `reserveLocalBranchName`: the same rules as a sandbox, the once-only
 *    claim on `branch_named_at`, the prefix and a unique name. The row does
 *    not change. Called with no suggestion, it only checks, so the desktop
 *    asks its model only for a session that may move.
 * 2. The desktop runs `git branch -m from to` (main checks the branch is
 *    current and has no upstream).
 * 3. `confirmLocalBranchName`: the guarded row update. A refusal tells the
 *    desktop to rename its branch back.
 *
 * Every failure before step 3 leaves the row and the branch on the old name.
 * The claim is not given back after it is taken: one attempt per session.
 */

const keep = (row: WorkbenchRow, reason: string, ok = true, error?: unknown): WorkbenchBranchNameDecision => {
  recordWorkbenchEvent(row, 'branch_name', `kept ${row.branch} (${reason})`, ok, error);
  return { outcome: 'keep', reason };
};

export async function reserveLocalBranchName(
  row: WorkbenchRow,
  input: NameWorkbenchBranchInput,
): Promise<WorkbenchBranchNameDecision> {
  if (row.runtime !== 'local') {
    throw new WorkbenchError('Only a local session names its branch through this route.', 409, 'sandbox_runtime');
  }
  const title = typeof input.title === 'string' ? input.title : undefined;
  const suggestion = typeof input.suggestion === 'string' ? input.suggestion : undefined;
  const chatId = typeof input.chatId === 'string' ? input.chatId : undefined;
  const checkOnly = title === undefined && suggestion === undefined;

  if (await branchNamingDecided(row.id)) return { outcome: 'keep', reason: 'decided' };
  const turns = await localSessionTurnCount(row.id);
  if (turns <= BRANCH_NAMING_MAX_TURNS && await otherRunningChats(row.id, chatId) > 0) {
    return { outcome: 'not_now', reason: 'turn_running' };
  }
  // A reason that cannot change is decided now, in a check too: no later turn asks again.
  const refusal = turns > BRANCH_NAMING_MAX_TURNS ? 'too_many_turns' : ineligible(row, 'local');
  if (refusal) return (await claimBranchNaming(row.id)) ? keep(row, refusal) : { outcome: 'keep', reason: 'decided' };
  if (checkOnly) return { outcome: 'suggest' };

  if (!(await claimBranchNaming(row.id))) return { outcome: 'keep', reason: 'decided' };
  const fresh = await getWorkbench(row.id);
  if (!fresh) return { outcome: 'keep', reason: 'gone' };
  const changed = ineligible(fresh, 'local');
  if (changed) return keep(fresh, changed);
  const [owner, repo] = fresh.repoFullName.split('/');
  try {
    // The desktop may have pushed the branch already. A pushed name is not ours to move.
    if (await githubService.branchExists(fresh.workspaceId, owner, repo, fresh.branch)) return keep(fresh, 'on_github');
  } catch (err) {
    return keep(fresh, 'github_error', false, err);
  }
  const slug = title !== undefined ? branchSlugFromTitle(title) : branchSlugFromSuggestion(suggestion);
  if (!slug) return keep(fresh, 'no_suggestion');
  const chosen = await chooseBranchTarget(fresh, slug);
  if ('keep' in chosen) return keep(fresh, chosen.keep, chosen.keep !== 'github_error', chosen.error);
  recordWorkbenchEvent(fresh, 'branch_name', `reserved ${chosen.target} for ${fresh.branch}`);
  return { outcome: 'rename', from: fresh.branch, to: chosen.target };
}

/**
 * The desktop renamed its branch `from` → `to`: the row follows, guarded on
 * `from`, a Talyn-named branch, no PR and not archived. Idempotent: a confirm
 * whose answer was lost can be sent again. `name_taken` when another session
 * took `to` after the reservation (the unique index decides).
 */
export async function confirmLocalBranchName(
  row: WorkbenchRow,
  input: { from?: unknown; to?: unknown },
): Promise<ConfirmWorkbenchBranchNameResult> {
  if (row.runtime !== 'local') {
    throw new WorkbenchError('Only a local session names its branch through this route.', 409, 'sandbox_runtime');
  }
  const { from, to } = input;
  if (typeof from !== 'string' || typeof to !== 'string' || !isValidBranchName(from) || !isValidBranchName(to)) {
    throw new WorkbenchError('from and to must be valid branch names.', 400, 'bad_branch');
  }
  if (row.branch === to && row.allocatedBranch) return { outcome: 'renamed', workbench: await publicWorkbench(row) };
  // Only a reserved attempt confirms: the claim is taken before a name is handed out.
  if (!(await branchNamingDecided(row.id))) return { outcome: 'refused', reason: 'row_changed' };
  let updated: WorkbenchRow | null;
  try {
    updated = await renameAllocatedBranch(row.id, from, to);
  } catch (err) {
    if (uniqueViolationConstraint(err) !== 'uq_workbenches_allocated_branch') throw err;
    recordWorkbenchEvent(row, 'branch_name', `${to} was taken before ${from} could move`, false, err);
    return { outcome: 'refused', reason: 'name_taken' };
  }
  if (!updated) return { outcome: 'refused', reason: 'row_changed' };
  recordWorkbenchEvent(row, 'branch_name', `renamed ${from} to ${to}`);
  const workbench = await publicWorkbench(updated);
  await emitWorkbenchUpdated(workbench);
  return { outcome: 'renamed', workbench };
}
