// Shared "take this PR to a clean, mergeable state" helpers.
//
// Used in two places that must stay in lock-step:
//   - the desktop "Get PR mergeable" button (one-shot, manual)
//   - the backend auto-keep-mergeable watcher (repeated, unattended)
// so the watcher fires the *identical* cloud task the button does.

export type PRBlockingReason =
  | 'mergeable'
  | 'merge_conflicts'
  | 'changes_requested'
  | 'checks_failed'
  | 'checks_failed_optional'
  | 'blocked'
  | 'unknown';

export type PRMergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

export type PRReviewDecisionState =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'REVIEW_REQUIRED'
  | null;

/**
 * The subset of a PR's cached summary the mergeable helpers read. Both the
 * desktop `PRSummaryShape` and the backend `PRSummary` are structural
 * supersets of this, so either can be passed directly.
 */
export interface PRMergeableSummary {
  url: string;
  headBranch: string;
  baseBranch: string;
  mergeable: PRMergeableState;
  reviewDecision: PRReviewDecisionState;
  blockingReason: PRBlockingReason;
  checks: { total: number; failed: number };
  unresolvedReviewThreads?: number;
}

/**
 * A PR has something a cloud follow-up run could fix: merge conflicts,
 * requested changes, failing required CI, or unresolved review threads.
 * Drives both the "Get PR mergeable" button's enabled state and the
 * watcher's decision to fire a run.
 */
export function prNeedsFollowup(s: PRMergeableSummary): boolean {
  return (
    s.blockingReason === 'merge_conflicts' ||
    s.blockingReason === 'changes_requested' ||
    s.blockingReason === 'checks_failed' ||
    s.mergeable === 'CONFLICTING' ||
    s.reviewDecision === 'CHANGES_REQUESTED' ||
    (s.unresolvedReviewThreads ?? 0) > 0 ||
    // Failing checks count — but not when they're all non-required, since
    // those don't block the merge and there's nothing to "fix".
    (s.checks.failed > 0 && s.blockingReason !== 'checks_failed_optional')
  );
}

/**
 * A short, human one-liner for *why* a PR can't merge — for blocked-state
 * notifications and badge tooltips. Most-specific blocker first.
 *
 * Note: it does NOT cover "behind the base branch" (that lives on
 * `mergeStateStatus`, which isn't part of this summary subset). Callers that
 * track it — e.g. the merge queue — should special-case that reason before
 * falling back here.
 */
export function mergeBlockerReason(s: PRMergeableSummary): string {
  if (s.blockingReason === 'merge_conflicts' || s.mergeable === 'CONFLICTING') {
    return 'merge conflicts with the base branch';
  }
  if (s.reviewDecision === 'CHANGES_REQUESTED' || s.blockingReason === 'changes_requested') {
    return 'a reviewer requested changes';
  }
  if ((s.unresolvedReviewThreads ?? 0) > 0) {
    return 'unresolved review threads';
  }
  if (s.checks.failed > 0 && s.blockingReason !== 'checks_failed_optional') {
    return 'failing CI checks';
  }
  return 'needs attention';
}

/** Bulleted list of the issues we detected, for the agent prompt. */
export function buildIssuesSummary(s: PRMergeableSummary): string {
  const lines: string[] = [];
  if (s.blockingReason === 'merge_conflicts' || s.mergeable === 'CONFLICTING') {
    lines.push('- Merge conflicts with the base branch');
  }
  if ((s.unresolvedReviewThreads ?? 0) > 0) {
    lines.push(`- Unresolved review threads: ${s.unresolvedReviewThreads}`);
  }
  if (s.reviewDecision === 'CHANGES_REQUESTED') {
    lines.push('- A reviewer has requested changes');
  }
  if (s.checks.failed > 0) {
    const optional = s.blockingReason === 'checks_failed_optional';
    lines.push(
      `- Failing CI checks: ${s.checks.failed}/${s.checks.total}` +
        (optional ? ' (none required — not blocking the merge)' : '')
    );
  }
  return lines.length > 0
    ? lines.join('\n')
    : '- (Re-fetch the PR to confirm the current issues.)';
}

/**
 * The "take this PR to a clean, mergeable state" prompt handed to a cloud
 * run: resolve every reviewer comment, get CI green, and resolve conflicts,
 * looping until all three hold on the latest commit.
 */
export function buildPostHogPrompt(input: {
  owner: string;
  repo: string;
  number: number;
  summary: PRMergeableSummary;
}): string {
  const { owner, repo, number, summary: s } = input;
  const ref = `${owner}/${repo}#${number}`;
  return `You are taking a pull request to a fully clean, mergeable state.

Pull request: ${s.url}
Repository: ${owner}/${repo}
PR number: #${number}
Branch: ${s.headBranch}

NON-NEGOTIABLE GIT RULES — read these first, they apply to EVERYTHING below:
  - NEVER force-push. Not \`git push --force\`, not \`--force-with-lease\`, not \`push -f\`. Every single push in this task is a plain \`git push\`. There is no scenario in this task that legitimately needs a force-push.
  - NEVER rewrite this branch's history: no rebase, no reset, no cherry-pick, no squash, no commit --amend, no filter-branch. Your work only ever ADDS new commits on top of the current branch tip.
  - To incorporate changes from the base branch (${s.baseBranch}), MERGE it in — never rebase onto it. A merge appends a merge commit on top of your branch, so a normal \`git push\` always fast-forwards the remote and a force-push is never required.
  - If a \`git push\` is ever rejected as non-fast-forward (i.e. it would need a force), STOP. Do not reach for \`--force\`. It means history got rewritten or you're on the wrong branch — undo that with a fresh commit/merge and push normally instead.

Current issues detected (verify by re-fetching — state may have changed since this task was created):
${buildIssuesSummary(s)}

Your job is to keep iterating on this PR until ALL of the following are true and stay true:

1. Every reviewer comment is resolved.
   - For each unresolved review comment / review thread on the PR (top-level review comments AND inline code review threads):
     a. Read the comment carefully and understand what the reviewer is asking for.
     b. If the feedback is correct or reasonable: implement the requested change in code, push the fix, then mark the thread as resolved.
     c. If you disagree with the feedback: reply to the thread on GitHub explaining your reasoning clearly and respectfully, then mark the thread as resolved.
     d. Do NOT silently ignore a comment. Every thread must end either with a code change you pushed, or with a reply from you, and in both cases the thread must be marked resolved.
   - Re-fetch review comments after pushing changes — reviewers may have left new feedback while you were working.

2. CI is fully green on the latest commit of the PR branch.
   - Inspect the check runs / status checks via \`gh pr checks\` (or the GitHub API).
   - If any required check is failing, investigate the failure (logs, test output) and fix the underlying problem in code. Push the fix.
   - Flaky tests: re-run them once to confirm they're actually flaky; if they are, document it briefly in a PR comment, but otherwise still try to fix the root cause rather than ignoring it.
   - Do not bypass checks (no --no-verify, no skipping required checks). Fix the real issue.

3. The branch merges cleanly into its base branch (no merge conflicts).
   - Check mergeability via \`gh pr view ${number} --json mergeable,mergeStateStatus\`.
   - If the branch is CONFLICTING / DIRTY, update it by MERGING the base branch IN (per the git rules above — never rebase):
       git fetch origin ${s.baseBranch}
       git merge origin/${s.baseBranch}
     Then resolve each conflict by hand and commit the merge. Only ever merge in the PR's own base branch (\`origin/${s.baseBranch}\`) — never any other branch. Rebasing would rewrite history (forcing a force-push) and drag unrelated/duplicate commits into the PR — that's exactly why it's forbidden.
   - Resolve ONLY the genuine conflicts. Preserve the intent of both sides; never blindly discard the PR's changes or the base's. The update must add nothing beyond (a) one merge commit and (b) your conflict resolutions — no unrelated files, commits, or edits.
   - GUARD AGAINST BASE-BRANCH FILES LEAKING INTO THE PR. This is a real, recurring failure: a botched merge resolution drags files that only changed on ${s.baseBranch} into the PR's diff. Catch it explicitly:
       a. BEFORE merging, record the exact set of files this PR owns:
            git diff --name-only origin/${s.baseBranch}...HEAD   # save this "before" list
       b. AFTER merging and resolving every conflict, record it again:
            git diff --name-only origin/${s.baseBranch}...HEAD   # the "after" list
       c. The two lists MUST be identical. A clean base-merge adds NOTHING to the PR's own diff — files that already live on ${s.baseBranch} must never appear as PR changes. Any file in "after" that wasn't in "before" is a leak (usually a conflict resolved by re-adding base-only content, or a file deleted on one side wrongly kept).
       d. For every file still in the diff, eyeball it: \`git diff origin/${s.baseBranch}...HEAD -- <file>\`. Each hunk must be either this PR's intended work or a genuine conflict resolution. A hunk that just restates what's already on ${s.baseBranch} is a leak.
   - If you find ANY leaked file or hunk, do not push. Abort the in-progress merge with \`git merge --abort\` and redo it cleanly, taking the base side for files this PR never meant to touch (this is a local, not-yet-pushed operation — never a force-push to the remote).
   - Do not push until the "before" and "after" file sets match and every remaining hunk is intentional. Then re-run the build/tests locally where feasible and push with a plain \`git push\` (never \`--force\` — the merge commit means a normal push fast-forwards). Resolving conflicts can re-trigger CI and reopen review threads, so re-check conditions (1) and (2) afterwards.

Loop discipline:
  - After every push, wait for CI to finish, then re-check all of: (1) review comments, (2) check status, and (3) mergeability.
  - Do not stop, do not declare victory, and do not hand control back until ALL conditions are simultaneously true on the latest commit.
  - If you genuinely get stuck (e.g. you need credentials you don't have, or a reviewer's request is impossible without product-level decisions), leave a clear PR comment describing exactly what you need and why, then stop. Otherwise keep going.

Start by checking out the PR branch (${ref}), fetching the current state of review threads and CI, and then work the loop until done.`;
}
