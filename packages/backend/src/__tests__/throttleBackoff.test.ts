import { describe, it, expect } from 'vitest';
import {
  ThrottleBackoff,
  throttleRetryAfterMs,
  THROTTLE_BASE_COOLDOWN_MS,
  THROTTLE_MAX_COOLDOWN_MS,
} from '../services/cloudProviders/throttleBackoff.js';
import { PostHogCodeApiError } from '../services/posthogCode/client.js';

describe('throttleRetryAfterMs', () => {
  it('returns null for a 429 with no Retry-After', () => {
    expect(throttleRetryAfterMs(new PostHogCodeApiError(429, null, 'throttled'))).toBeNull();
  });

  it('returns the Retry-After ms for a 429 that carries one', () => {
    expect(throttleRetryAfterMs(new PostHogCodeApiError(429, 12_000, 'throttled'))).toBe(12_000);
  });

  it('returns undefined (not rate-limited) for other statuses', () => {
    expect(throttleRetryAfterMs(new PostHogCodeApiError(500, null, 'boom'))).toBeUndefined();
    expect(throttleRetryAfterMs(new PostHogCodeApiError(404, null, 'gone'))).toBeUndefined();
  });

  it('returns undefined for a plain error or non-error', () => {
    expect(throttleRetryAfterMs(new Error('network'))).toBeUndefined();
    expect(throttleRetryAfterMs('nope')).toBeUndefined();
    expect(throttleRetryAfterMs(null)).toBeUndefined();
  });

  it('duck-types any object carrying status:429 (provider-agnostic)', () => {
    expect(throttleRetryAfterMs({ status: 429, retryAfterMs: 5000 })).toBe(5000);
    expect(throttleRetryAfterMs({ status: 429 })).toBeNull();
  });
});

describe('ThrottleBackoff', () => {
  const KEY = 'ws-1';

  it('is not cooling down before any throttle', () => {
    const tb = new ThrottleBackoff();
    expect(tb.isCoolingDown(KEY, 0)).toBe(false);
  });

  it('cools down for the base interval on the first throttle', () => {
    const tb = new ThrottleBackoff();
    const rec = tb.record(KEY, null, 1_000);
    expect(rec.backoffMs).toBe(THROTTLE_BASE_COOLDOWN_MS);
    expect(rec.consecutive).toBe(1);
    expect(rec.honoredRetryAfter).toBe(false);
    expect(tb.isCoolingDown(KEY, 1_000)).toBe(true);
    // Still cooling just before expiry, clear right after.
    expect(tb.isCoolingDown(KEY, 1_000 + THROTTLE_BASE_COOLDOWN_MS - 1)).toBe(true);
    expect(tb.isCoolingDown(KEY, 1_000 + THROTTLE_BASE_COOLDOWN_MS)).toBe(false);
  });

  it('doubles the backoff on consecutive throttles, capped at the max', () => {
    const tb = new ThrottleBackoff();
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) seen.push(tb.record(KEY, null, i).backoffMs);
    // 30s, 60s, 120s, 240s, then capped at 300s.
    expect(seen).toEqual([
      30_000, 60_000, 120_000, 240_000,
      THROTTLE_MAX_COOLDOWN_MS, THROTTLE_MAX_COOLDOWN_MS,
      THROTTLE_MAX_COOLDOWN_MS, THROTTLE_MAX_COOLDOWN_MS,
    ]);
  });

  it('clear() resets the escalation — the next throttle starts at base again', () => {
    const tb = new ThrottleBackoff();
    tb.record(KEY, null, 0);
    tb.record(KEY, null, 0);
    expect(tb.record(KEY, null, 0).backoffMs).toBe(120_000); // 3rd
    tb.clear(KEY);
    expect(tb.isCoolingDown(KEY, 0)).toBe(false);
    const fresh = tb.record(KEY, null, 0);
    expect(fresh.backoffMs).toBe(THROTTLE_BASE_COOLDOWN_MS);
    expect(fresh.consecutive).toBe(1);
  });

  it('honors Retry-After over the exponential schedule', () => {
    const tb = new ThrottleBackoff();
    const rec = tb.record(KEY, 7_000, 0);
    expect(rec.backoffMs).toBe(7_000);
    expect(rec.honoredRetryAfter).toBe(true);
    expect(tb.isCoolingDown(KEY, 6_999)).toBe(true);
    expect(tb.isCoolingDown(KEY, 7_000)).toBe(false);
  });

  it('tracks cooldowns per key independently', () => {
    const tb = new ThrottleBackoff();
    tb.record('ws-a', null, 0);
    expect(tb.isCoolingDown('ws-a', 0)).toBe(true);
    expect(tb.isCoolingDown('ws-b', 0)).toBe(false);
  });

  it('pruneTo drops cooldowns for keys no longer active', () => {
    const tb = new ThrottleBackoff();
    tb.record('ws-a', null, 0);
    tb.record('ws-b', null, 0);
    tb.pruneTo(new Set(['ws-a']));
    expect(tb.isCoolingDown('ws-a', 0)).toBe(true);
    expect(tb.isCoolingDown('ws-b', 0)).toBe(false);
  });
});
