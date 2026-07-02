/**
 * `fetch` with a hard timeout covering the WHOLE request — headers AND body —
 * for outbound cloud-provider calls. Same pattern as `fetchWithTimeout` in
 * services/github.ts (see the prod incident documented there: a response
 * whose body stalled after headers hung a poll tick for 5+ minutes); kept
 * separate so the GitHub client's own timeout/logging conventions stay
 * untouched. The body is consumed inside the timer and returned as text.
 *
 * On timeout it throws a descriptive error (not a bare `AbortError`) so
 * callers log something useful.
 */

export const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;

export interface TimedFetchResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  bodyText: string;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number; label?: string } = {}
): Promise<TimedFetchResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS;
  const label = opts.label ?? 'Outbound';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // The `signal` is applied AFTER the spread so it always wins.
    const response = await fetch(url, { ...init, signal: controller.signal });
    const bodyText = await response.text();
    return {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      headers: response.headers,
      bodyText,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${label} request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
