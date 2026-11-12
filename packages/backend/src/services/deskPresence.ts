import type { Redis } from 'ioredis';
import { DESK_PRESENCE_TTL_MS } from '@talyn/shared';
import { getRedis } from './redis.js';

/**
 * Per-user desk presence: is this person using Talyn on a computer right now?
 *
 * Each authenticated socket that says `active` holds one field, keyed by the
 * socket id, holding the time of its last beat. The person is at their desk
 * while any field is younger than the TTL. `away` and a closed socket remove
 * the field; a socket that stops beating (sleep, quit, network loss) ages out.
 *
 * With `REDIS_URL` the fields live in one hash per user, so every replica
 * answers the same; the key's own expiry clears a user who goes silent.
 * Without it they live in this process, which is the whole deployment.
 */
const PREFIX = 'talyn:desk:';
type RedisStore = Pick<Redis, 'hgetall' | 'eval'>;

// One script, so a field never exists without the key's expiry.
const SET_FIELD = `
if ARGV[2] == '' then
  redis.call('HDEL', KEYS[1], ARGV[1])
else
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
end
return 1
`;

export class DeskPresenceStore {
  private memory = new Map<string, Map<string, number>>();
  private prunedAt = 0;

  constructor(
    private redis: () => RedisStore | null = getRedis,
    private now: () => number = () => Date.now(),
  ) {}

  /** Record what one socket reports. The user id comes from the socket's authentication, never the message. */
  async report(userId: string, socketId: string, active: boolean): Promise<void> {
    const redis = this.redis();
    if (redis) {
      await redis.eval(SET_FIELD, 1, PREFIX + userId, socketId, active ? String(this.now()) : '', String(DESK_PRESENCE_TTL_MS));
      return;
    }
    this.prune();
    let sockets = this.memory.get(userId);
    if (active) {
      if (!sockets) this.memory.set(userId, sockets = new Map());
      sockets.set(socketId, this.now());
    } else {
      sockets?.delete(socketId);
      if (sockets && !sockets.size) this.memory.delete(userId);
    }
  }

  /** A closed socket says nothing more. */
  async forget(userId: string, socketId: string): Promise<void> {
    await this.report(userId, socketId, false);
  }

  /** True while any of the user's sockets said `active` within the TTL. */
  async atDesk(userId: string): Promise<boolean> {
    return (await this.inspect(userId)).atDesk;
  }

  /** The answer plus what it rests on, for the dispatch log: how many sockets beat, and the newest beat's age. */
  async inspect(userId: string): Promise<{ atDesk: boolean; sockets: number; newestAgeMs: number | null }> {
    const redis = this.redis();
    const beats = (redis
      ? Object.values(await redis.hgetall(PREFIX + userId)).map(Number)
      : [...(this.memory.get(userId)?.values() ?? [])]).filter(Number.isFinite);
    const now = this.now();
    const newestAgeMs = beats.length ? now - Math.max(...beats) : null;
    return { atDesk: newestAgeMs !== null && newestAgeMs < DESK_PRESENCE_TTL_MS, sockets: beats.length, newestAgeMs };
  }

  // Memory only: drop users whose sockets all went silent without closing.
  private prune(): void {
    const now = this.now();
    if (now - this.prunedAt < DESK_PRESENCE_TTL_MS) return;
    this.prunedAt = now;
    for (const [userId, sockets] of this.memory) {
      for (const [socketId, at] of sockets) if (now - at >= DESK_PRESENCE_TTL_MS) sockets.delete(socketId);
      if (!sockets.size) this.memory.delete(userId);
    }
  }
}

export const deskPresence = new DeskPresenceStore();
