import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  githubRateGate,
  GitHubRateLimitError,
  parseRateLimitResponse,
  graphqlPrimaryLimitResetMs,
  MAX_GATE_WAIT_MS,
} from '../services/githubRateGate.js';
import { debugBus } from '../services/debugBus.js';

/**
 * The secondary-rate-limit gate: detecting the signal off a failed response
 * (parseRateLimitResponse) and the per-account backoff state machine
 * (block / waitIfBlocked). Secondary limits are GitHub's anti-abuse throttle —
 * tripped by burst + concurrency — and the whole point of the gate is to stop
 * us hammering once we hit one.
 */

const NOW = 1_700_000_000_000; // fixed epoch (ms) — keeps the maths deterministic

/** Build a Response-shaped stub with just the bits parseRateLimitResponse reads. */
function resp(status: number, headers: Record<string, string> = {}) {
  return { status, headers: new Headers(headers) };
}

beforeEach(() => {
  githubRateGate._reset();
  debugBus._reset();
  debugBus.setEnabled(false); // silence backoff events in these unit tests
});

describe('parseRateLimitResponse', () => {
  it('flags a 429 even with no headers, defaulting the backoff to 60s', () => {
    const r = parseRateLimitResponse(resp(429), '', NOW);
    expect(r.isRateLimited).toBe(true);
    expect(r.retryAfterMs).toBe(60_000);
  });

  it('flags a 403 carrying a Retry-After header and uses it (seconds → ms)', () => {
    const r = parseRateLimitResponse(resp(403, { 'retry-after': '30' }), '', NOW);
    expect(r.isRateLimited).toBe(true);
    expect(r.retryAfterMs).toBe(30_000);
  });

  it('flags a 403 whose body mentions a secondary rate limit', () => {
    const r = parseRateLimitResponse(
      resp(403),
      'You have exceeded a secondary rate limit. Please wait a few minutes',
      NOW,
    );
    expect(r.isRateLimited).toBe(true);
  });

  it('flags a 403 with x-ratelimit-remaining: 0 and backs off until reset', () => {
    const reset = Math.floor(NOW / 1000) + 45; // 45s out
    const r = parseRateLimitResponse(
      resp(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }),
      '',
      NOW,
    );
    expect(r.isRateLimited).toBe(true);
    expect(r.retryAfterMs).toBe(45_000);
  });

  it('does NOT flag a plain 403 permissions error', () => {
    const r = parseRateLimitResponse(
      resp(403),
      'Resource not accessible by personal access token',
      NOW,
    );
    expect(r.isRateLimited).toBe(false);
    expect(r.retryAfterMs).toBe(0);
  });

  it('prefers Retry-After over x-ratelimit-reset when both are present', () => {
    const reset = Math.floor(NOW / 1000) + 600;
    const r = parseRateLimitResponse(
      resp(429, { 'retry-after': '12', 'x-ratelimit-reset': String(reset) }),
      '',
      NOW,
    );
    expect(r.retryAfterMs).toBe(12_000);
  });

  it('clamps an absurd Retry-After to the 5-minute ceiling', () => {
    const r = parseRateLimitResponse(resp(429, { 'retry-after': '99999' }), '', NOW);
    expect(r.retryAfterMs).toBe(5 * 60_000);
  });

  it('clamps a reset already in the past up to 0', () => {
    const reset = Math.floor(NOW / 1000) - 10; // 10s ago
    const r = parseRateLimitResponse(
      resp(429, { 'x-ratelimit-reset': String(reset) }),
      '',
      NOW,
    );
    expect(r.retryAfterMs).toBe(0);
  });
});

describe('graphqlPrimaryLimitResetMs', () => {
  // The primary GraphQL point-budget error comes on an HTTP 200 body, so the
  // reset time is read straight off the headers (parseRateLimitResponse only
  // trusts a failed 403/429). This is what the circuit breaker blocks until.
  it('returns the x-ratelimit-reset instant when it is in the future', () => {
    const reset = Math.floor(NOW / 1000) + 600; // 10 min out
    const until = graphqlPrimaryLimitResetMs(new Headers({ 'x-ratelimit-reset': String(reset) }), NOW);
    expect(until).toBe(reset * 1000);
  });

  it('returns 0 when the header is missing (caller falls back to a default backoff)', () => {
    expect(graphqlPrimaryLimitResetMs(new Headers({}), NOW)).toBe(0);
  });

  it('returns 0 when the reset is already in the past', () => {
    const reset = Math.floor(NOW / 1000) - 30;
    expect(graphqlPrimaryLimitResetMs(new Headers({ 'x-ratelimit-reset': String(reset) }), NOW)).toBe(0);
  });

  it('returns 0 on an unparseable header', () => {
    expect(graphqlPrimaryLimitResetMs(new Headers({ 'x-ratelimit-reset': 'nope' }), NOW)).toBe(0);
  });

  it('clamps a bogus far-future reset to at most ~65min ahead', () => {
    const reset = Math.floor(NOW / 1000) + 24 * 3600; // a day out (garbage)
    const until = graphqlPrimaryLimitResetMs(new Headers({ 'x-ratelimit-reset': String(reset) }), NOW);
    expect(until).toBe(NOW + 65 * 60_000);
  });
});

describe('gate state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports an account as blocked until its window passes', () => {
    githubRateGate.block('acct', NOW + 5_000, 'test');
    expect(githubRateGate.isBlocked('acct')).toBe(true);
    expect(githubRateGate.blockedUntil('acct')).toBe(NOW + 5_000);
    vi.setSystemTime(NOW + 5_001);
    expect(githubRateGate.isBlocked('acct')).toBe(false);
    expect(githubRateGate.blockedUntil('acct')).toBe(0);
  });

  it('extends a block via Math.max — a shorter later signal cannot shrink it', () => {
    githubRateGate.block('acct', NOW + 5_000, 'first');
    githubRateGate.block('acct', NOW + 1_000, 'second');
    expect(githubRateGate.blockedUntil('acct')).toBe(NOW + 5_000);
    githubRateGate.block('acct', NOW + 9_000, 'third');
    expect(githubRateGate.blockedUntil('acct')).toBe(NOW + 9_000);
  });

  it('does not block an account that was never gated', () => {
    expect(githubRateGate.isBlocked('fresh')).toBe(false);
    expect(githubRateGate.blockedUntil('fresh')).toBe(0);
  });

  it('waitIfBlocked sleeps out a block within the cap, then resolves', async () => {
    githubRateGate.block('acct', NOW + 5_000, 'test');
    const p = githubRateGate.waitIfBlocked('acct');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toBeUndefined();
  });

  it('waitIfBlocked returns immediately when not blocked', async () => {
    await expect(githubRateGate.waitIfBlocked('acct')).resolves.toBeUndefined();
  });

  it('waitIfBlocked throws GitHubRateLimitError when the block exceeds the cap', async () => {
    githubRateGate.block('acct', NOW + MAX_GATE_WAIT_MS + 30_000, 'long');
    await expect(githubRateGate.waitIfBlocked('acct')).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });
});
