import type { PRRow } from '../../../lib/api';

/**
 * The Reviews tab's hidden-PR rule, in one place because three callers have to
 * agree about it: the page's cohort, the page's hidden list, and the sidebar
 * badge. A badge that counts a PR the list does not show is the nag the user
 * was dismissing, so these must not drift apart.
 *
 * Hiding is a view decision and nothing else. The PR stays review-requested on
 * GitHub and in the row — it is simply not in the list, the count, the Priority
 * scoring or the saved-filter previews, all of which derive from `cohort`.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */
export function isHiddenReview(row: Pick<PRRow, 'reviewHiddenAt'>): boolean {
  return Boolean(row.reviewHiddenAt);
}

/** Review-requested PRs the user has not hidden — what the page lists. */
export function visibleReviewCohort(rows: PRRow[]): PRRow[] {
  return rows.filter((r) => r.reviewRequested && !isHiddenReview(r));
}

/**
 * The hidden ones, most recently hidden first.
 *
 * Still review-requested: a PR that was hidden and has since left the cohort
 * (reviewed elsewhere, or the request withdrawn) is nobody's business any more,
 * and listing it would turn this into an archive of everything ever skipped.
 */
export function hiddenReviewCohort(rows: PRRow[]): PRRow[] {
  return rows
    .filter((r) => r.reviewRequested && isHiddenReview(r))
    .sort((a, b) => (b.reviewHiddenAt ?? '').localeCompare(a.reviewHiddenAt ?? ''));
}
