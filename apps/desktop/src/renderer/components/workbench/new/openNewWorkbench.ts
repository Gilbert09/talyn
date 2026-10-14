import type { PRRow } from '../../../lib/api';
import { useNavigationStore } from '../../../stores/navigation';
import { useWorkbenchStore, type NewWorkbenchPrefill } from '../../../stores/workbenches';

/**
 * Show the new-workbench page (Home), optionally aimed at a repository, a
 * branch or a pull request. Every "New workbench" entry point comes here:
 * ⌘N, the sidebar, the palette, a PR row.
 */
export function openNewWorkbench(prefill: NewWorkbenchPrefill | null = null): void {
  useNavigationStore.getState().navigate({ view: 'home' });
  useWorkbenchStore.getState().requestNewWorkbench(prefill);
}

/** The prefill for "open this PR in a workbench": its repository, its branches, the link. */
export function prefillFromPr(row: Pick<PRRow, 'id' | 'repositoryId' | 'summary'>): NewWorkbenchPrefill {
  return {
    repositoryId: row.repositoryId,
    fromPullRequestId: row.id,
    baseBranch: row.summary.baseBranch,
    branch: row.summary.headBranch,
  };
}
