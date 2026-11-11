import type { PrTab } from '../stores/navigation';

export const PR_TAB_LABEL: Record<PrTab, string> = {
  my_prs: 'PRs',
  // "Review requests", not "Reviews": PRs waiting on YOU, as against Talyn's own code review.
  reviews: 'Review requests',
  code_reviews: 'Code review',
  merge_queue: 'Merge queue',
  queue: 'Tasks',
};

/**
 * The tabs of the Pull requests page. Review requests and Merge queue are
 * their own sidebar items and pages, with no tab strip.
 */
export const PR_PAGE_TABS: readonly PrTab[] = ['my_prs', 'code_reviews', 'queue'];
