import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { WSEvent } from '@talyn/shared';
import { createRedisConnection, isRedisEnabled } from './redis.js';

/**
 * Cross-replica WebSocket fan-out over Redis Pub/Sub.
 *
 * The desktop holds a single WS connection to ONE backend replica, but the work
 * that produces a broadcast (a webhook-driven PR refresh, a merge-queue tick)
 * can run on ANY replica. Without a shared channel, an event computed on replica
 * A never reaches a client connected to replica B. This module bridges that gap:
 * every `broadcast` / `broadcastToWorkspace` in websocket.ts both delivers to
 * its own local clients AND publishes the event here; each replica's subscriber
 * re-delivers incoming events to its local clients.
 *
 * A stable per-process {@link REPLICA_ID} tags every published envelope so the
 * originating replica ignores its own message (it already delivered locally) —
 * no double-send.
 *
 * When `REDIS_URL` is unset this is inert: publish is a no-op and websocket.ts
 * falls back to pure local delivery (the historical single-process behaviour).
 */

const CHANNEL = 'ws:broadcast';

/**
 * Stable id for this backend process. Used to drop an envelope this replica
 * published (it delivered to its own clients before publishing).
 */
export const REPLICA_ID = `${process.env.HOSTNAME || 'local'}:${process.pid}:${randomUUID().slice(0, 8)}`;

type Envelope =
  | { replicaId: string; scope: 'all'; event: WSEvent }
  | { replicaId: string; scope: 'workspace'; workspaceId: string; event: WSEvent }
  | { replicaId: string; scope: 'user'; userId: string; event: WSEvent };

/**
 * How wsBus delivers a remotely-received event to THIS replica's local clients.
 * websocket.ts owns the client registry, so it injects these (the same internal
 * delivery functions its own public broadcasters use). Injection — rather than
 * importing websocket.ts here — keeps the dependency one-directional
 * (websocket → wsBus) with no cycle.
 */
export interface LocalDelivery {
  all: (event: WSEvent) => void;
  workspace: (workspaceId: string, event: WSEvent) => void;
  user: (userId: string, event: WSEvent) => void;
}

let pub: Redis | null = null;
let sub: Redis | null = null;
let localDeliver: LocalDelivery | null = null;

export function setLocalDelivery(delivery: LocalDelivery): void {
  localDeliver = delivery;
}

/** Connect the publisher + subscriber and start consuming remote broadcasts. */
export function initWsBus(): void {
  if (!isRedisEnabled()) {
    console.log('[wsBus] REDIS_URL unset — cross-replica WS fan-out disabled (single-process mode)');
    return;
  }
  pub = createRedisConnection('wsbus-pub');
  sub = createRedisConnection('wsbus-sub');
  if (!sub) return;

  sub.subscribe(CHANNEL).catch((err) => {
    console.error('[wsBus] subscribe failed:', err);
  });
  sub.on('message', (_channel: string, raw: string) => {
    dispatchIncoming(raw);
  });

  console.log(`[wsBus] cross-replica WS fan-out enabled (replica ${REPLICA_ID})`);
}

/**
 * Decode a published envelope and deliver it to local clients. Drops our own
 * publishes (already delivered locally), malformed payloads, and anything that
 * arrives before a local-delivery sink is registered. Exported for tests.
 */
export function dispatchIncoming(raw: string): 'self' | 'delivered' | 'invalid' | 'no-sink' {
  let env: Envelope;
  try {
    env = JSON.parse(raw) as Envelope;
  } catch {
    return 'invalid';
  }
  if (env.replicaId === REPLICA_ID) return 'self';
  if (!localDeliver) return 'no-sink';
  if (env.scope === 'all') localDeliver.all(env.event);
  else if (env.scope === 'user') localDeliver.user(env.userId, env.event);
  else localDeliver.workspace(env.workspaceId, env.event);
  return 'delivered';
}

/** Publish an all-clients broadcast to the other replicas. No-op when disabled. */
export function publishBroadcast(event: WSEvent): void {
  if (!pub || event.type === 'debug:event') return;
  const env: Envelope = { replicaId: REPLICA_ID, scope: 'all', event };
  void pub.publish(CHANNEL, JSON.stringify(env)).catch(() => undefined);
}

/** Publish a workspace-scoped broadcast to the other replicas. No-op when disabled. */
export function publishToWorkspace(workspaceId: string, event: WSEvent): void {
  if (!pub || event.type === 'debug:event') return;
  const env: Envelope = { replicaId: REPLICA_ID, scope: 'workspace', workspaceId, event };
  void pub.publish(CHANNEL, JSON.stringify(env)).catch(() => undefined);
}

/** Publish a user-scoped broadcast to the other replicas. No-op when disabled. */
export function publishToUser(userId: string, event: WSEvent): void {
  if (!pub || event.type === 'debug:event') return;
  const env: Envelope = { replicaId: REPLICA_ID, scope: 'user', userId, event };
  void pub.publish(CHANNEL, JSON.stringify(env)).catch(() => undefined);
}

export async function shutdownWsBus(): Promise<void> {
  await Promise.allSettled([pub?.quit(), sub?.quit()]);
  pub = null;
  sub = null;
}
