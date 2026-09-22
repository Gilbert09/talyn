export const REVIEW_SORT_MODE_KEY = 'talyn-reviews-sort-mode-v2';

/** Start this rollout in Priority mode. Later choices remain personal. */
export function loadReviewSortMode(storage: Pick<Storage, 'getItem'>): 'priority' | 'newest' | 'oldest' {
  try {
    const value = storage.getItem(REVIEW_SORT_MODE_KEY);
    if (value === 'newest' || value === 'oldest') return value;
  } catch {
    // Priority also works without browser storage.
  }
  return 'priority';
}
