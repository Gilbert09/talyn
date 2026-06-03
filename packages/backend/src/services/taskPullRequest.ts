import { patchTaskMetadata } from './taskMetadataMutex.js';

/**
 * Open a GitHub PR for a task's branch.
 *
 * DORMANT in cloud-only mode: the live cloud provider (PostHog Code) opens
 * its own PR, so nothing calls this in the happy path — the poller just
 * links the PR the provider created. It's kept as the seam for a future
 * provider that produces a branch but no PR; when that lands, reimplement
 * this on top of the GitHub API (githubService / githubGraphql) to open a
 * PR from the provider-reported branch.
 *
 * Until then it records a clear error on the task metadata so the
 * `/retry-pr` endpoint returns something meaningful instead of throwing.
 */
export async function openPullRequestForTask(taskId: string): Promise<void> {
  await patchTaskMetadata(taskId, (existing) => ({
    ...existing,
    pullRequestError:
      'Opening a PR from FastOwl is not available — the cloud provider opens its own PR.',
  }));
}
