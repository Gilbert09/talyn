import { vi } from 'vitest';

export function createPresenceRedis() {
  const hashes = new Map<string, Map<string, string>>();
  return {
    hashes,
    hget: vi.fn(async (key: string, field: string) => hashes.get(key)?.get(field) ?? null),
    hgetall: vi.fn(async (key: string) => Object.fromEntries(hashes.get(key) ?? [])),
    scan: vi.fn(async () => ['0', [...hashes.keys()]]),
    eval: vi.fn(async (_script: string, _count: number, key: string, field: string, before: string, after: string) => {
      let hash = hashes.get(key);
      if ((hash?.get(field) ?? '') !== before) return 0;
      if (after) {
        if (!hash) hashes.set(key, hash = new Map());
        hash.set(field, after);
      } else {
        hash?.delete(field);
        if (!hash?.size) hashes.delete(key);
      }
      return 1;
    }),
  };
}
