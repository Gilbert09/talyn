import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { ReviewRankingArchive } from '@talyn/client';

const now = Date.parse('2026-09-21T12:00:00Z');
const props = (snapshot = 'snapshot', workspace = 'workspace', extra: Record<string, unknown> = {}) => ({
  workspace_id: workspace, snapshot_id: snapshot, ...extra,
});

describe('local ranking archive', () => {
  it('survives a new instance and preserves independent workspaces', async () => {
    const factory = new IDBFactory();
    const archive = new ReviewRankingArchive(() => factory);
    await archive.append('queue', props(), now);
    await archive.append('queue', props('snapshot', 'other'), now);
    const reopened = new ReviewRankingArchive(() => factory);
    expect((await reopened.read('workspace', now)).events).toHaveLength(1);
    expect((await reopened.read('other', now)).events).toHaveLength(1);
    expect((await reopened.read('absent', now)).events).toEqual([]);
  });

  it('serializes concurrent instances without losing chunks or observations', async () => {
    const factory = new IDBFactory();
    const first = new ReviewRankingArchive(() => factory);
    const second = new ReviewRankingArchive(() => factory);
    const writes = Array.from({ length: 20 }, (_, index) => (
      (index % 2 ? first : second).append('chunk', props('snapshot', 'workspace', { index }), now)
    ));
    expect((await Promise.all(writes)).every(Boolean)).toBe(true);
    const data = await first.read('workspace', now);
    expect(data.events).toHaveLength(20);
    expect(new Set(data.events.map((event) => event.properties.index)).size).toBe(20);
    expect(data.archive.failed_writes).toBe(0);
  });

  it('waits for pending writes and freezes properties before the asynchronous write', async () => {
    const factory = new IDBFactory();
    const archive = new ReviewRankingArchive(() => factory);
    const properties: Record<string, unknown> = props('snapshot', 'workspace', { value: 'original' });
    void archive.append('queue', properties, now);
    properties.value = 'changed';
    expect((await archive.read('workspace', now)).events[0].properties.value).toBe('original');
  });

  it('evicts whole snapshots, including their observations, under the size limit', async () => {
    const factory = new IDBFactory();
    const archive = new ReviewRankingArchive(() => factory, { maxChars: 450 });
    await archive.append('queue', props('old', 'workspace', { text: 'x'.repeat(100) }), now);
    await archive.append('visible', props('old'), now + 1);
    await archive.append('queue', props('new', 'workspace', { text: 'x'.repeat(100) }), now + 2);
    const data = await archive.read('workspace', now + 2);
    expect(data.events.map((event) => event.properties.snapshot_id)).toEqual(['new']);
    expect(data.archive.size_evicted).toBe(1);
  });

  it('expires groups at their first event, without extending them through later observations', async () => {
    const factory = new IDBFactory();
    const archive = new ReviewRankingArchive(() => factory, { maxAgeMs: 100 });
    await archive.append('queue', props('old'), now);
    await archive.append('visible', props('old'), now + 50);
    expect((await archive.read('workspace', now + 100)).events).toEqual([]);
    await archive.append('queue', props('new'), now + 100);
    const data = await archive.read('workspace', now + 100);
    expect(data.events.map((event) => event.properties.snapshot_id)).toEqual(['new']);
    expect(data.archive.expired).toBe(1);
  });

  it('refuses oversized groups and reports the eviction', async () => {
    const factory = new IDBFactory();
    const archive = new ReviewRankingArchive(() => factory, { maxChars: 10 });
    expect(await archive.append('queue', props(), now)).toBe(false);
    const data = await archive.read('workspace', now);
    expect(data.events).toEqual([]);
    expect(data.archive.size_evicted).toBe(1);
  });

  it('recovers after storage failure without breaking later writes', async () => {
    const factory = new IDBFactory();
    let unavailable = true;
    const archive = new ReviewRankingArchive(() => {
      if (unavailable) throw new Error('storage blocked');
      return factory;
    });
    expect(await archive.append('queue', props(), now)).toBe(false);
    unavailable = false;
    expect(await archive.append('queue', props(), now)).toBe(true);
    const data = await archive.read('workspace', now);
    expect(data.events).toHaveLength(1);
    expect(data.archive.failed_writes).toBe(1);
  });

  it('rolls back the complete group when a transaction aborts', async () => {
    const factory = new IDBFactory();
    const archive = new ReviewRankingArchive(() => factory);
    await archive.append('queue', props(), now);
    const original = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>
    ) {
      const request = original.apply(this, args);
      if (this.name === 'groups') request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    try {
      expect(await archive.append('visible', props(), now + 1)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    const data = await archive.read('workspace', now + 1);
    expect(data.events.map((event) => event.event)).toEqual(['queue']);
    expect(data.archive.failed_writes).toBe(1);
    expect(await archive.append('visible', props(), now + 2)).toBe(true);
    expect((await archive.read('workspace', now + 2)).events).toHaveLength(2);
  });

  it.each([{}, { workspace_id: 'workspace' }, { workspace_id: '', snapshot_id: 'snapshot' }])(
    'rejects missing identities: %j', async (properties) => {
      const archive = new ReviewRankingArchive(() => { throw new Error('must not open'); });
      expect(await archive.append('queue', properties, now)).toBe(false);
    },
  );
});
