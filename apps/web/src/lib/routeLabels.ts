import type { PrTab } from '../stores/navigation';

export const PR_TAB_LABEL: Record<PrTab, string> = {
  my_prs: 'PRs',
  reviews: 'Review requests',
  code_reviews: 'Code review',
  merge_queue: 'Merge queue',
  queue: 'Tasks',
};

export const PR_PAGE_TABS: readonly PrTab[] = ['my_prs', 'code_reviews', 'queue'];
