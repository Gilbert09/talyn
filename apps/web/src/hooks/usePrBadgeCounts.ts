import { useMemo } from 'react';
import { usePullRequestStore } from '../stores/pullRequests';
import { useWorkspaceStore } from '../stores/workspace';
import { visibleReviewCohort } from '../components/panels/github/reviewHidden';
import type { PrTab } from '../lib/prTabs';

export type PrBadgeCounts = Record<PrTab, number>;

/**
 * The counts behind the Pull requests badges, from the live PR store (kept
 * current by usePullRequestSync). Each count uses its page's own rule, so a
 * badge never counts a PR its page has dropped.
 */
export function usePrBadgeCounts(): PrBadgeCounts {
  const rows = usePullRequestStore((s) => s.rows);
  const tasks = useWorkspaceStore((s) => s.tasks);
  return useMemo(() => {
    // My PRs holds `authored || watching`: a manually tracked PR renders there.
    const my_prs = rows.filter((r) => r.authored || r.watching).length;
    const reviews = visibleReviewCohort(rows).length;
    // Reviews with findings nobody has dealt with yet.
    const code_reviews = rows.filter((r) => (r.codeReview?.openCount ?? 0) > 0).length;
    const merge_queue = rows.filter((r) => r.mergeQueued).length;
    const queue = tasks.filter((t) => t.status === 'in_progress').length;
    return { my_prs, reviews, code_reviews, merge_queue, queue };
  }, [rows, tasks]);
}
