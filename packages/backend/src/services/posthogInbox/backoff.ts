/**
 * How long Talyn waits after PostHog refuses a call, shared by the poller
 * and the claim writes so both back off the same way:
 *  - 401 or 403: the connection needs the user, not a retry. 30 minutes.
 *  - 429: PostHog's `Retry-After`, and at least the poll interval.
 *  - anything else (a 5xx, a timeout): 10 minutes.
 */

/** How often one connection is polled. */
export const POSTHOG_INBOX_POLL_INTERVAL_MS = 3 * 60_000;
/** After a 401 or 403. */
export const POSTHOG_AUTH_BACKOFF_MS = 30 * 60_000;
/** After any other failure. */
export const POSTHOG_ERROR_BACKOFF_MS = 10 * 60_000;

export function isPostHogAuthStatus(status: number | null | undefined): boolean {
  return status === 401 || status === 403;
}

/** PURE: the wait after a failed PostHog call with this status. */
export function posthogBackoffMs(status: number | null | undefined, retryAfterMs: number | null | undefined): number {
  if (isPostHogAuthStatus(status)) return POSTHOG_AUTH_BACKOFF_MS;
  if (status === 429) return Math.max(POSTHOG_INBOX_POLL_INTERVAL_MS, retryAfterMs ?? 0);
  return POSTHOG_ERROR_BACKOFF_MS;
}
