import type { NextFunction, Request, Response } from 'express';
import { getRedis } from '../services/redis.js';
import { PublicApiError } from '../services/public/errors.js';

/**
 * Rate limits for `/v1`, shared by every replica through Redis.
 *
 * A sliding-window COUNTER, not a log: each key keeps one counter per fixed
 * window, and a request is weighed against `previous × (share of the previous
 * window still inside the sliding window) + current`. Two integers per key
 * instead of one timestamp per request, and no burst of 2× the limit at a
 * window edge, which a plain fixed window allows.
 *
 * Without `REDIS_URL` (local development) the counters live in this process,
 * as the app limiter in `rateLimit.ts` does. If Redis fails during a request,
 * that request is counted in memory instead: a Redis fault must not take the
 * API down, and the per-replica count still bounds it.
 *
 * Every response gets `RateLimit-Limit`, `RateLimit-Remaining` and
 * `RateLimit-Reset` (seconds); a refusal also gets `Retry-After`. When two
 * limiters apply to one request, the headers describe the tighter one.
 */

export interface WindowCounts {
  /** The count in the current window, this request included. */
  current: number;
  /** The count in the window before. */
  previous: number;
}

export interface RateLimitStore {
  /** Count one request against `key` and return the two windows. */
  hit(key: string, windowIndex: number, windowMs: number): Promise<WindowCounts>;
  /** Take back a request that was refused, so a refusal does not use up budget. */
  undo(key: string, windowIndex: number): Promise<void>;
  /** Read the two windows without counting. */
  peek(key: string, windowIndex: number): Promise<WindowCounts>;
}

/** The counters in this process. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly counts = new Map<string, { count: number; expiresAt: number }>();
  private lastSweep = 0;

  async hit(key: string, windowIndex: number, windowMs: number): Promise<WindowCounts> {
    const now = Date.now();
    this.sweep(now);
    const currentKey = `${key}:${windowIndex}`;
    const entry = this.counts.get(currentKey) ?? { count: 0, expiresAt: now + 2 * windowMs };
    entry.count += 1;
    this.counts.set(currentKey, entry);
    return { current: entry.count, previous: this.counts.get(`${key}:${windowIndex - 1}`)?.count ?? 0 };
  }

  async undo(key: string, windowIndex: number): Promise<void> {
    const entry = this.counts.get(`${key}:${windowIndex}`);
    if (entry && entry.count > 0) entry.count -= 1;
  }

  async peek(key: string, windowIndex: number): Promise<WindowCounts> {
    return {
      current: this.counts.get(`${key}:${windowIndex}`)?.count ?? 0,
      previous: this.counts.get(`${key}:${windowIndex - 1}`)?.count ?? 0,
    };
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 30_000) return;
    this.lastSweep = now;
    for (const [k, v] of this.counts) if (v.expiresAt <= now) this.counts.delete(k);
  }
}

/** What the Redis store needs from an ioredis client. */
export interface RedisPipelineLike {
  incr(key: string): RedisPipelineLike;
  pexpire(key: string, ms: number): RedisPipelineLike;
  get(key: string): RedisPipelineLike;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface RedisLike {
  multi(): RedisPipelineLike;
  decr(key: string): Promise<number>;
}

/** The counters in Redis: one key per window, expiring two windows later. */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: RedisLike, private readonly prefix = 'rl:v1') {}

  async hit(key: string, windowIndex: number, windowMs: number): Promise<WindowCounts> {
    const currentKey = `${this.prefix}:${key}:${windowIndex}`;
    const result = await this.redis
      .multi()
      .incr(currentKey)
      .pexpire(currentKey, 2 * windowMs)
      .get(`${this.prefix}:${key}:${windowIndex - 1}`)
      .exec();
    if (!result) throw new Error('rate limit transaction was aborted');
    for (const [err] of result) if (err) throw err;
    return { current: Number(result[0][1]), previous: Number(result[2][1] ?? 0) };
  }

  async undo(key: string, windowIndex: number): Promise<void> {
    await this.redis.decr(`${this.prefix}:${key}:${windowIndex}`);
  }

  async peek(key: string, windowIndex: number): Promise<WindowCounts> {
    const result = await this.redis
      .multi()
      .get(`${this.prefix}:${key}:${windowIndex}`)
      .get(`${this.prefix}:${key}:${windowIndex - 1}`)
      .exec();
    if (!result) throw new Error('rate limit transaction was aborted');
    for (const [err] of result) if (err) throw err;
    return { current: Number(result[0][1] ?? 0), previous: Number(result[1][1] ?? 0) };
  }
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window ends. */
  resetSeconds: number;
}

/** Weigh one request. Pure apart from the store. */
export async function checkRateLimit(
  store: RateLimitStore,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<RateLimitDecision> {
  const windowIndex = Math.floor(now / windowMs);
  const intoWindow = (now % windowMs) / windowMs;
  const counts = await store.hit(key, windowIndex, windowMs);
  const estimate = counts.previous * (1 - intoWindow) + counts.current;
  const resetSeconds = Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
  if (estimate > limit) {
    await store.undo(key, windowIndex).catch(() => undefined);
    return { allowed: false, limit, remaining: 0, resetSeconds };
  }
  return { allowed: true, limit, remaining: Math.max(0, Math.floor(limit - estimate)), resetSeconds };
}

/** Whether one more request would still be inside the limit. Counts nothing. */
export async function peekRateLimit(
  store: RateLimitStore,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<RateLimitDecision> {
  const windowIndex = Math.floor(now / windowMs);
  const intoWindow = (now % windowMs) / windowMs;
  const counts = await store.peek(key, windowIndex);
  const estimate = counts.previous * (1 - intoWindow) + counts.current;
  const resetSeconds = Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
  const allowed = estimate + 1 <= limit;
  return { allowed, limit, remaining: allowed ? Math.floor(limit - estimate - 1) : 0, resetSeconds };
}

const memoryFallback = new MemoryRateLimitStore();
let redisStore: RedisRateLimitStore | null = null;
let warnedRedisFault = false;

/** The Redis store when `REDIS_URL` is set, else this process's counters. */
function defaultStore(): RateLimitStore {
  const redis = getRedis();
  if (!redis) return memoryFallback;
  redisStore ??= new RedisRateLimitStore(redis as unknown as RedisLike);
  return redisStore;
}

function setHeaders(res: Response, decision: RateLimitDecision): void {
  const shown = res.locals.publicRateLimit as RateLimitDecision | undefined;
  if (shown && shown.remaining <= decision.remaining && decision.allowed) return;
  res.locals.publicRateLimit = decision;
  res.setHeader('RateLimit-Limit', String(decision.limit));
  res.setHeader('RateLimit-Remaining', String(decision.remaining));
  res.setHeader('RateLimit-Reset', String(decision.resetSeconds));
}

export interface PublicRateLimitOptions {
  /** Part of the key, so two limiters on one token do not share a counter. */
  name: string;
  limit: number;
  windowMs: number;
  /** Who is counted: the token id after auth, the IP before it. */
  keyFn: (req: Request) => string;
  /** The words of the 429. */
  message?: string;
  /** For tests. */
  store?: RateLimitStore;
}

export function publicRateLimit(options: PublicRateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = `${options.name}:${options.keyFn(req)}`;
    const store = options.store ?? defaultStore();
    let decision: RateLimitDecision;
    try {
      decision = await checkRateLimit(store, key, options.limit, options.windowMs);
    } catch (err) {
      if (!warnedRedisFault) {
        warnedRedisFault = true;
        console.warn('[public-api] rate limit store failed; counting in memory:', err instanceof Error ? err.message : err);
      }
      decision = await checkRateLimit(memoryFallback, key, options.limit, options.windowMs);
    }
    setHeaders(res, decision);
    if (!decision.allowed) {
      throw new PublicApiError(429, 'rate_limited', options.message ?? 'Too many requests. Wait, then retry.', {
        headers: { 'Retry-After': String(decision.resetSeconds) },
        details: { retry_after: decision.resetSeconds },
      });
    }
    next();
  };
}

/**
 * The limit in front of authentication. It counts FAILED authentications per
 * IP, because each attempt is a database lookup and a brute force must not
 * drive those. A request with a good token costs this budget nothing, so it
 * never stands between a caller and the per-token budget, however many tokens
 * share one IP (a CI runner, an office).
 */
export function authFailureGuard(options: Omit<PublicRateLimitOptions, 'message'>) {
  const keyOf = (req: Request) => `${options.name}:${options.keyFn(req)}`;
  return {
    async check(req: Request, _res: Response, next: NextFunction): Promise<void> {
      const store = options.store ?? defaultStore();
      let decision: RateLimitDecision;
      try {
        decision = await peekRateLimit(store, keyOf(req), options.limit, options.windowMs);
      } catch {
        decision = await peekRateLimit(memoryFallback, keyOf(req), options.limit, options.windowMs);
      }
      if (!decision.allowed) {
        throw new PublicApiError(429, 'rate_limited', 'Too many failed authentication attempts from this address. Wait, then retry.', {
          headers: { 'Retry-After': String(decision.resetSeconds) },
          details: { retry_after: decision.resetSeconds },
        });
      }
      next();
    },
    async record(req: Request): Promise<void> {
      const store = options.store ?? defaultStore();
      const now = Date.now();
      try {
        await store.hit(keyOf(req), Math.floor(now / options.windowMs), options.windowMs);
      } catch {
        await memoryFallback.hit(keyOf(req), Math.floor(now / options.windowMs), options.windowMs);
      }
    },
  };
}

/** The per-token budgets. Shown in the docs; change them there too. */
export const PUBLIC_RATE_LIMITS = {
  /** Every authenticated request, per token. */
  perToken: { limit: 600, windowMs: 60_000 },
  /** Requests that start work (a session, a chat, a message), per token. */
  creates: { limit: 60, windowMs: 60_000 },
  /**
   * Requests that call GitHub as the token owner (refresh, post to PR), per
   * token. GitHub allows a person 5,000 REST requests an hour; 30 a minute is
   * 1,800 an hour at most, so a busy script leaves most of it for the app.
   */
  github: { limit: 30, windowMs: 60_000 },
  /** Failed authentications per IP: each attempt is a database lookup. The `/mcp` mount uses the same 300. */
  authFailuresPerIp: { limit: 300, windowMs: 60_000 },
} as const;
