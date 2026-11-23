import { debugBus } from '../debugBus.js';
import { fetchWithTimeout } from '../httpTimeout.js';
import { LINEAR_GRAPHQL_URL } from './config.js';

/**
 * Linear's GraphQL API, called with one connection's access token.
 *
 * Linear answers a rate limit with HTTP 400 and the error code `RATELIMITED`
 * (sometimes 429), and says when the window resets in
 * `X-RateLimit-Requests-Reset` (epoch ms). Both become a
 * {@link LinearRateLimitError}, which a rule's write-back parks as
 * `rate_gated`. The reset is remembered per connection, so the engine can
 * schedule a parked run from it.
 */

export class LinearRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'LinearRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** The token is no longer accepted: revoked, or the app was removed. */
export class LinearAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinearAuthError';
  }
}

export class LinearApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinearApiError';
  }
}

/**
 * How long to wait when Linear says "rate limited" without a reset time.
 * Linear's limits are per hour; a minute is long enough not to hammer it and
 * short enough that the retry sweep (5 attempts) still gets through.
 */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

/** One Linear call. Linear answers in well under a second; 15 s is a hang. */
const LINEAR_TIMEOUT_MS = 15_000;

const blockedUntil = new Map<string, number>();

/** When the rate limit Linear set for this connection clears (epoch ms), 0 when it has. */
export function linearBlockedUntil(connectionId: string, now = Date.now()): number {
  const until = blockedUntil.get(connectionId) ?? 0;
  if (until <= now) {
    blockedUntil.delete(connectionId);
    return 0;
  }
  return until;
}

/** Tests: forget every remembered rate limit. */
export function resetLinearRateLimitsForTests(): void {
  blockedUntil.clear();
}

interface GraphqlError {
  message?: unknown;
  extensions?: { code?: unknown; type?: unknown } | null;
}

function retryAfter(headers: Headers, now: number): number {
  const reset = Number(headers.get('x-ratelimit-requests-reset'));
  if (Number.isFinite(reset) && reset > now) return reset - now;
  const seconds = Number(headers.get('retry-after'));
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return DEFAULT_RATE_LIMIT_WAIT_MS;
}

export async function linearGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
  opts: { connectionId?: string } = {}
): Promise<T> {
  const startedAt = Date.now();
  if (opts.connectionId) {
    const until = linearBlockedUntil(opts.connectionId, startedAt);
    if (until > 0) throw new LinearRateLimitError('Linear is rate-limiting this connection.', until - startedAt);
  }
  let res;
  try {
    res = await fetchWithTimeout(
      LINEAR_GRAPHQL_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables }),
      },
      { timeoutMs: LINEAR_TIMEOUT_MS, label: 'Linear' }
    );
  } catch (err) {
    debugBus.recordHttp({ service: 'linear', method: 'POST', url: LINEAR_GRAPHQL_URL, status: 0, durationMs: Date.now() - startedAt, ok: false, error: err });
    throw err;
  }
  let doc: { data?: T; errors?: GraphqlError[] } = {};
  try {
    doc = JSON.parse(res.bodyText) as typeof doc;
  } catch {
    doc = {};
  }
  const errors = Array.isArray(doc.errors) ? doc.errors : [];
  const codes = errors.map((e) => String(e.extensions?.code ?? '').toUpperCase());
  const ok = res.ok && errors.length === 0;
  debugBus.recordHttp({
    service: 'linear',
    method: 'POST',
    url: LINEAR_GRAPHQL_URL,
    status: res.status,
    durationMs: Date.now() - startedAt,
    ok,
    ...(ok ? {} : { error: errors[0]?.message ?? `HTTP ${res.status}` }),
  });

  if (res.status === 429 || codes.includes('RATELIMITED')) {
    const wait = retryAfter(res.headers, Date.now());
    if (opts.connectionId) blockedUntil.set(opts.connectionId, Date.now() + wait);
    throw new LinearRateLimitError('Linear is rate-limiting this connection.', wait);
  }
  if (res.status === 401 || codes.includes('AUTHENTICATION_ERROR')) {
    throw new LinearAuthError('Linear no longer accepts the connection. Connect Linear again.');
  }
  if (!res.ok || errors.length > 0) {
    const message = typeof errors[0]?.message === 'string' ? errors[0].message : `Linear answered HTTP ${res.status}`;
    throw new LinearApiError(message);
  }
  if (!doc.data) throw new LinearApiError('Linear answered without data.');
  return doc.data;
}
