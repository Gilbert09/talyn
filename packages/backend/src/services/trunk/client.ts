import { debugBus } from '../debugBus.js';
import { fetchWithTimeout } from '../httpTimeout.js';

/**
 * Trunk's v2 API: the three reads behind a merge ETA.
 *
 * The key goes in the `Authorization` header and nowhere else. `recordHttp`
 * records the method, the query-stripped URL and the status, so the key never
 * reaches the Debug panel, and no error message here quotes it.
 */

export const TRUNK_API_BASE = 'https://api.trunk.io';

/**
 * Short on purpose. The merge-eta route waits on these inside a request, and an
 * ETA that is late is worth nothing, so a slow Trunk reads as "unavailable".
 */
const TRUNK_TIMEOUT_MS = 8_000;

/** Trunk refused the key (401 or 403). */
export class TrunkAuthError extends Error {
  constructor(readonly status: number) {
    super(`Trunk refused the API key (HTTP ${status}).`);
    this.name = 'TrunkAuthError';
  }
}

/**
 * 404. Trunk answers a read it will not authorize with a 404 too, so this
 * cannot tell "no such thing" from "not this organization's".
 */
export class TrunkNotFoundError extends Error {
  constructor(readonly code: string | null) {
    super(`Trunk found nothing${code ? ` (${code})` : ''}`);
    this.name = 'TrunkNotFoundError';
  }
}

/** Any other failure: a timeout, a 409, a 429, a 5xx, a body that is not JSON. */
export class TrunkRequestError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string | null) {
    super(message);
    this.name = 'TrunkRequestError';
  }
}

// Trunk's edge can answer without the `{ error: { code } }` envelope.
function errorCode(bodyText: string): string | null {
  try {
    const code = (JSON.parse(bodyText) as { error?: { code?: unknown } })?.error?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

async function trunkGet(
  apiKey: string,
  path: string,
  query: Record<string, string>,
  opts: { workspaceId?: string }
): Promise<unknown> {
  const qs = new URLSearchParams(query).toString();
  const url = `${TRUNK_API_BASE}${path}${qs ? `?${qs}` : ''}`;
  const startedAt = Date.now();
  let res;
  try {
    res = await fetchWithTimeout(
      url,
      { method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` } },
      { timeoutMs: TRUNK_TIMEOUT_MS, label: 'Trunk' }
    );
  } catch (err) {
    debugBus.recordHttp({
      service: 'trunk',
      method: 'GET',
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
    method: 'GET',
    url,
    status: res.status,
    durationMs: Date.now() - startedAt,
    ok: res.ok,
    bytes: res.bodyText.length,
    ...(res.ok ? {} : { error: `Trunk answered ${res.status}` }),
    workspaceId: opts.workspaceId,
  });

  if (res.status === 401 || res.status === 403) throw new TrunkAuthError(res.status);
  if (res.status === 404) throw new TrunkNotFoundError(errorCode(res.bodyText));
  if (!res.ok) {
    const code = errorCode(res.bodyText);
    throw new TrunkRequestError(
      `Trunk answered ${res.status}${code ? ` (${code})` : ''}`,
      res.status,
      code
    );
  }
  try {
    return JSON.parse(res.bodyText) as unknown;
  } catch {
    throw new TrunkRequestError('Trunk answered with a body that is not JSON', res.status);
  }
}

/** `GET /v2/repositories` for a GitHub repository. Resolves to the raw page. */
export function resolveRepository(
  apiKey: string,
  ref: { owner: string; repo: string },
  opts: { workspaceId?: string } = {}
): Promise<unknown> {
  return trunkGet(
    apiKey,
    '/v2/repositories',
    { providerUrl: `https://github.com/${ref.owner}/${ref.repo}` },
    opts
  );
}

/** `GET /v2/pull-requests` for one PR number. Resolves to the raw page. */
export function resolvePullRequest(
  apiKey: string,
  ref: { repositoryId: string; number: number },
  opts: { workspaceId?: string } = {}
): Promise<unknown> {
  return trunkGet(
    apiKey,
    '/v2/pull-requests',
    { repositoryId: ref.repositoryId, number: String(ref.number) },
    opts
  );
}

/** `GET /v2/pull-requests/{id}/queue-entry-estimate`. Resolves to the raw estimate. */
export function getQueueEntryEstimate(
  apiKey: string,
  pullRequestId: string,
  opts: { workspaceId?: string } = {}
): Promise<unknown> {
  return trunkGet(
    apiKey,
    `/v2/pull-requests/${encodeURIComponent(pullRequestId)}/queue-entry-estimate`,
    {},
    opts
  );
}
