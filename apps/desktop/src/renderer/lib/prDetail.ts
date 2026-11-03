import type { Workbench } from '@talyn/shared';
import { usePullRequestStore } from '../stores/pullRequests';

/**
 * The Talyn pull request id behind "PR #number" in a session, or null when the
 * session cannot say. A session knows its own PR by id; any other number is
 * looked up in the loaded rows by repository and number.
 */
export function prDetailIdFor(workbench: Workbench | null | undefined, number: number): string | null {
  if (!workbench) return null;
  if (workbench.pullRequestId && (!workbench.pr || workbench.pr.number === number)) return workbench.pullRequestId;
  const row = usePullRequestStore
    .getState()
    .rows.find((r) => r.number === number && r.repo === workbench.repoFullName);
  return row?.id ?? null;
}
