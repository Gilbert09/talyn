import { debugBus } from './debugBus.js';

/**
 * GitHub secondary-rate-limit gate.
 *
 * GitHub enforces TWO kinds of limit. The *primary* hourly/per-minute budgets
 * are reported by `GET /rate_limit` and surfaced as the Debug panel cards. The
 * *secondary* limit is an anti-abuse throttle — tripped by bursts and by making
 * concurrent requests for one user — and it is NOT visible in `/rate_limit`; it
 * only shows up as a `403`/`429` on a live request, usually carrying a
 * `Retry-After` header or a body that says "secondary rate limit".
 *
 * When we hit either, the worst thing we can do is keep firing: that extends the
 * penalty window. This gate records a per-account "blocked until" instant and
 * every request funnel (`apiRequest`, `executeGraphql`) waits behind it before
 * sending. Blocks are keyed by *account* (not workspace) because the budget is
 * per GitHub account — multiple workspaces can share one OAuth token.
 *
 * Pairs with {@link parseRateLimitResponse}, which extracts the signal off a
 * failed response, and the {@link rateBudgetGovernor}, which proactively slows
 * polling so we ideally never reach this gate in the first place.
 */

/** Longest a single request will block waiting for a gate to clear. */
export const MAX_GATE_WAIT_MS = 60_000;

/** Upper bound on a parsed backoff, so a bogus `reset` can't pause us for ages. */
const MAX_BACKOFF_MS = 5 * 60_000;

/** Fallback backoff when a rate-limit response carries no usable timing. */
const DEFAULT_BACKOFF_MS = 60_000;

/**
 * Thrown when a request can't proceed because its account is gated for longer
 * than {@link MAX_GATE_WAIT_MS}. Callers (the pollers) treat it as "skip this
 * tick" — the next gated tick retries once the window clears.
 */
export class GitHubRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'GitHubRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Inspect a failed GitHub response for a rate-limit signal. Pure (no I/O) so it
 * can be unit-tested against synthetic responses.
 *
 * Treated as rate-limited when:
 *   - status is `429` (primary or secondary), OR
 *   - status is `403` AND any of: a `retry-after` header is present, the body
 *     mentions "secondary rate limit", or `x-ratelimit-remaining` is `0`.
 *
 * `retryAfterMs` precedence: `retry-after` (seconds) → `x-ratelimit-reset`
 * (epoch seconds, minus now) → {@link DEFAULT_BACKOFF_MS}. Always clamped to
 * `[0, MAX_BACKOFF_MS]`.
 */
export function parseRateLimitResponse(
  response: Pick<Response, 'status'> & { headers: Headers },
  bodyText: string,
  now: number = Date.now(),
): { isRateLimited: boolean; retryAfterMs: number } {
  const status = response.status;
  const retryAfterHeader = response.headers.get('retry-after');
  const remaining = response.headers.get('x-ratelimit-remaining');
  const isSecondaryBody = /secondary rate limit/i.test(bodyText);

  const isRateLimited =
    status === 429 ||
    (status === 403 && (retryAfterHeader !== null || isSecondaryBody || remaining === '0'));

  if (!isRateLimited) return { isRateLimited: false, retryAfterMs: 0 };

  let retryAfterMs = DEFAULT_BACKOFF_MS;
  if (retryAfterHeader !== null) {
    const secs = Number.parseInt(retryAfterHeader, 10);
    if (Number.isFinite(secs)) retryAfterMs = secs * 1000;
  } else {
    const reset = response.headers.get('x-ratelimit-reset');
    if (reset !== null) {
      const resetMs = Number.parseInt(reset, 10) * 1000;
      if (Number.isFinite(resetMs)) retryAfterMs = resetMs - now;
    }
  }

  retryAfterMs = Math.max(0, Math.min(MAX_BACKOFF_MS, retryAfterMs));
  return { isRateLimited: true, retryAfterMs };
}

/**
 * Fallback backoff for a primary GraphQL point-budget exhaustion when the
 * response carries no usable `x-ratelimit-reset`. The primary budget refills on
 * an hourly window, so a short pause would just re-trip; back off a few minutes
 * and let the next gated tick re-probe.
 */
export const PRIMARY_LIMIT_FALLBACK_MS = 5 * 60_000;

/** Never hold a primary-limit block longer than this, even if `reset` is bogus. */
const MAX_PRIMARY_BLOCK_MS = 65 * 60_000;

/**
 * Epoch-ms until a GraphQL *primary* point-budget exhaustion clears, read off
 * the `x-ratelimit-reset` header GitHub sends on the (HTTP 200) response whose
 * body carries a top-level `RATE_LIMITED` error. Unlike {@link
 * parseRateLimitResponse} (which only trusts a failed 403/429), this reads the
 * header off a 200 GraphQL response. Returns 0 when the header is missing,
 * unparseable, or already past — the caller then falls back to
 * {@link PRIMARY_LIMIT_FALLBACK_MS}. Clamped to at most {@link
 * MAX_PRIMARY_BLOCK_MS} ahead so a garbage `reset` can't pause an account for
 * hours. Pure, for unit tests.
 */
export function graphqlPrimaryLimitResetMs(
  headers: Pick<Headers, 'get'>,
  now: number = Date.now(),
): number {
  const reset = headers.get('x-ratelimit-reset');
  if (reset === null) return 0;
  const resetMs = Number.parseInt(reset, 10) * 1000;
  if (!Number.isFinite(resetMs) || resetMs <= now) return 0;
  return Math.min(resetMs, now + MAX_PRIMARY_BLOCK_MS);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class GitHubRateGate {
  /** accountKey → epoch ms until which that account is gated. */
  private blocks = new Map<string, number>();

  /**
   * Engage (or extend) a backoff for an account. Idempotent-ish: a later signal
   * that points further out wins (`Math.max`), so overlapping 403s don't shorten
   * an existing block. Logs + records to the Debug panel only when the block is
   * newly extended, to avoid spamming under a burst.
   */
  block(accountKey: string, untilMs: number, reason: string): void {
    const existing = this.blocks.get(accountKey) ?? 0;
    if (untilMs <= existing) return;
    this.blocks.set(accountKey, untilMs);
    const waitMs = Math.max(0, untilMs - Date.now());
    console.warn(
      `GitHub rate-limit backoff for ${accountKey}: pausing ~${Math.round(waitMs / 1000)}s (${reason})`,
    );
    debugBus.recordEvent({
      service: 'github',
      action: 'rate-limit-backoff',
      ok: false,
      summary: `Rate-limit backoff ${Math.round(waitMs / 1000)}s — ${reason}`,
      meta: { accountKey, waitMs, reason },
    });
  }

  /** Whether the account is currently gated. */
  isBlocked(accountKey: string): boolean {
    return this.blockedUntil(accountKey) > Date.now();
  }

  /** Epoch ms the account is gated until (0 if not gated). */
  blockedUntil(accountKey: string): number {
    const until = this.blocks.get(accountKey);
    if (until === undefined) return 0;
    if (until <= Date.now()) {
      this.blocks.delete(accountKey);
      return 0;
    }
    return until;
  }

  /**
   * Pause an outbound request until its account's gate clears. If the remaining
   * wait is within {@link MAX_GATE_WAIT_MS} we sleep it out and return; if it's
   * longer we throw {@link GitHubRateLimitError} so the caller skips this tick
   * rather than holding a socket open for minutes.
   */
  async waitIfBlocked(accountKey: string): Promise<void> {
    const until = this.blockedUntil(accountKey);
    const remaining = until - Date.now();
    if (remaining <= 0) return;
    if (remaining > MAX_GATE_WAIT_MS) {
      throw new GitHubRateLimitError(
        `GitHub rate-limited; retry in ${Math.round(remaining / 1000)}s`,
        remaining,
      );
    }
    await sleep(remaining);
  }

  /** Test helper — drop all gate state. */
  _reset(): void {
    this.blocks.clear();
  }
}

export const githubRateGate = new GitHubRateGate();
