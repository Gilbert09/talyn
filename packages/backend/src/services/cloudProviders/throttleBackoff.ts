/**
 * Per-key rate-limit backoff for the cloud poller. A provider 429 is
 * per-credential (in practice per workspace), so instead of re-issuing a
 * request for every in-flight task under that credential each 10s tick — the
 * pattern behind the July-9 throttle storm — we cool the whole key down.
 *
 * Consecutive throttles (each cooldown expiry that re-throttles on retry)
 * double the backoff up to the cap; a `clear()` on a successful reconcile
 * resets it, so the next 429 starts fresh. Provider-agnostic and pure (time
 * is injected), so it's unit-testable without the poll loop.
 */

export const THROTTLE_BASE_COOLDOWN_MS = 30_000;
export const THROTTLE_MAX_COOLDOWN_MS = 5 * 60_000;

/**
 * A provider client that throws an error carrying `status === 429` is
 * rate-limited. Returns the Retry-After (ms, or null when unspecified) in
 * that case, or undefined for any other error. Duck-typed so the generic
 * poller stays provider-agnostic — any client throwing `{ status,
 * retryAfterMs? }` works.
 */
export function throttleRetryAfterMs(err: unknown): number | null | undefined {
  if (err && typeof err === 'object' && (err as { status?: unknown }).status === 429) {
    const ra = (err as { retryAfterMs?: unknown }).retryAfterMs;
    return typeof ra === 'number' ? ra : null;
  }
  return undefined;
}

export interface ThrottleRecord {
  /** The cooldown applied (ms). */
  backoffMs: number;
  /** How many consecutive throttles this key has hit without a success. */
  consecutive: number;
  /** True when the provider's Retry-After drove the cooldown (vs. exponential). */
  honoredRetryAfter: boolean;
}

export class ThrottleBackoff {
  private cooldowns = new Map<string, { until: number; consecutive: number }>();

  /** Whether `key` is currently in an unexpired cooldown. */
  isCoolingDown(key: string, now: number): boolean {
    const cd = this.cooldowns.get(key);
    return cd !== undefined && now < cd.until;
  }

  /** Clear a key's cooldown (call on a successful request). */
  clear(key: string): void {
    this.cooldowns.delete(key);
  }

  /** Drop cooldowns for keys not in `activeKeys`, so the map stays bounded. */
  pruneTo(activeKeys: Set<string>): void {
    for (const key of this.cooldowns.keys()) {
      if (!activeKeys.has(key)) this.cooldowns.delete(key);
    }
  }

  /**
   * Record a throttle for `key` and return the applied backoff. `retryAfterMs`
   * (null when the provider didn't specify) takes precedence over the
   * exponential schedule when present.
   */
  record(key: string, retryAfterMs: number | null, now: number): ThrottleRecord {
    const consecutive = (this.cooldowns.get(key)?.consecutive ?? 0) + 1;
    const honoredRetryAfter = retryAfterMs != null;
    const backoffMs = honoredRetryAfter
      ? retryAfterMs
      : Math.min(
          THROTTLE_BASE_COOLDOWN_MS * 2 ** (consecutive - 1),
          THROTTLE_MAX_COOLDOWN_MS,
        );
    this.cooldowns.set(key, { until: now + backoffMs, consecutive });
    return { backoffMs, consecutive, honoredRetryAfter };
  }
}
