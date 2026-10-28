import { v4 as uuid } from 'uuid';
import { and, asc, eq, sql } from 'drizzle-orm';
import { resolveWorkbenchActionPrompt, type WorkbenchNextAction, type WorkbenchPromptAction } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { prCheckStates, pullRequests as prTable } from '../../db/schema.js';
import { githubService } from '../github.js';
import { activePrTaskId } from '../prCloudFix.js';
import { emitWorkbenchChat } from './emit.js';
import { localRuntimeError, WorkbenchError } from './errors.js';
import { archiveWorkbench } from './lifecycle.js';
import { getChat, insertChat, latestChat, rowToChat, type WorkbenchRow } from './store.js';
import { sendMessage } from './turns.js';

/**
 * The header's one button. Two of the actions are PROMPTS — the agent fixes
 * the checks or resolves the conflicts — sent as an ordinary message, so they
 * queue behind a running turn like anything else. `merge` and `archive` are
 * not agent work, and neither is Create PR: Talyn opens the PR itself
 * (`pullRequest.ts`, `POST /:id/pull-request`).
 */

export const WORKBENCH_ACTIONS: ReadonlyArray<Exclude<WorkbenchNextAction, null>> = [
  'create_pr',
  'resolve_conflicts',
  'fix_checks',
  'merge',
  'archive',
];

const PROMPT_ACTIONS: ReadonlySet<string> = new Set<WorkbenchPromptAction>([
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
  if (action === 'create_pr') {
    throw new WorkbenchError('Create PR is not a prompt: use POST /workbenches/:id/pull-request.', 400, 'bad_action');
  }
  if (!PROMPT_ACTIONS.has(action)) {
    throw new WorkbenchError(`Unknown action "${action}".`, 400, 'bad_action');
  }
  // A cloud task already pushing to this PR's branch would collide with the
  // session's own fix. One agent per PR, either way round.
  if ((action === 'fix_checks' || action === 'resolve_conflicts') && row.pullRequestId) {
    if (await activePrTaskId(row.workspaceId, row.pullRequestId)) {
      throw new WorkbenchError(
        'A cloud task is already working on this pull request. Stop it, or wait for it to finish.',
        409,
        'task_active',
      );
    }
  }
  // A local workbench runs its own turns; the desktop resolves the same
  // prompt from `@talyn/shared` and sends it there.
  if (row.runtime === 'local') throw localRuntimeError();

  let chat = chatId ? await getChat(chatId) : await latestChat(row.id);
  if (chatId && (!chat || chat.workbenchId !== row.id)) {
    throw new WorkbenchError('That chat does not belong to this session.', 404, 'not_found');
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
  let text = resolveWorkbenchActionPrompt(action as WorkbenchPromptAction, row.settings, {
    branch: row.branch,
    baseBranch: row.baseBranch,
  });
  if (action === 'fix_checks') {
    const context = await readFixChecksContext(row);
    if (context) text = `${text}\n\n${context}`;
  }
  // The intent makes the end of the turn read the new branch, so the row follows it.
  await sendMessage(chat.id, { text, ...(action === 'rename_branch' ? { intent: 'rename_branch' as const } : {}) });
  return { chatId: chat.id };
}

/** Merge the PR this branch opened, with the method the PR row carries. */
async function mergeLinkedPullRequest(row: WorkbenchRow): Promise<void> {
  if (!row.pullRequestId) {
    throw new WorkbenchError('This session has no pull request to merge.', 409, 'no_pull_request');
  }
  const rows = await getPoolDbClient()
    .select({ owner: prTable.owner, repo: prTable.repo, number: prTable.number, mergeMethod: prTable.mergeMethod })
    .from(prTable)
    .where(eq(prTable.id, row.pullRequestId))
    .limit(1);
  const pr = rows[0];
  if (!pr) throw new WorkbenchError('This session has no pull request to merge.', 409, 'no_pull_request');
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

// ============================================================================
// Fix checks: the failing checks, in the prompt
// ============================================================================

export interface FailingCheckFact {
  name: string;
  /** GitHub's own conclusion before normalisation (FAILURE, TIMED_OUT…), when known. */
  conclusion: string | null;
  /** null when GitHub's required-ness is not known. */
  required: boolean | null;
  url: string | null;
}

export interface FixChecksContextInput {
  prNumber: number;
  prUrl: string | null;
  headSha: string | null;
  checks: FailingCheckFact[];
  /** True when only the names could be read (the ledger had nothing for this commit). */
  namesOnly?: boolean;
}

function requiredLabel(required: boolean | null): string {
  if (required === true) return 'required';
  if (required === false) return 'optional';
  return 'required-ness unknown';
}

/**
 * The block appended to the fix-checks prompt: each failing check with its
 * conclusion, whether it blocks the merge, and the link to its run. Required
 * checks first, because an optional one does not block the merge. Empty
 * when there is nothing to name, so the configured prompt goes alone.
 */
export function formatFixChecksContext(input: FixChecksContextInput): string {
  if (input.checks.length === 0) return '';
  const order = (c: FailingCheckFact) => (c.required === true ? 0 : c.required === null ? 1 : 2);
  const sorted = input.checks
    .slice()
    .sort((a, b) => order(a) - order(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const head = input.headSha ? ` (head ${input.headSha.slice(0, 7)})` : '';
  const lines = [`## Failing checks on #${input.prNumber}${head}`, ''];
  for (const c of sorted) {
    const parts = [`\`${c.name}\``];
    if (!input.namesOnly) {
      parts.push(c.conclusion ? c.conclusion.toLowerCase().replace(/_/g, ' ') : 'failed');
      parts.push(requiredLabel(c.required));
    }
    lines.push(`- ${parts.join(' — ')}${c.url ? ` — ${c.url}` : ''}`);
  }
  if (input.prUrl) lines.push('', `All checks: ${input.prUrl}/checks`);
  if (sorted.some((c) => c.required === false) && sorted.some((c) => c.required !== false)) {
    lines.push('', 'Fix the required checks first. An optional check does not block the merge.');
  }
  return lines.join('\n');
}

/**
 * The failing checks of the PR this workbench opened, formatted for the
 * prompt, or '' when there is no PR or nothing is known to fail.
 *
 * Reads the check ledger for the PR's head commit. The PR row is read
 * through a projection: the head sha, the URL and the failed count come out
 * of `last_summary` in SQL, so the blob never ships. When the ledger has
 * nothing for that commit but the summary counts failures, the names are
 * read live from GitHub — rare, because this runs once per button press.
 * Never throws: a sharper prompt must never stop the fix from starting.
 */
export async function readFixChecksContext(row: Pick<WorkbenchRow, 'workspaceId' | 'pullRequestId'>): Promise<string> {
  if (!row.pullRequestId) return '';
  try {
    const db = getPoolDbClient();
    const prs = await db
      .select({
        owner: prTable.owner,
        repo: prTable.repo,
        number: prTable.number,
        headSha: sql<string | null>`${prTable.lastSummary} ->> 'headSha'`,
        url: sql<string | null>`${prTable.lastSummary} ->> 'url'`,
        failed: sql<number | null>`(${prTable.lastSummary} -> 'checks' ->> 'failed')::int`,
      })
      .from(prTable)
      .where(and(eq(prTable.id, row.pullRequestId), eq(prTable.workspaceId, row.workspaceId)))
      .limit(1);
    const pr = prs[0];
    if (!pr) return '';
    const base = { prNumber: pr.number, prUrl: pr.url, headSha: pr.headSha };

    if (pr.headSha) {
      const ledger = await db
        .select({
          name: prCheckStates.name,
          rawState: prCheckStates.rawState,
          required: prCheckStates.required,
          url: prCheckStates.url,
        })
        .from(prCheckStates)
        .where(
          and(
            eq(prCheckStates.repoFullName, `${pr.owner}/${pr.repo}`.toLowerCase()),
            eq(prCheckStates.headSha, pr.headSha),
            eq(prCheckStates.state, 'failure'),
          ),
        )
        .orderBy(asc(prCheckStates.name));
      if (ledger.length > 0) {
        return formatFixChecksContext({
          ...base,
          checks: ledger.map((c) => ({ name: c.name, conclusion: c.rawState, required: c.required, url: c.url })),
        });
      }
    }

    if ((pr.failed ?? 0) === 0) return '';
    const live = await githubService.listFailingCheckNames(row.workspaceId, pr.owner, pr.repo, pr.number);
    if (!live || live.names.length === 0) return '';
    return formatFixChecksContext({
      ...base,
      headSha: live.headSha,
      namesOnly: true,
      checks: live.names.map((name) => ({ name, conclusion: null, required: null, url: null })),
    });
  } catch (err) {
    console.warn('[workbenches] could not read the failing checks:', err instanceof Error ? err.message : err);
    return '';
  }
}
