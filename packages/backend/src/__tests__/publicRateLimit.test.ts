import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import {
  authFailureGuard,
  checkRateLimit,
  MemoryRateLimitStore,
  publicRateLimit,
  RedisRateLimitStore,
  type RateLimitStore,
  type RedisLike,
  type RedisPipelineLike,
} from '../middleware/publicRateLimit.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { publicErrorHandler } from '../middleware/publicErrors.js';
import { requestId } from '../middleware/requestId.js';

/** Just enough of ioredis for the store: a map of counters behind MULTI. */
class FakeRedis implements RedisLike {
  readonly values = new Map<string, number>();
  readonly expiries = new Map<string, number>();
  failNext = false;

  multi(): RedisPipelineLike {
    const ops: Array<() => [Error | null, unknown]> = [];
    const pipeline: RedisPipelineLike = {
      incr: (key) => {
        ops.push(() => {
          const v = (this.values.get(key) ?? 0) + 1;
          this.values.set(key, v);
          return [null, v];
        });
        return pipeline;
      },
      pexpire: (key, ms) => {
        ops.push(() => {
          this.expiries.set(key, ms);
          return [null, 1];
        });
        return pipeline;
      },
      get: (key) => {
        ops.push(() => [null, this.values.has(key) ? String(this.values.get(key)) : null]);
        return pipeline;
      },
      exec: async () => {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('connection reset');
        }
        return ops.map((op) => op());
      },
    };
    return pipeline;
  }

  async decr(key: string): Promise<number> {
    const v = (this.values.get(key) ?? 0) - 1;
    this.values.set(key, v);
    return v;
  }
}

const WINDOW = 60_000;

describe('checkRateLimit', () => {
  it.each([
    ['the memory store', () => new MemoryRateLimitStore()],
    ['the Redis store', () => new RedisRateLimitStore(new FakeRedis())],
  ])('allows the limit and refuses one more with %s', async (_label, make) => {
    const store: RateLimitStore = make();
    const now = 10 * WINDOW + 1;
    for (let i = 1; i <= 3; i++) {
      const d = await checkRateLimit(store, 'k', 3, WINDOW, now);
      expect(d).toMatchObject({ allowed: true, limit: 3, remaining: 3 - i });
    }
    const refused = await checkRateLimit(store, 'k', 3, WINDOW, now);
    expect(refused).toMatchObject({ allowed: false, remaining: 0 });
    expect(refused.resetSeconds).toBe(60);
  });

  it('does not count a refused request', async () => {
    const redis = new FakeRedis();
    const store = new RedisRateLimitStore(redis);
    const now = 5 * WINDOW;
    await checkRateLimit(store, 'k', 1, WINDOW, now);
    for (let i = 0; i < 5; i++) await checkRateLimit(store, 'k', 1, WINDOW, now);
    expect(redis.values.get('rl:v1:k:5')).toBe(1);
  });

  it('expires each window key two windows later', async () => {
    const redis = new FakeRedis();
    await checkRateLimit(new RedisRateLimitStore(redis), 'k', 5, WINDOW, 7 * WINDOW);
    expect(redis.expiries.get('rl:v1:k:7')).toBe(2 * WINDOW);
  });

  it.each([
    // Into the next window by this share, with the previous window full (10 of 10).
    [0.01, false],
    [0.05, false],
    [0.1, true],
    [0.5, true],
  ])('weighs the previous window: %s of the way into the next window allows a request: %s', async (share, allowed) => {
    const store = new MemoryRateLimitStore();
    const start = 20 * WINDOW;
    for (let i = 0; i < 10; i++) await checkRateLimit(store, 'k', 10, WINDOW, start + 1);
    // previous × (1 − share) + 1 must stay ≤ 10.
    const d = await checkRateLimit(store, 'k', 10, WINDOW, start + WINDOW + Math.floor(share * WINDOW));
    expect(d.allowed).toBe(allowed);
  });

  it('keeps keys apart', async () => {
    const store = new MemoryRateLimitStore();
    await checkRateLimit(store, 'a', 1, WINDOW, WINDOW);
    expect((await checkRateLimit(store, 'b', 1, WINDOW, WINDOW)).allowed).toBe(true);
    expect((await checkRateLimit(store, 'a', 1, WINDOW, WINDOW)).allowed).toBe(false);
  });

  it('says how many seconds are left in the window', async () => {
    const d = await checkRateLimit(new MemoryRateLimitStore(), 'k', 5, WINDOW, 3 * WINDOW + 45_500);
    expect(d.resetSeconds).toBe(15);
  });
});

describe('publicRateLimit middleware', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = null;
  });

  async function serve(stores: RateLimitStore[], limits: number[]): Promise<string> {
    const app = express();
    app.use(requestId);
    stores.forEach((store, i) =>
      app.use(
        asyncHandler(
          publicRateLimit({ name: `l${i}`, limit: limits[i], windowMs: WINDOW, keyFn: (req) => String(req.headers['x-key']), store }),
        ),
      ),
    );
    app.get('/x', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(publicErrorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it('sends the RateLimit headers, then 429 with Retry-After and the public error body', async () => {
    const base = await serve([new MemoryRateLimitStore()], [2]);
    const first = await fetch(`${base}/x`, { headers: { 'x-key': 't1' } });
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit-limit')).toBe('2');
    expect(first.headers.get('ratelimit-remaining')).toBe('1');
    expect(Number(first.headers.get('ratelimit-reset'))).toBeGreaterThan(0);
    await fetch(`${base}/x`, { headers: { 'x-key': 't1' } });
    const refused = await fetch(`${base}/x`, { headers: { 'x-key': 't1' } });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = await refused.json();
    expect(body.error).toMatchObject({ type: 'rate_limit_error', code: 'rate_limited' });
    expect(body.error.request_id).toBe(refused.headers.get('x-request-id'));
    // Another key has its own budget.
    expect((await fetch(`${base}/x`, { headers: { 'x-key': 't2' } })).status).toBe(200);
  });

  it('shows the tighter of two limiters in the headers', async () => {
    const base = await serve([new MemoryRateLimitStore(), new MemoryRateLimitStore()], [100, 5]);
    const res = await fetch(`${base}/x`, { headers: { 'x-key': 't' } });
    expect(res.headers.get('ratelimit-limit')).toBe('5');
    expect(res.headers.get('ratelimit-remaining')).toBe('4');
  });

  it('counts in memory when Redis fails, and keeps answering', async () => {
    const redis = new FakeRedis();
    redis.failNext = true;
    const base = await serve([new RedisRateLimitStore(redis)], [5]);
    const res = await fetch(`${base}/x`, { headers: { 'x-key': 'redis-down' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('ratelimit-remaining')).toBe('4');
  });
});

describe('authFailureGuard', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = null;
  });

  it('counts only failed authentications, then refuses the address', async () => {
    const guard = authFailureGuard({ name: 'af', limit: 2, windowMs: WINDOW, keyFn: () => 'ip-1', store: new MemoryRateLimitStore() });
    const app = express();
    app.use(requestId);
    app.use(asyncHandler(guard.check));
    app.get('/x', asyncHandler(async (req, res) => {
      if (req.headers['x-ok'] === '1') {
        res.json({ ok: true });
        return;
      }
      await guard.record(req);
      res.status(401).json({});
    }));
    app.use(publicErrorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

    // Good requests never spend the budget.
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/x`, { headers: { 'x-ok': '1' } })).status).toBe(200);
    expect((await fetch(`${base}/x`)).status).toBe(401);
    expect((await fetch(`${base}/x`)).status).toBe(401);
    const refused = await fetch(`${base}/x`, { headers: { 'x-ok': '1' } });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).not.toBeNull();
  });
});
