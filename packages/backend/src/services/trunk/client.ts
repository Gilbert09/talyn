import { createHash } from 'node:crypto';
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
const DEFAULT_RETRY_MS = 10_000;
const MAX_RETRY_MS = 15 * 60_000;
const REQUEST_SPACING_MS = 251;
const MAX_QUEUE_WAIT_MS = 10_000;

// Each replica keeps its own pause. Only a hash of the API key enters this map.
const pausedUntil = new Map<string, number>();
const nextRequestAt = new Map<string, number>();

export function trunkKeyHash(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

export function trunkPauseUntil(apiKey: string): number {
  return pausedUntil.get(trunkKeyHash(apiKey)) ?? 0;
}

export function clearTrunkPause(): void {
  pausedUntil.clear();
  nextRequestAt.clear();
}

async function waitForRequestSlot(apiKey: string): Promise<void> {
  const key = trunkKeyHash(apiKey);
  const now = Date.now();
  if ((pausedUntil.get(key) ?? 0) > now) throw new TrunkRequestError('Trunk reads are paused', 429);
  // Trunk allows 5 PR GETs per second per key. 251 ms spacing keeps all reads at 4/s.
  const at = Math.max(now, nextRequestAt.get(key) ?? now);
  if (at - now > MAX_QUEUE_WAIT_MS) throw new TrunkRequestError('Trunk request queue is full');
  nextRequestAt.set(key, at + REQUEST_SPACING_MS);
  if (at > now) await new Promise<void>((resolve) => setTimeout(resolve, at - now));
  if ((pausedUntil.get(key) ?? 0) > Date.now()) {
    throw new TrunkRequestError('Trunk reads are paused', 429);
  }
}

function retryAfterMs(raw: string | null): number {
  if (!raw?.trim()) return DEFAULT_RETRY_MS;
  const seconds = Number(raw);
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(duration) ? Math.min(MAX_RETRY_MS, Math.max(0, duration)) : DEFAULT_RETRY_MS;
}

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
  query: URLSearchParams,
  opts: { workspaceId?: string }
): Promise<unknown> {
  await waitForRequestSlot(apiKey);
  const qs = query.toString();
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
  if (res.status === 429 || (res.status === 503 && res.headers.has('retry-after'))) {
    const key = trunkKeyHash(apiKey);
    pausedUntil.set(
      key,
      Math.max(pausedUntil.get(key) ?? 0, Date.now() + retryAfterMs(res.headers.get('retry-after')))
    );
  }
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
    new URLSearchParams({ providerUrl: `https://github.com/${ref.owner}/${ref.repo}` }),
    opts
  );
}

/** `GET /v2/pull-requests` for up to 50 PR numbers. Resolves to the raw page. */
export function resolvePullRequests(
  apiKey: string,
  ref: { repositoryId: string; numbers: number[] },
  opts: { workspaceId?: string } = {}
): Promise<unknown> {
  const query = new URLSearchParams({ repositoryId: ref.repositoryId });
  for (const number of ref.numbers) query.append('number', String(number));
  return trunkGet(
    apiKey,
    '/v2/pull-requests',
    query,
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
    new URLSearchParams(),
    opts
  );
}
