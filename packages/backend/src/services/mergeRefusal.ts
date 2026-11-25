import type { PRSummary } from './githubGraphql.js';

/**
 * Why GitHub refused a merge, as a code the clients act on and a message a
 * person can act on. GitHub's own text ("GitHub API error 409 Conflict: Head
 * branch is out of date. Review and try the merge again. (GitHub request-id:
 * …)") names neither the base branch nor the fix.
 */
export type MergeRefusalCode =
  /** The repository requires an up-to-date branch. The fix is "Update branch". */
  | 'branch_behind'
  /** New commits arrived on the head after the person looked at the PR. */
  | 'head_changed'
  /** The base moved during the merge. A second try usually works. */
  | 'base_changed'
  /** Conflicts, failing required checks or a missing review. */
  | 'not_mergeable'
  | 'merge_refused';

export interface MergeRefusal {
  code: MergeRefusalCode;
  message: string;
}

/** GitHub's own words, without the status-line prefix and the request id. */
export function githubMergeWords(raw: string): string {
  return (
    raw
      .replace(/^GitHub API error \d+[^:]*:\s*/i, '')
      .replace(/\s*\(GitHub request-id: [^)]*\)\s*$/i, '')
      .trim() || raw.trim()
  );
}

export function describeMergeRefusal(
  raw: string,
  pr: { number: number; baseBranch?: string | null }
): MergeRefusal {
  const words = githubMergeWords(raw);
  const ref = `#${pr.number}`;
  const base = pr.baseBranch || 'the base branch';
  if (/head branch is out of date|branch is not up to date|must be up to date/i.test(words)) {
    return {
      code: 'branch_behind',
      message:
        `${ref} is behind ${base}. This repository merges only up-to-date branches. ` +
        'Update the branch, then merge again when its checks pass.',
    };
  }
  if (/head branch was modified/i.test(words)) {
    return {
      code: 'head_changed',
      message: `${ref} got new commits after you looked at it. Check the new commits, then merge again.`,
    };
  }
  if (/base branch was modified/i.test(words)) {
    return {
      code: 'base_changed',
      message: `${base} changed during the merge. Merge ${ref} again.`,
    };
  }
  if (/not mergeable|merge conflict/i.test(words)) {
    return {
      code: 'not_mergeable',
      message:
        `GitHub cannot merge ${ref} now. It can have merge conflicts, failing required checks ` +
        'or a missing review. Talyn refreshed its status.',
    };
  }
  return { code: 'merge_refused', message: words };
}

/**
 * The refused merge is the newest fact about the PR. GitHub computes
 * `mergeStateStatus` in the background, so a refetch right after the refusal
 * can still say CLEAN — and the row would go back to "Ready" with a Merge
 * button that fails again. Only a summary that says the PR is ready changes.
 */
export function markSummaryBehind(summary: PRSummary): PRSummary {
  if (
    summary.blockingReason !== 'mergeable' &&
    summary.blockingReason !== 'checks_failed_optional' &&
    summary.blockingReason !== 'unknown'
  ) {
    return summary;
  }
  return { ...summary, mergeStateStatus: 'BEHIND', blockingReason: 'behind' };
}
