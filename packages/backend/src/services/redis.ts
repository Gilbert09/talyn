import Redis, { type RedisOptions } from 'ioredis';
import { debugBus } from './debugBus.js';

/**
 * Shared Redis connection layer.
 *
 * Redis is the cross-replica backbone: a Pub/Sub channel fans WebSocket
 * broadcasts out to every backend instance (see wsBus.ts), and — once webhooks
 * land — a Stream is the durable ingest queue. It is OPTIONAL: when `REDIS_URL`
 * is unset (typical single-process local dev), every helper here degrades to a
 * no-op and the app runs exactly as it did before, just without cross-replica
 * fan-out. This keeps `npm run dev` working with nothing but the Supabase
 * stack, while production sets `REDIS_URL` to light the whole thing up.
 *
 * Pub/Sub and blocking stream reads each need their OWN connection (a client in
 * subscriber mode can't issue normal commands; a blocking XREAD ties up its
 * socket), so callers that need those use {@link createRedisConnection} rather
 * than sharing {@link getRedis}.
 */

export function redisUrl(): string | undefined {
  return process.env.REDIS_URL || undefined;
}

export function isRedisEnabled(): boolean {
  return Boolean(redisUrl());
}

const baseOptions: RedisOptions = {
  // Let commands ride out a reconnect rather than failing fast — and required
  // for blocking stream reads (XREADGROUP ... BLOCK) on dedicated connections.
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  // Capped exponential backoff so a Redis outage doesn't hammer the host.
  retryStrategy: (times: number) => Math.min(times * 200, 5_000),
};

let shared: Redis | null = null;
let sharedAttempted = false;

/**
 * The shared command connection (publish, XADD, etc.). Lazily created on first
 * use; returns null when Redis is disabled. Do NOT use this for subscribing or
 * blocking reads — use {@link createRedisConnection}.
 */
export function getRedis(): Redis | null {
  if (!isRedisEnabled()) return null;
  if (!shared && !sharedAttempted) {
    sharedAttempted = true;
    shared = new Redis(redisUrl()!, baseOptions);
    wireConnectionEvents(shared, 'shared');
  }
  return shared;
}

/**
 * A fresh, independent connection — for Pub/Sub subscribers and blocking stream
 * consumers that can't share the command connection. Returns null when Redis is
 * disabled. The caller owns the connection's lifecycle (quit on shutdown).
 */
export function createRedisConnection(role: string): Redis | null {
  if (!isRedisEnabled()) return null;
  const conn = new Redis(redisUrl()!, baseOptions);
  wireConnectionEvents(conn, role);
  return conn;
}

/**
 * Surface connection lifecycle on the Debug bus, but only on state changes —
 * ioredis emits `error` repeatedly while reconnecting, and recording every one
 * would flood the ring buffer during an outage.
 */
function wireConnectionEvents(conn: Redis, role: string): void {
  let errored = false;
  conn.on('ready', () => {
    errored = false;
    debugBus.recordEvent({ service: 'redis', action: 'ready', summary: `redis ${role} ready` });
  });
  conn.on('close', () => {
    debugBus.recordEvent({ service: 'redis', action: 'close', summary: `redis ${role} closed` });
  });
  conn.on('error', (err: Error) => {
    if (errored) return;
    errored = true;
    console.error(`[redis] ${role} error:`, err.message);
    debugBus.recordEvent({
      service: 'redis',
      action: 'error',
      ok: false,
      summary: `redis ${role} error: ${err.message}`,
    });
  });
}

/** Close the shared connection on shutdown. Dedicated connections quit themselves. */
export async function closeRedis(): Promise<void> {
  if (shared) {
    await shared.quit().catch(() => undefined);
    shared = null;
    sharedAttempted = false;
  }
}
