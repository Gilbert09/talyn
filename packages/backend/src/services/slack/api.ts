import { debugBus } from '../debugBus.js';
import { fetchWithTimeout } from '../httpTimeout.js';

/**
 * The one funnel for outbound Slack Web API calls, so every call is timed into
 * the debug bus and every answer is read the same way.
 *
 * Slack answers HTTP 200 with `{ ok: false, error: "<code>" }` for most
 * failures, so `ok` here is Slack's `ok`, not the HTTP status.
 */

const SLACK_API = 'https://slack.com/api';
const TIMEOUT_MS = 10_000;

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    /** Slack's error code (`invalid_refresh_token`), or `http_<status>`. */
    readonly code: string,
    readonly status?: number,
    /** Slack's `Retry-After` on a rate limit, in milliseconds. */
    readonly retryAfterMs?: number,
    /** The scope Slack named on a `missing_scope` refusal. */
    readonly needed?: string
  ) {
    super(`Slack ${method} failed: ${code}`);
    this.name = 'SlackApiError';
  }
}

/** Whether Slack refused a call for its rate limit (HTTP 429, or `ratelimited`). */
export function isSlackRateLimited(err: unknown): err is SlackApiError {
  return err instanceof SlackApiError && (err.status === 429 || err.code === 'ratelimited');
}

/** `Retry-After` is whole seconds on Slack. Absent or unreadable means unknown. */
function retryAfterMsOf(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export interface SlackCallOptions {
  /** Form fields (`application/x-www-form-urlencoded`), as the OAuth methods require. */
  form?: Record<string, string | undefined>;
  /** A bearer token for methods that act as the bot or a user. */
  token?: string;
  /** Workspace the call is made for, for debug attribution. */
  workspaceId?: string;
}

/**
 * POST one Web API method and return its JSON body when Slack says `ok`.
 * Throws {@link SlackApiError} otherwise, carrying Slack's own error code.
 */
export async function callSlack<T extends Record<string, unknown>>(
  method: string,
  opts: SlackCallOptions = {}
): Promise<T> {
  const url = `${SLACK_API}/${method}`;
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.form ?? {})) {
    if (v !== undefined) body.set(k, v);
  }
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  const startedAt = Date.now();
  let status: number | undefined;
  try {
    const res = await fetchWithTimeout(
      url,
      { method: 'POST', headers, body: body.toString() },
      { timeoutMs: TIMEOUT_MS, label: `Slack ${method}` }
    );
    status = res.status;
    if (!res.ok) {
      throw new SlackApiError(method, `http_${res.status}`, res.status, retryAfterMsOf(res.headers));
    }
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(res.bodyText) as Record<string, unknown>;
    } catch {
      throw new SlackApiError(method, 'invalid_json', res.status);
    }
    if (doc.ok !== true) {
      throw new SlackApiError(
        method,
        typeof doc.error === 'string' ? doc.error : 'unknown_error',
        res.status,
        retryAfterMsOf(res.headers),
        typeof doc.needed === 'string' ? doc.needed : undefined
      );
    }
    debugBus.recordHttp({
      service: 'slack',
      method: 'POST',
      url,
      status,
      durationMs: Date.now() - startedAt,
      ok: true,
      workspaceId: opts.workspaceId,
    });
    return doc as T;
  } catch (err) {
    debugBus.recordHttp({
      service: 'slack',
      method: 'POST',
      url,
      status,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: err,
      workspaceId: opts.workspaceId,
    });
    throw err;
  }
}
