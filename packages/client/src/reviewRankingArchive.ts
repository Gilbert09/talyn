import type { ReviewRankingLocalEvent } from '@talyn/shared';

const MAX_AGE_MS = 30 * 86_400_000;
const MAX_CHARS = 50_000_000;
const DATABASE = 'talyn-review-ranking-archive-v1';

interface Group {
  key: string;
  workspace: string;
  at: number;
  chars: number;
  events: ReviewRankingLocalEvent[];
}
type Metadata = Omit<Group, 'events'>;
interface Losses {
  workspace: string;
  expired: number;
  sizeEvicted: number;
}

/** Local only. Each transaction keeps a snapshot and its metadata together. */
export class ReviewRankingArchive {
  private pending: Promise<unknown> = Promise.resolve();
  private failedWrites = 0;

  constructor(
    private factory: () => IDBFactory = () => indexedDB,
    private options: { database?: string; maxAgeMs?: number; maxChars?: number } = {},
  ) {}

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.factory().open(this.options.database ?? DATABASE, 1);
      let abandoned = false;
      const fail = () => {
        abandoned = true;
        clearTimeout(timer);
        reject(new Error('Local ranking archive is unavailable'));
      };
      const timer = setTimeout(fail, 5000);
      request.onerror = fail;
      request.onblocked = fail;
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of ['groups', 'metadata']) {
          db.createObjectStore(name, { keyPath: 'key' }).createIndex('workspace', 'workspace');
        }
        db.createObjectStore('losses', { keyPath: 'workspace' });
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (abandoned) return request.result.close();
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }

  append(event: string, properties: Record<string, unknown>, now = Date.now()): Promise<boolean> {
    let entry: ReviewRankingLocalEvent;
    try {
      if (typeof properties.workspace_id !== 'string' || !properties.workspace_id ||
          typeof properties.snapshot_id !== 'string' || !properties.snapshot_id || !Number.isFinite(now)) {
        return Promise.resolve(false);
      }
      entry = JSON.parse(JSON.stringify({ event, properties, stored_at: now }));
    } catch {
      this.failedWrites++;
      return Promise.resolve(false);
    }
    const write = this.pending.then(() => this.write(entry)).catch(() => {
      this.failedWrites++;
      return false;
    });
    this.pending = write;
    return write;
  }

  private async write(entry: ReviewRankingLocalEvent): Promise<boolean> {
    const db = await this.open();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const workspace = entry.properties.workspace_id as string;
        const key = JSON.stringify([workspace, entry.properties.snapshot_id]);
        const tx = db.transaction(['groups', 'metadata', 'losses'], 'readwrite');
        const groups = tx.objectStore('groups');
        const metadata = tx.objectStore('metadata');
        const losses = tx.objectStore('losses');
        const old = groups.get(key);
        const all = metadata.index('workspace').getAll(workspace);
        const counts = losses.get(workspace);
        let requests = 3;
        let retained = false;
        const ready = () => {
          if (--requests) return;
          const previous = old.result as Group | undefined;
          const events = [...(previous?.events ?? []), entry];
          const group: Group = {
            key, workspace, at: Math.min(previous?.at ?? entry.stored_at, entry.stored_at),
            chars: JSON.stringify(events).length, events,
          };
          const items: Metadata[] = (all.result as Metadata[]).filter((item) => item.key !== key);
          const { events: _events, ...meta } = group;
          items.push(meta);
          items.sort((left, right) => left.at - right.at || left.key.localeCompare(right.key));
          let chars = items.reduce((sum, item) => sum + item.chars, 0);
          const loss: Losses = counts.result ?? { workspace, expired: 0, sizeEvicted: 0 };
          const cutoff = entry.stored_at - (this.options.maxAgeMs ?? MAX_AGE_MS);
          const removed = new Set<string>();
          for (const item of items) {
            const expired = item.at <= cutoff;
            if (!expired && chars <= (this.options.maxChars ?? MAX_CHARS)) break;
            removed.add(item.key);
            groups.delete(item.key);
            metadata.delete(item.key);
            chars -= item.chars;
            if (expired) loss.expired++;
            else loss.sizeEvicted++;
          }
          retained = !removed.has(key);
          if (retained) {
            groups.put(group);
            metadata.put(meta);
          }
          losses.put(loss);
        };
        old.onsuccess = all.onsuccess = counts.onsuccess = ready;
        tx.oncomplete = () => resolve(retained);
        tx.onabort = () => reject(tx.error ?? new Error('Local ranking write failed'));
      });
    } finally {
      db.close();
    }
  }

  async read(workspace: string, now = Date.now()) {
    await this.pending;
    const db = await this.open();
    try {
      return await new Promise<{
        events: ReviewRankingLocalEvent[];
        archive: { max_age_ms: number; max_chars: number; expired: number; size_evicted: number; failed_writes: number };
      }>((resolve, reject) => {
        const tx = db.transaction(['groups', 'losses'], 'readonly');
        const request = tx.objectStore('groups').index('workspace').getAll(workspace);
        const counts = tx.objectStore('losses').get(workspace);
        tx.onabort = () => reject(tx.error ?? new Error('Local ranking read failed'));
        tx.oncomplete = () => {
          const maxAge = this.options.maxAgeMs ?? MAX_AGE_MS;
          const groups = request.result as Group[];
          const loss: Losses = counts.result ?? { workspace, expired: 0, sizeEvicted: 0 };
          const kept = groups.filter((group) => group.at > now - maxAge && group.at <= now);
          resolve({
            events: kept.sort((left, right) => left.at - right.at).flatMap((group) => group.events),
            archive: {
              max_age_ms: maxAge, max_chars: this.options.maxChars ?? MAX_CHARS,
              expired: loss.expired + groups.filter((group) => group.at <= now - maxAge).length,
              size_evicted: loss.sizeEvicted, failed_writes: this.failedWrites,
            },
          });
        };
      });
    } finally {
      db.close();
    }
  }
}
