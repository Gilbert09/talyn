import { api } from './api';
import { trackEvent } from './analytics';
import { toast } from '../stores/toast';

/**
 * A refused merge, told to the person with the fix one click away. The backend
 * already rewrote GitHub's text and refetched the PR, so the row shows the new
 * status (for example "Behind") at the same time as this toast.
 */

/** The backend's code for "the repository merges only up-to-date branches". */
export const BRANCH_BEHIND = 'branch_behind';

/** The backend's refusal code on an `ApiError`, read by shape. */
export function mergeRefusalCode(err: unknown): string | undefined {
  const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code ? code : undefined;
}

/** Clean text for any merge error: no GitHub status line, no request id. */
export function mergeErrorText(err: unknown, fallback = 'Merge failed'): string {
  const message = err instanceof Error ? err.message : fallback;
  return (
    message
      .replace(/^GitHub API error \d+[^:]*:\s*/i, '')
      .replace(/\s*\(GitHub request-id: [^)]*\)\s*$/i, '')
      .trim() || fallback
  );
}

/** Merge the base into the PR's head on GitHub, and say what happened. */
export async function updatePullRequestBranch(pr: { id: string; number: number }): Promise<boolean> {
  try {
    const res = await api.pullRequests.updateBranch(pr.id);
    trackEvent('pr_branch_updated', { pr_number: pr.number, updated: res.updated });
    toast.success(res.updated ? `Updated #${pr.number}` : `#${pr.number} is up to date`, res.message);
    return true;
  } catch (err) {
    toast.error(`Could not update #${pr.number}`, mergeErrorText(err, 'Update failed'));
    return false;
  }
}

/**
 * The toast for a refused merge. A PR that is behind its base gets an
 * "Update branch" button; every other refusal gets the backend's text.
 */
export function showMergeRefusal(title: string, pr: { id: string; number: number }, err: unknown): void {
  const text = mergeErrorText(err);
  if (mergeRefusalCode(err) === BRANCH_BEHIND) {
    toast.error(title, text, {
      label: 'Update branch',
      onClick: () => void updatePullRequestBranch(pr),
    });
    return;
  }
  toast.error(title, text);
}
