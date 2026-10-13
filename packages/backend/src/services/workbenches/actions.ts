import { v4 as uuid } from 'uuid';
import { eq } from 'drizzle-orm';
import { resolveWorkbenchActionPrompt, type WorkbenchNextAction, type WorkbenchPromptAction } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { pullRequests as prTable } from '../../db/schema.js';
import { githubService } from '../github.js';
import { emitWorkbenchChat } from './emit.js';
import { localRuntimeError, WorkbenchError } from './errors.js';
import { archiveWorkbench } from './lifecycle.js';
import { getChat, insertChat, latestChat, rowToChat, type WorkbenchRow } from './store.js';
import { sendMessage } from './turns.js';

/**
 * The header's one button. Three of the actions are PROMPTS — the agent opens
 * the PR, fixes the checks, resolves the conflicts — sent as an ordinary
 * message, so they queue behind a running turn like anything else. `merge`
 * and `archive` are not agent work.
 */

export const WORKBENCH_ACTIONS: ReadonlyArray<Exclude<WorkbenchNextAction, null>> = [
  'create_pr',
  'resolve_conflicts',
  'fix_checks',
  'merge',
  'archive',
];

const PROMPT_ACTIONS: ReadonlySet<string> = new Set<WorkbenchPromptAction>([
  'create_pr',
  'fix_checks',
  'resolve_conflicts',
  'rename_branch',
]);

export async function runWorkbenchAction(
  row: WorkbenchRow,
  action: string,
  chatId?: string,
): Promise<{ chatId?: string }> {
  if (action === 'archive') {
    await archiveWorkbench(row.id);
    return {};
  }
  if (action === 'merge') {
    await mergeLinkedPullRequest(row);
    return {};
  }
  if (!PROMPT_ACTIONS.has(action)) {
    throw new WorkbenchError(`Unknown action "${action}".`, 400, 'bad_action');
  }
  // A local workbench runs its own turns; the desktop resolves the same
  // prompt from `@talyn/shared` and sends it there.
  if (row.runtime === 'local') throw localRuntimeError();

  let chat = chatId ? await getChat(chatId) : await latestChat(row.id);
  if (chatId && (!chat || chat.workbenchId !== row.id)) {
    throw new WorkbenchError('That chat does not belong to this workbench.', 404, 'not_found');
  }
  if (!chat || chat.closedAt) {
    chat = await insertChat({
      id: uuid(),
      workbenchId: row.id,
      workspaceId: row.workspaceId,
      title: 'Chat',
      agent: row.agent,
      model: row.model,
    });
    emitWorkbenchChat(row.workspaceId, rowToChat(chat));
  }
  const text = resolveWorkbenchActionPrompt(action as WorkbenchPromptAction, row.settings, {
    branch: row.branch,
    baseBranch: row.baseBranch,
  });
  await sendMessage(chat.id, { text });
  return { chatId: chat.id };
}

/** Merge the PR this branch opened, with the method the PR row carries. */
async function mergeLinkedPullRequest(row: WorkbenchRow): Promise<void> {
  if (!row.pullRequestId) {
    throw new WorkbenchError('This workbench has no pull request to merge.', 409, 'no_pull_request');
  }
  const rows = await getPoolDbClient()
    .select({ owner: prTable.owner, repo: prTable.repo, number: prTable.number, mergeMethod: prTable.mergeMethod })
    .from(prTable)
    .where(eq(prTable.id, row.pullRequestId))
    .limit(1);
  const pr = rows[0];
  if (!pr) throw new WorkbenchError('This workbench has no pull request to merge.', 409, 'no_pull_request');
  const method = pr.mergeMethod === 'merge' || pr.mergeMethod === 'rebase' ? pr.mergeMethod : 'squash';
  try {
    await githubService.mergePullRequest(row.workspaceId, pr.owner, pr.repo, pr.number, { merge_method: method });
  } catch (err) {
    throw new WorkbenchError(
      `GitHub did not merge the pull request: ${err instanceof Error ? err.message : String(err)}`,
      409,
      'merge_failed',
    );
  }
}
