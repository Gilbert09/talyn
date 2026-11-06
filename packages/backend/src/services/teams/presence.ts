import type { Redis } from 'ioredis';
import type { SpacePresenceMember } from '@talyn/shared';
import { getRedis } from '../redis.js';
import { debugBus } from '../debugBus.js';

export const PRESENCE_TTL_MS = 60_000;
const SWEEP_MS = 10_000;
const PREFIX = 'talyn:presence:';
const POLLER = 'space-presence';
type RecordValue = { member?: SpacePresenceMember; sockets: Record<string, number> };
type RedisStore = Pick<Redis, 'hget' | 'hgetall' | 'eval' | 'scan'>;

const COMPARE_AND_SET = `
local current = redis.call('HGET', KEYS[1], ARGV[1]) or ''
if current ~= ARGV[2] then return 0 end
if ARGV[3] == '' then
  redis.call('HDEL', KEYS[1], ARGV[1])
else
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
end
return 1
`;

function changed(a?: SpacePresenceMember, b?: SpacePresenceMember): boolean {
  return !a !== !b || a?.sessionId !== b?.sessionId || a?.state !== b?.state ||
    a?.githubLogin !== b?.githubLogin || a?.avatarUrl !== b?.avatarUrl;
}

export class PresenceStore {
  private memory = new Map<string, Map<string, string>>();

  constructor(
    private redis: () => RedisStore | null = getRedis,
    private onChange: (spaceId: string) => void = () => undefined,
  ) {}

  private async records(spaceId: string): Promise<Record<string, string>> {
    const redis = this.redis();
    return redis ? redis.hgetall(PREFIX + spaceId) : Object.fromEntries(this.memory.get(spaceId) ?? []);
  }

  private async update(
    spaceId: string,
    userId: string,
    edit: (record: RecordValue) => void,
  ): Promise<void> {
    const redis = this.redis();
    for (let attempt = 0; attempt < 16; attempt++) {
      const raw = redis ? await redis.hget(PREFIX + spaceId, userId) : this.memory.get(spaceId)?.get(userId);
      const previous = raw ? JSON.parse(raw) as RecordValue : undefined;
      const record: RecordValue = { member: previous?.member, sockets: { ...previous?.sockets } };
      for (const [id, at] of Object.entries(record.sockets)) {
        if (Date.now() - at >= PRESENCE_TTL_MS) delete record.sockets[id];
      }
      if (record.member && Date.now() - record.member.at >= PRESENCE_TTL_MS) delete record.member;
      edit(record);
      const connected = Object.keys(record.sockets).length > 0;
      const member = connected ? record.member : undefined;
      const next = connected ? JSON.stringify(record) : '';
      if (redis) {
        const saved = await redis.eval(COMPARE_AND_SET, 1, PREFIX + spaceId, userId, raw ?? '', next);
        if (!saved) continue;
      } else if (next) {
        let entries = this.memory.get(spaceId);
        if (!entries) this.memory.set(spaceId, entries = new Map());
        entries.set(userId, next);
      } else {
        const entries = this.memory.get(spaceId);
        entries?.delete(userId);
        if (!entries?.size) this.memory.delete(spaceId);
      }
      if (changed(previous?.member, member) || (member && previous?.member && Date.now() - previous.member.at >= PRESENCE_TTL_MS)) this.onChange(spaceId);
      return;
    }
    throw new Error('Presence update contention');
  }

  async connect(spaceId: string, userId: string, socketId: string): Promise<void> {
    await this.update(spaceId, userId, (record) => { record.sockets[socketId] = Date.now(); });
  }

  async heartbeat(spaceId: string, socketId: string, member: Omit<SpacePresenceMember, 'at'>): Promise<void> {
    await this.update(spaceId, member.userId, (record) => {
      record.sockets[socketId] = Date.now();
      record.member = { ...member, at: Date.now() };
    });
  }

  async disconnect(spaceId: string, userId: string, socketId: string): Promise<void> {
    await this.update(spaceId, userId, (record) => { delete record.sockets[socketId]; });
  }

  async snapshot(spaceId: string): Promise<SpacePresenceMember[]> {
    return Object.values(await this.records(spaceId)).flatMap((raw) => {
      const { member, sockets } = JSON.parse(raw) as RecordValue;
      const connected = Object.values(sockets).some((at) => Date.now() - at < PRESENCE_TTL_MS);
      return member && connected && Date.now() - member.at < PRESENCE_TTL_MS ? [member] : [];
    }).sort((a, b) => a.userId.localeCompare(b.userId));
  }

  async sweep(): Promise<void> {
    const redis = this.redis();
    const spaces = new Set(this.memory.keys());
    if (redis) {
      let cursor = '0';
      do {
        const page = await redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 100);
        cursor = page[0];
        for (const key of page[1]) spaces.add(key.slice(PREFIX.length));
      } while (cursor !== '0');
    }
    for (const spaceId of spaces) {
      for (const userId of Object.keys(await this.records(spaceId))) {
        await this.update(spaceId, userId, () => undefined);
      }
    }
  }
}

export function startPresenceSweep(store: PresenceStore): () => void {
  debugBus.registerPoller(POLLER, SWEEP_MS, 'Remove space presence after 60 seconds without a heartbeat.');
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    const start = Date.now();
    let error: unknown;
    void store.sweep().catch((err: unknown) => { error = err; }).finally(() => {
      running = false;
      debugBus.pollerTick(POLLER, { durationMs: Date.now() - start, ok: !error, error });
    });
  }, SWEEP_MS);
  timer.unref();
  return () => clearInterval(timer);
}
