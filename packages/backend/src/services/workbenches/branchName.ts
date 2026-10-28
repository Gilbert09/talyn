import {
  branchSlugFromSuggestion,
  currentBranch,
  branchSlugFromTitle,
  isValidBranchName,
  parseNulList,
  renameBranch,
  toShellScript,
  workbenchBranchPrompt,
  WORKBENCH_BRANCH_PROMPT_FILES_MAX,
} from '@talyn/shared';
import { describeError } from '../debugBus.js';
import { githubService } from '../github.js';
import { allocateWorkbenchBranch, sessionBranchPrefix, uniqueViolationConstraint } from './branchAllocation.js';
import { mergeBaseLine } from './changes.js';
import { askSessionAgent, type CheapAgentOptions, type SandboxRun } from './cheapAgent.js';
import { emitWorkbenchUpdated } from './emit.js';
import { parseSections, sectionsScript } from './execFraming.js';
import { linkPullRequest, publicWorkbench } from './prLink.js';
import { recordWorkbenchEvent, runCapture } from './sandboxRuntime.js';
import {
  branchNamingDecided,
  claimBranchNaming,
  followChosenBranch,
  getWorkbench,
  otherRunningChats,
  releaseBranchNaming,
  renameAllocatedBranch,
  sessionTurnCount,
  type WorkbenchRow,
} from './store.js';

/**
 * A better branch name for a new sandbox session, after its first successful turn.
 *
 * At creation the branch comes from the prompt, which is often a guess. After
 * a turn, the session's own agent CLI (cheap model, as for the title) suggests
 * a slug from the request, the changed files and its summary. Talyn keeps the
 * final say: it adds the workspace prefix, makes the name unique, and renames
 * only a branch that nobody else can have seen yet (no PR, never pushed, not
 * on GitHub, no upstream in the box).
 *
 * Two paths reach it. A turn that opens a pull request names the branch
 * just before the push, from the agent's own PR title (no model call), with
 * a deadline (`nameBranchBeforePullRequest`). Any other successful turn names
 * it afterwards, in the background (`startBranchNaming`).
 *
 * One attempt per workbench, recorded in `branch_named_at`. The claim is taken
 * before the slow part, so two replicas cannot both try. Only a running turn
 * releases it, because a rename under a working agent would move the branch
 * it is committing to. Every failure keeps the name.
 */

/** After this many turns the branch name is part of the session. Stop trying. */
export const BRANCH_NAMING_MAX_TURNS = 3;
const GIT_TIMEOUT_MS = 30_000;

export interface BranchNamingInput {
  /** The user's message for the turn that just succeeded: the first one, unless earlier turns failed. */
  message: string;
  /** The agent's final message for that turn. */
  finalMessage: string;
  /** The agent's own PR title. When set, it is the suggestion and no model is asked. */
  suggestion?: string;
  /** The chat whose turn is still running while it names the branch: not counted as busy. */
  chatId?: string;
}

export interface BranchNamingOptions extends CheapAgentOptions {
  /** Aborted: stop before the rename starts, and keep the name. */
  signal?: AbortSignal;
  /** Called once the rename starts. From then on the attempt runs to its end. */
  onCommit?: () => void;
}

/** How long a turn that opens a PR waits for the name before it pushes the old one. */
let prNamingDeadlineMs = 60_000;

export function setPrBranchNamingDeadlineForTests(ms: number | null): void {
  prNamingDeadlineMs = ms ?? 60_000;
}

export type BranchNamingResult =
  | { outcome: 'renamed'; branch: string }
  | { outcome: 'kept'; reason: string }
  | { outcome: 'not_now'; reason: string };

/** Workbenches this process is naming now. */
const inFlight = new Set<string>();

/** Run in the background after a successful turn. Never throws, never blocks the turn loop. */
export function startBranchNaming(workbenchId: string, input: BranchNamingInput): void {
  void nameSessionBranch(workbenchId, input).catch((err) => {
    console.warn(`[workbench] branch naming for ${workbenchId} failed:`, describeError(err));
  });
}

/**
 * Name the branch before a turn pushes it for a pull request, from the PR
 * title. Waits at most the deadline; then the PR goes out under the old name.
 * A rename that has already started is waited for, so the PR always pushes
 * the name the row holds. Never throws.
 */
export async function nameBranchBeforePullRequest(
  workbenchId: string,
  input: BranchNamingInput,
  opts: CheapAgentOptions = {},
): Promise<BranchNamingResult> {
  const controller = new AbortController();
  let committed = false;
  const work = nameSessionBranch(workbenchId, input, {
    ...opts, signal: controller.signal, onCommit: () => { committed = true; },
  }).catch((err: unknown): BranchNamingResult => {
    console.warn(`[workbench] branch naming for ${workbenchId} failed:`, describeError(err));
    return { outcome: 'kept', reason: 'error' };
  });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), prNamingDeadlineMs); });
  try {
    const first = await Promise.race([work, deadline]);
    if (first) return first;
    controller.abort();
    return committed ? await work : { outcome: 'kept', reason: 'timed_out' };
  } finally {
    clearTimeout(timer);
  }
}

export async function nameSessionBranch(
  workbenchId: string,
  input: BranchNamingInput,
  opts: BranchNamingOptions = {},
): Promise<BranchNamingResult> {
  if (inFlight.has(workbenchId)) return { outcome: 'not_now', reason: 'in_flight' };
  inFlight.add(workbenchId);
  try {
    return await nameOnce(workbenchId, input, opts);
  } finally {
    inFlight.delete(workbenchId);
  }
}

async function nameOnce(workbenchId: string, input: BranchNamingInput, opts: BranchNamingOptions): Promise<BranchNamingResult> {
  if (await branchNamingDecided(workbenchId)) return { outcome: 'not_now', reason: 'decided' };
  const turns = await sessionTurnCount(workbenchId);
  if (turns <= BRANCH_NAMING_MAX_TURNS && await otherRunningChats(workbenchId, input.chatId) > 0) {
    return { outcome: 'not_now', reason: 'turn_running' };
  }
  if (!(await claimBranchNaming(workbenchId))) return { outcome: 'not_now', reason: 'decided' };
  // From here on every path is decided, except a turn that starts mid-way.
  const row = await getWorkbench(workbenchId);
  if (!row) return { outcome: 'kept', reason: 'gone' };
  const keep = (reason: string, ok = true, error?: unknown): BranchNamingResult => {
    recordWorkbenchEvent(row, 'branch_name', `kept ${row.branch} (${reason})`, ok, error);
    return { outcome: 'kept', reason };
  };
  if (turns > BRANCH_NAMING_MAX_TURNS) return keep('too_many_turns');
  const refusal = ineligible(row);
  if (refusal) return keep(refusal);
  const run = opts.run ?? runCapture;
  const [owner, repo] = row.repoFullName.split('/');
  try {
    // The agent may have pushed the branch itself. A pushed name is not ours to move.
    if (await githubService.branchExists(row.workspaceId, owner, repo, row.branch)) return keep('on_github');
  } catch (err) {
    return keep('github_error', false, err);
  }

  if (opts.signal?.aborted) return keep('timed_out');
  const probe = await run(row, probeScript(row), { quiet: true, timeoutMs: GIT_TIMEOUT_MS }).catch(() => null);
  if (!probe || probe.exitCode !== 0) return keep('probe_failed', false);
  const box = parseSections(probe.stdout);
  if ((box.BRANCH ?? '').trim() !== row.branch) return keep('branch_moved');
  if ((box.UPSTREAM ?? '').trim()) return keep('has_upstream');

  if (opts.signal?.aborted) return keep('timed_out');

  let slug: string | null;
  if (input.suggestion !== undefined) {
    slug = branchSlugFromTitle(input.suggestion);
    if (!slug) return keep('no_suggestion');
  } else {
    const answer = await askSessionAgent(row, workbenchBranchPrompt({
      firstMessage: input.message,
      changedFiles: parseNulList(box.FILES ?? ''),
      finalMessage: input.finalMessage,
    }), opts);
    slug = answer && answer.exitCode === 0 ? branchSlugFromSuggestion(answer.stdout) : null;
    if (!slug) return keep(answer ? 'no_suggestion' : 'no_answer', Boolean(answer));
  }
  const chosen = await chooseBranchTarget(row, slug);
  if ('keep' in chosen) return keep(chosen.keep, chosen.keep !== 'github_error', chosen.error);
  let allocateError: unknown;
  const allocate = () => allocateWorkbenchBranch(row.workspaceId, row.repoFullName, chosen.wanted)
    .catch((err: unknown) => { allocateError = err; return null; });
  let target = chosen.target;
  if (await otherRunningChats(workbenchId, input.chatId) > 0) {
    if (turns < BRANCH_NAMING_MAX_TURNS) {
      await releaseBranchNaming(workbenchId);
      return { outcome: 'not_now', reason: 'turn_running' };
    }
    return keep('turn_running');
  }
  if (opts.signal?.aborted) return keep('timed_out');
  opts.onCommit?.();
  if (!(await renameInBox(row, run, row.branch, target))) return keep('rename_failed', false);
  // Every path that keeps the old name puts the box back on it.
  const restore = async () => {
    if (!(await renameInBox(row, run, target, row.branch))) {
      recordWorkbenchEvent(row, 'branch_name', `could not rename ${target} back to ${row.branch}`, false);
    }
  };
  let updated: WorkbenchRow | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      updated = await renameAllocatedBranch(row.id, row.branch, target);
      break;
    } catch (err) {
      if (uniqueViolationConstraint(err) !== 'uq_workbenches_allocated_branch' || attempt > 0) {
        await restore();
        return keep('name_taken', false, err);
      }
      // Another session took the name since it was allocated: pick again, once.
      const next = await allocate();
      if (!next || !(await renameInBox(row, run, target, next))) {
        await restore();
        return keep(next ? 'rename_failed' : 'github_error', false, allocateError);
      }
      target = next;
    }
  }
  if (!updated) {
    // The row moved on (a PR linked, an archive, a branch change): put the box back.
    await restore();
    return keep('row_changed');
  }
  recordWorkbenchEvent(row, 'branch_name', `renamed ${row.branch} to ${target}`);
  await emitWorkbenchUpdated(await publicWorkbench(updated));
  return { outcome: 'renamed', branch: target };
}

/**
 * The prefixed, unique name for `slug`, or why the branch keeps its name.
 * Both runtimes decide the name here; only the rename itself differs.
 */
export async function chooseBranchTarget(
  row: Pick<WorkbenchRow, 'workspaceId' | 'repoFullName' | 'branch'>,
  slug: string,
): Promise<{ wanted: string; target: string } | { keep: string; error?: unknown }> {
  const prefix = await sessionBranchPrefix(row.workspaceId);
  const wanted = `${prefix}${slug}`;
  // `fix-login-2` already is `fix-login`: allocating again would only bump the suffix.
  if (wanted === row.branch || new RegExp(`^${escapeRegExp(wanted)}-\\d+$`).test(row.branch)) return { keep: 'same_name' };
  if (!isValidBranchName(wanted)) return { keep: 'invalid_name' };
  try {
    return { wanted, target: await allocateWorkbenchBranch(row.workspaceId, row.repoFullName, wanted) };
  } catch (error) {
    return { keep: 'github_error', error };
  }
}

/** Why this session's branch must keep its name, or null when it may move. */
export function ineligible(row: WorkbenchRow, runtime: 'sandbox' | 'local' = 'sandbox'): string | null {
  if (runtime === 'sandbox' && (row.runtime !== 'sandbox' || !row.sandboxId)) return 'not_sandbox';
  if (runtime === 'local' && row.runtime !== 'local') return 'not_local';
  if (!row.allocatedBranch) return 'chosen_branch';
  if (row.pullRequestId) return 'has_pr';
  if (row.pushedHeadShas.length > 0) return 'pushed';
  if (row.archivedAt || row.archivePendingAt) return 'archived';
  if (row.status !== 'ready') return 'not_ready';
  return null;
}

/**
 * After a `rename_branch` turn: the agent ran `git branch -m`, so the row
 * follows the branch the box now has checked out. A person asked for the
 * rename, so the name is no longer Talyn's (`allocated_branch` false). The
 * PR link is looked for again under the new name. Never throws; null when
 * nothing changed.
 */
export async function followBranchRename(row: WorkbenchRow, run: SandboxRun = runCapture): Promise<WorkbenchRow | null> {
  try {
    if (row.runtime !== 'sandbox' || !row.sandboxId) return null;
    const probe = await run(row, toShellScript([currentBranch()]), { quiet: true, timeoutMs: GIT_TIMEOUT_MS }).catch(() => null);
    const branch = probe?.exitCode === 0 ? probe.stdout.trim() : '';
    if (!branch || branch === row.branch || !isValidBranchName(branch)) return null;
    const moved = await followChosenBranch(row.id, row.branch, branch);
    if (!moved) return null;
    recordWorkbenchEvent(row, 'branch_name', `followed the rename of ${row.branch} to ${branch}`);
    const linked = await linkPullRequest(moved);
    await emitWorkbenchUpdated(await publicWorkbench(linked));
    return linked;
  } catch (err) {
    recordWorkbenchEvent(row, 'branch_name', `could not follow the rename of ${row.branch}`, false, err);
    return null;
  }
}

/** The box's current branch, its upstream, and the paths changed against the base. */
function probeScript(row: WorkbenchRow): string {
  return [
    'set -o pipefail',
    mergeBaseLine(row),
    sectionsScript([
      { label: 'BRANCH', command: 'git rev-parse --abbrev-ref HEAD' },
      // Fails when there is no upstream, which leaves the section empty.
      { label: 'UPSTREAM', command: `git rev-parse --abbrev-ref --symbolic-full-name '@{u}'` },
      {
        label: 'FILES',
        command: `{ git diff --name-only -z "$mb" -- ; git ls-files --others --exclude-standard -z ; } | { head -z -n ${WORKBENCH_BRANCH_PROMPT_FILES_MAX + 1}; cat >/dev/null; }`,
      },
    ]),
    'exit 0',
  ].join('\n');
}

async function renameInBox(row: WorkbenchRow, run: SandboxRun, from: string, to: string): Promise<boolean> {
  const result = await run(row, toShellScript([renameBranch(to, from)]), { quiet: true, timeoutMs: GIT_TIMEOUT_MS }).catch(() => null);
  return result?.exitCode === 0;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
