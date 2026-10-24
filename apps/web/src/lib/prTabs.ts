/**
 * The Pull requests page's tabs. Kept outside the navigation store so a hook
 * can use the type before that store exists; `stores/navigation.ts` re-exports it.
 */
export type PrTab = 'my_prs' | 'reviews' | 'code_reviews' | 'merge_queue' | 'queue';

export const PR_TABS: readonly PrTab[] = ['my_prs', 'reviews', 'code_reviews', 'merge_queue', 'queue'];
