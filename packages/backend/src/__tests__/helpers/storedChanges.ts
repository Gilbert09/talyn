import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { WorkbenchChanges } from '@talyn/shared';
import {
  changesEtag,
  changesMetaKey,
  contentsIndexKeyOf,
  indexKeyOf,
  listsKey,
  listsKeyOf,
  objectPartKey,
  type ChangesMeta,
  type ChangesObjectName,
} from '../../services/workbenches/changesStore.js';
import type { WorkObjectStore } from '../../services/workbenches/workStorage.js';

/**
 * Write a stored copy of a session's changes straight into a store, as a
 * capture would leave it, so a route test needs no repository.
 */
export interface StoredCopy {
  changes: WorkbenchChanges;
  patch?: string;
  patchUncommitted?: string;
  patchCommitted?: string;
  files?: string[];
  contents?: Record<string, string | Buffer | { size: number }>;
  tooLarge?: ChangesObjectName[];
  takenAt?: string;
  treeSha?: string;
}

export async function storeChangesCopy(
  store: WorkObjectStore,
  row: { workspaceId: string; id: string; sandboxId: string },
  copy: StoredCopy,
): Promise<ChangesMeta> {
  const generation = `g${Math.random().toString(36).slice(2, 8)}`;
  const objects: ChangesMeta['objects'] = {};
  const put = async (name: ChangesObjectName, raw: Buffer | undefined) => {
    if (copy.tooLarge?.includes(name)) {
      objects[name] = { tooLarge: 99_999_999 };
      return;
    }
    if (raw === undefined) return;
    const gz = gzipSync(raw);
    await store.put(objectPartKey(row, generation, name, 0), gz);
    objects[name] = { parts: 1, bytes: gz.length, sha256: createHash('sha256').update(gz).digest('hex'), raw: raw.length };
  };
  const text = (s: string | undefined) => (s === undefined ? undefined : Buffer.from(s));
  await put('patch', text(copy.patch));
  await put('patch-uncommitted', text(copy.patchUncommitted));
  await put('patch-committed', text(copy.patchCommitted));
  await put('files', copy.files ? Buffer.from(copy.files.map((f) => `${f}\0`).join('')) : undefined);
  if (copy.contents) {
    const entries: Array<{ path: string; size: number; stored: boolean }> = [];
    const body: Buffer[] = [];
    for (const [path, value] of Object.entries(copy.contents)) {
      if (typeof value === 'object' && !Buffer.isBuffer(value)) {
        entries.push({ path, size: value.size, stored: false });
        continue;
      }
      const bytes = Buffer.from(value);
      entries.push({ path, size: bytes.length, stored: true });
      body.push(Buffer.from(`${'e'.repeat(40)} blob ${bytes.length}\n`), bytes, Buffer.from('\n'));
    }
    await put('contents', Buffer.concat(body));
    await store.put(contentsIndexKeyOf(row, generation), Buffer.from(JSON.stringify(entries)));
  }
  await store.put(listsKeyOf(row, generation), Buffer.from(JSON.stringify(copy.changes)));
  await store.put(indexKeyOf(row, generation), Buffer.from('{}'));
  const treeSha = copy.treeSha ?? 'f'.repeat(40);
  const meta: ChangesMeta = {
    version: 2,
    generation,
    takenAt: copy.takenAt ?? '2026-11-01T10:00:00.000Z',
    sandboxId: row.sandboxId,
    mergeBase: copy.changes.base,
    headSha: copy.changes.headSha,
    treeSha,
    etag: changesEtag(row.sandboxId, copy.changes.base, copy.changes.headSha, treeSha),
    listsKey: listsKey(copy.changes),
    objects,
  };
  await store.put(changesMetaKey(row), Buffer.from(JSON.stringify(meta)));
  return meta;
}
