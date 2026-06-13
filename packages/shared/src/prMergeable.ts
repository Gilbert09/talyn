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
    // 'checks_failed' already means a *required* check is red (the backend
    // resolves required-ness authoritatively, falling back to a heuristic).
    // We deliberately don't fire on raw `checks.failed > 0`: a non-required
    // failing check (e.g. on a PR otherwise only waiting on a review) is not
    // something a cloud follow-up can or should "fix".
    s.blockingReason === 'checks_failed' ||
    s.mergeable === 'CONFLICTING' ||
    s.reviewDecision === 'CHANGES_REQUESTED' ||
    (s.unresolvedReviewThreads ?? 0) > 0
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
  if (s.blockingReason === 'checks_failed') {
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
  - This environment publishes through SIGNED GIT TOOLS. Raw \`git commit\`, \`git push\`, and any force-push are blocked. Changes reach the remote ONLY through:
      - \`git_signed_commit\` — publishes your staged changes (\`git add\` first) as a new commit on the PR branch. Use this for all ordinary work: review fixes, CI fixes, etc.
      - \`git_signed_merge\` — brings the base branch (${s.baseBranch}) into the PR branch SERVER-SIDE, as a true two-parent Verified merge commit (the same machinery as GitHub's "Update branch" button). No local merge, no history rewriting.
      - \`git_signed_rewrite\` — republishes the branch after a LOCAL rebase. This is the only sanctioned force-update, and the rebase-for-conflicts flow below is its only sanctioned use here.
  - To incorporate changes from ${s.baseBranch}, ALWAYS call \`git_signed_merge\` first. NEVER run a local \`git merge origin/${s.baseBranch}\` and then \`git_signed_commit\`: the commit tool refuses while a merge is in progress, because publishing through it would LINEARIZE the merge into a single-parent commit — the base never becomes an ancestor, so the PR diff attributes EVERY file the base changed to your branch (hundreds of unrelated files leaking into the PR). This has actually happened.
  - Rebase is ONLY for conflicts, and only after \`git_signed_merge\` has reported one: \`git fetch origin ${s.baseBranch}\`, \`git rebase origin/${s.baseBranch}\`, resolve each conflict, \`git add\` the resolutions, \`git rebase --continue\` (NOT \`git commit\`), then publish with \`git_signed_rewrite\`. Never rebase for any other reason, and never try to publish a rebase any other way.
  - NEVER bring the base's changes in as a single-parent imitation of a merge: no \`git merge --squash\`, \`git read-tree\`, \`git checkout ${s.baseBranch} -- .\`, \`git diff base | git apply\`, etc. The base must become an ANCESTOR of your branch — via \`git_signed_merge\`'s two-parent merge commit, or via a rebase ONTO it. Naming a single-parent commit "Merge branch '${s.baseBranch}'" does not make it a merge.
  - A signed git tool's REFUSAL is authoritative ("merge in progress", "base leak", merge commits in a rewrite range, …). Read its error and follow the recovery path it describes — do not retry the same call and do not work around it. If you're stuck mid-operation, \`git merge --abort\` / \`git rebase --abort\` returns you to a clean state to start over from.

Current issues detected (verify by re-fetching — state may have changed since this task was created):
${buildIssuesSummary(s)}

Your job is to keep iterating on this PR until ALL of the following are true and stay true:

1. Every reviewer comment is resolved.
   - For each unresolved review comment / review thread on the PR (top-level review comments AND inline code review threads):
     a. Read the comment carefully and understand what the reviewer is asking for.
     b. If the feedback is correct or reasonable: implement the requested change in code, stage it with \`git add\` and publish it with \`git_signed_commit\`, then mark the thread as resolved.
     c. If you disagree with the feedback: reply to the thread on GitHub explaining your reasoning clearly and respectfully, then mark the thread as resolved.
     d. Do NOT silently ignore a comment. Every thread must end either with a code change you published, or with a reply from you, and in both cases the thread must be marked resolved.
   - Re-fetch review comments after publishing changes — reviewers may have left new feedback while you were working.

2. CI is fully green on the latest commit of the PR branch.
   - Inspect the check runs / status checks via \`gh pr checks\` (or the GitHub API).
   - If any required check is failing, investigate the failure (logs, test output) and fix the underlying problem in code. Publish the fix (\`git add\` + \`git_signed_commit\`).
   - Flaky tests: re-run them once to confirm they're actually flaky; if they are, document it briefly in a PR comment, but otherwise still try to fix the root cause rather than ignoring it.
   - Do not bypass checks (no --no-verify, no skipping required checks). Fix the real issue.

3. The branch merges cleanly into its base branch (no merge conflicts, not behind).
   - Check mergeability via \`gh pr view ${number} --json mergeable,mergeStateStatus\`.
   - BEFORE updating anything, record the exact set of files this PR owns:
       git fetch origin ${s.baseBranch}
       git diff --name-only origin/${s.baseBranch}...HEAD   # save this "before" list
   - If the branch is BEHIND or CONFLICTING / DIRTY, first call \`git_signed_merge\` (per the git rules above). If it succeeds, the base is now merged in server-side as a true two-parent merge commit and your local checkout is synced — skip to the verification step.
   - ONLY if \`git_signed_merge\` reports a CONFLICT, resolve it with the rebase flow:
       git fetch origin ${s.baseBranch}
       git rebase origin/${s.baseBranch}
     For each conflicted file, resolve ONLY the genuine conflict: preserve the intent of BOTH sides; never blindly discard the PR's changes or the base's. Then \`git add\` the resolutions and \`git rebase --continue\` (NOT \`git commit\`), repeating until the rebase completes. Publish the rebased branch with \`git_signed_rewrite\`. Only ever rebase onto the PR's own base branch (\`origin/${s.baseBranch}\`) — never any other branch. If the rebase goes sideways, \`git rebase --abort\` and start it over — never leave it half-finished, and never try to publish it with \`git_signed_commit\`.
   - VERIFY THE UPDATE ACTUALLY JOINED THE BASE, whichever path ran (this is the #1 cause of mass file leaks — the base never truly becomes an ancestor). Both of these must hold:
       git fetch origin ${s.baseBranch}
       git merge-base --is-ancestor origin/${s.baseBranch} HEAD   # must exit 0 — the base tip is now an ancestor of your branch
       git rev-list --count HEAD..origin/${s.baseBranch}          # must print 0 — your branch is NOT behind the base anymore
     If either fails, the update did not take — re-read the tool output (a refusal explains its recovery path) and redo the update; do not proceed.
   - GUARD AGAINST BASE-BRANCH FILES LEAKING INTO THE PR. This is a real, recurring failure: a botched conflict resolution drags files that only changed on ${s.baseBranch} into the PR's diff. Catch it explicitly:
       a. AFTER the update (signed merge or completed rebase), record the file set again:
            git diff --name-only origin/${s.baseBranch}...HEAD   # the "after" list
       b. Compare with the "before" list you saved. The two MUST be identical. A clean base update adds NOTHING to the PR's own diff — files that already live on ${s.baseBranch} must never appear as PR changes. Any file in "after" that wasn't in "before" is a leak (usually a conflict resolved by re-adding base-only content, or a file deleted on one side wrongly kept).
       c. For every file still in the diff, eyeball it: \`git diff origin/${s.baseBranch}...HEAD -- <file>\`. Each hunk must be either this PR's intended work or a genuine conflict resolution. A hunk that just restates what's already on ${s.baseBranch} is a leak.
   - If you find ANY leaked file or hunk after a rebase, do not publish. \`git rebase --abort\` (or restart from the remote branch state — the remote is untouched until \`git_signed_rewrite\`) and redo the rebase, taking the base side for files this PR never meant to touch.
   - Do not publish until the "before" and "after" file sets match and every remaining hunk is intentional. Then re-run the build/tests locally where feasible and publish (\`git_signed_rewrite\` for a rebase; a server-side \`git_signed_merge\` needs no publish step). Updating the branch re-triggers CI and can reopen review threads, so re-check conditions (1) and (2) afterwards.

Loop discipline:
  - After every publish, wait for CI to finish, then re-check all of: (1) review comments, (2) check status, and (3) mergeability.
  - Do not stop, do not declare victory, and do not hand control back until ALL conditions are simultaneously true on the latest commit.
  - If you genuinely get stuck (e.g. you need credentials you don't have, or a reviewer's request is impossible without product-level decisions), leave a clear PR comment describing exactly what you need and why, then stop. Otherwise keep going.

Start by checking out the PR branch (${ref}), fetching the current state of review threads and CI, and then work the loop until done.`;
}
