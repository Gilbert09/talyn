import { debugBus } from '../debugBus.js';
import { fetchWithTimeout } from '../httpTimeout.js';

/**
 * Trunk's public API — one call, `getSubmittedPullRequest`.
 *
 * The token goes in the `x-api-token` header and nowhere else. `recordHttp`
 * records the method, the query-stripped URL and the status, so the token never
 * reaches the Debug panel, and no error message here quotes it.
 */

export const TRUNK_API_BASE = 'https://api.trunk.io/v1';

/**
 * Short on purpose. The merge-eta route waits on this inside a request, and an
 * ETA that is late is worth nothing, so a slow Trunk reads as "unavailable".
 */
const TRUNK_TIMEOUT_MS = 8_000;

/** Trunk refused the token (401 or 403). */
export class TrunkAuthError extends Error {
  constructor(readonly status: number) {
    super(`Trunk refused the API token (HTTP ${status})`);
    this.name = 'TrunkAuthError';
  }
}

/** Trunk has no submitted PR by that number on that branch (404). */
export class TrunkNotFoundError extends Error {
  constructor() {
    super('Trunk has no submission for this pull request');
    this.name = 'TrunkNotFoundError';
  }
}

/** Any other failure: a timeout, a 5xx, a 400, a body that is not JSON. */
export class TrunkRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TrunkRequestError';
  }
}

export interface TrunkPullRequestRef {
  owner: string;
  repo: string;
  number: number;
  /** The queue's target branch — the branch the PR lands on. */
  targetBranch: string;
}

/** The request body. Exported so a test can pin its shape. */
export function getSubmittedPullRequestBody(ref: TrunkPullRequestRef): Record<string, unknown> {
  return {
    repo: { host: 'github.com', owner: ref.owner, name: ref.repo },
    pr: { number: ref.number },
    targetBranch: ref.targetBranch,
    includeEstimatedTimeToMerge: true,
  };
}

/** Ask Trunk about one PR. Resolves to the raw JSON; parse it with `parse.ts`. */
export async function getSubmittedPullRequest(
  token: string,
  ref: TrunkPullRequestRef,
  opts: { workspaceId?: string } = {}
): Promise<unknown> {
  const url = `${TRUNK_API_BASE}/getSubmittedPullRequest`;
  const startedAt = Date.now();
  let res;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-token': token },
        body: JSON.stringify(getSubmittedPullRequestBody(ref)),
      },
      { timeoutMs: TRUNK_TIMEOUT_MS, label: 'Trunk' }
    );
  } catch (err) {
    debugBus.recordHttp({
      service: 'trunk',
      method: 'POST',
      url,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: err,
      workspaceId: opts.workspaceId,
    });
    throw new TrunkRequestError(err instanceof Error ? err.message : String(err));
  }

  debugBus.recordHttp({
    service: 'trunk',
    method: 'POST',
    url,
    status: res.status,
    durationMs: Date.now() - startedAt,
    ok: res.ok,
    bytes: res.bodyText.length,
    ...(res.ok ? {} : { error: `Trunk answered ${res.status}` }),
    workspaceId: opts.workspaceId,
  });

  if (res.status === 401 || res.status === 403) throw new TrunkAuthError(res.status);
  if (res.status === 404) throw new TrunkNotFoundError();
  if (!res.ok) throw new TrunkRequestError(`Trunk answered ${res.status}`, res.status);
  try {
    return JSON.parse(res.bodyText) as unknown;
  } catch {
    throw new TrunkRequestError('Trunk answered with a body that is not JSON', res.status);
  }
}
