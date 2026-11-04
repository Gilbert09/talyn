import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { WorkbenchChangedFile, WorkbenchChanges, WorkbenchDiffScope } from '@talyn/shared';
import type { WorkbenchRow } from './store.js';
import { WorkStorageUnavailableError, workObjectStore } from './workStorage.js';

/**
 * The stored copy of a session's changes, in Talyn's storage next to the
 * saved work. `changesCapture.ts` writes it; the read paths in
 * `changesStored.ts` serve it while the box sleeps.
 *
 *   <ws>/<wb>/changes/meta.json                  replaced last; names the generation
 *   <ws>/<wb>/changes/<gen>/lists.json           the changes list (WorkbenchChanges)
 *   <ws>/<wb>/changes/<gen>/index.json           where each file starts in each patch
 *   <ws>/<wb>/changes/<gen>/contents-index.json  each changed file: its size, and whether its content is stored
 *   <ws>/<wb>/changes/<gen>/<object>/part-00000  2 MiB parts of a gzip object
 *   <ws>/<wb>/changes/snapshot.json              the older list-only copy (changesSnapshot.ts)
 *   <ws>/<wb>/changes/config.json                the last script config read from the box
 *
 * A reader always finds a whole generation: the parts go first, then
 * `meta.json`, then the old generation is deleted.
 */

export const CHANGES_OBJECTS = ['patch', 'patch-uncommitted', 'patch-committed', 'files', 'contents'] as const;
export type ChangesObjectName = (typeof CHANGES_OBJECTS)[number];

export type StoredObject =
  /** `from`: the same bytes as another object of the generation, stored once under its name. */
  | { parts: number; bytes: number; sha256: string; raw: number; from?: ChangesObjectName }
  /** Not stored: the raw object was over its cap. `raw` is at least this many bytes. */
  | { tooLarge: number };

export interface ChangesMeta {
  version: 2;
  generation: string;
  takenAt: string;
  sandboxId: string;
  mergeBase: string;
  headSha: string;
  treeSha: string;
  etag: string;
  /** The hash of the list (see {@link listsKey}), to tell a later list read that found other changes. */
  listsKey: string;
  objects: Partial<Record<ChangesObjectName, StoredObject>>;
  /** Set when a later list read found other changes than this copy: its patches are out of date. */
  listNewer?: string;
}

export interface PatchIndexEntry {
  path: string;
  oldPath?: string;
  /** git's one-letter status: A, M, D, R, C, T. */
  status: string;
  offset: number;
  length: number;
}

export type PatchIndex = Partial<Record<WorkbenchDiffScope, PatchIndexEntry[]>>;

type Keyed = Pick<WorkbenchRow, 'workspaceId' | 'id'>;

export const changesPrefix = (row: Keyed) => `${row.workspaceId}/${row.id}/changes`;
export const changesMetaKey = (row: Keyed) => `${changesPrefix(row)}/meta.json`;
export const changesConfigKey = (row: Keyed) => `${changesPrefix(row)}/config.json`;
export const generationPrefix = (row: Keyed, generation: string) => `${changesPrefix(row)}/${generation}`;
export const listsKeyOf = (row: Keyed, generation: string) => `${generationPrefix(row, generation)}/lists.json`;
export const indexKeyOf = (row: Keyed, generation: string) => `${generationPrefix(row, generation)}/index.json`;
export const contentsIndexKeyOf = (row: Keyed, generation: string) => `${generationPrefix(row, generation)}/contents-index.json`;
export const objectPartKey = (row: Keyed, generation: string, name: ChangesObjectName, i: number) =>
  `${generationPrefix(row, generation)}/${name}/part-${String(i).padStart(5, '0')}`;

/** The etag of a capture: 16 hex characters of the four facts that fix its content. */
export function changesEtag(sandboxId: string, mergeBase: string, headSha: string, treeSha: string): string {
  return createHash('sha256').update(`${sandboxId}|${mergeBase}|${headSha}|${treeSha}`).digest('hex').slice(0, 16);
}

/** The hash a list read and a capture of the same work agree on. */
export function listsKey(changes: Pick<WorkbenchChanges, 'files' | 'uncommitted' | 'committed' | 'base' | 'headSha'>): string {
  const files = (list: WorkbenchChangedFile[] | undefined) =>
    (list ?? []).map((f) => [f.path, f.oldPath ?? '', f.status, f.added, f.removed, f.binary]);
  return createHash('sha256')
    .update(JSON.stringify([changes.base, changes.headSha, files(changes.files), files(changes.uncommitted), files(changes.committed)]))
    .digest('hex')
    .slice(0, 32);
}

// ============================================================================
// Caches: meta and lists per (workbench, etag) for a minute; objects in a bounded LRU
// ============================================================================

const META_TTL_MS = 60_000;
const OBJECT_TTL_MS = 5 * 60_000;
/** Decompressed objects kept in memory, in all. One large patch is 20 MiB. */
const OBJECT_CACHE_BYTES = 64 * 1024 * 1024;

const metaCache = new Map<string, { at: number; meta: ChangesMeta | null }>();
const jsonCache = new Map<string, { at: number; value: unknown }>();
const objectCache = new Map<string, { at: number; body: Buffer }>();
let objectCacheBytes = 0;

export function resetChangesStoreForTests(): void {
  metaCache.clear();
  jsonCache.clear();
  objectCache.clear();
  objectCacheBytes = 0;
}

function parseMeta(raw: Buffer): ChangesMeta | null {
  const meta = JSON.parse(raw.toString('utf8')) as ChangesMeta;
  if (meta?.version !== 2 || typeof meta.generation !== 'string' || typeof meta.etag !== 'string' || !meta.objects) return null;
  return meta;
}

/**
 * The newest capture's meta, or null. `row.changesEtag` is read from the
 * database on every request, so a copy written by another process is seen at
 * once: a cached meta with another etag is read again.
 */
export async function readChangesMeta(
  row: Keyed & Partial<Pick<WorkbenchRow, 'changesEtag'>>,
  opts: { fresh?: boolean } = {},
): Promise<ChangesMeta | null> {
  const now = Date.now();
  const cached = metaCache.get(row.id);
  const usable = cached && !opts.fresh && now - cached.at < META_TTL_MS
    && (!row.changesEtag || cached.meta?.etag === row.changesEtag);
  if (cached && usable) return cached.meta;
  let meta: ChangesMeta | null = null;
  try {
    const raw = await workObjectStore().get(changesMetaKey(row));
    meta = raw ? parseMeta(raw) : null;
  } catch (err) {
    if (err instanceof WorkStorageUnavailableError) return null;
    console.warn(`[workbench] reading the stored changes of ${row.id} failed:`, err);
    return null;
  }
  metaCache.set(row.id, { at: now, meta });
  if (metaCache.size > 5000) metaCache.delete(metaCache.keys().next().value!);
  return meta;
}

export async function writeChangesMeta(row: Keyed, meta: ChangesMeta): Promise<void> {
  await workObjectStore().put(changesMetaKey(row), Buffer.from(JSON.stringify(meta)));
  metaCache.set(row.id, { at: Date.now(), meta });
}

/** A small JSON object of a generation, cached with it. Null when it is missing or not readable. */
export async function readGenerationJson<T>(key: string): Promise<T | null> {
  const cached = jsonCache.get(key);
  if (cached && Date.now() - cached.at < META_TTL_MS) return cached.value as T;
  try {
    const raw = await workObjectStore().get(key);
    if (!raw) return null;
    const value = JSON.parse(raw.toString('utf8')) as T;
    jsonCache.set(key, { at: Date.now(), value });
    if (jsonCache.size > 2000) jsonCache.delete(jsonCache.keys().next().value!);
    return value;
  } catch (err) {
    if (!(err instanceof WorkStorageUnavailableError)) console.warn(`[workbench] reading ${key} failed:`, err);
    return null;
  }
}

/**
 * A stored object, decompressed. Null when it is not stored. Throws when a
 * part is missing or the checksum is wrong: that copy cannot be trusted.
 */
export async function readChangesObject(row: Keyed, meta: ChangesMeta, name: ChangesObjectName): Promise<Buffer | null> {
  const stored = meta.objects[name];
  if (!stored || !('parts' in stored)) return null;
  const cacheKey = `${row.id}:${meta.generation}:${name}`;
  const hit = objectCache.get(cacheKey);
  const now = Date.now();
  if (hit && now - hit.at < OBJECT_TTL_MS) {
    // Most recently used goes last.
    objectCache.delete(cacheKey);
    objectCache.set(cacheKey, hit);
    return hit.body;
  }
  const store = workObjectStore();
  const parts: Buffer[] = [];
  const hash = createHash('sha256');
  for (let i = 0; i < stored.parts; i++) {
    const part = await store.get(objectPartKey(row, meta.generation, stored.from ?? name, i));
    if (!part) throw new Error(`part ${i + 1} of ${stored.parts} of the stored ${name} is missing`);
    hash.update(part);
    parts.push(part);
  }
  if (hash.digest('hex') !== stored.sha256) throw new Error(`the stored ${name} does not match its checksum`);
  const body = gunzipSync(Buffer.concat(parts));
  remember(cacheKey, body, now);
  return body;
}

function remember(key: string, body: Buffer, now: number): void {
  if (body.length > OBJECT_CACHE_BYTES / 2) return;
  const old = objectCache.get(key);
  if (old) objectCacheBytes -= old.body.length;
  objectCache.set(key, { at: now, body });
  objectCacheBytes += body.length;
  for (const [k, entry] of objectCache) {
    if (objectCacheBytes <= OBJECT_CACHE_BYTES && now - entry.at < OBJECT_TTL_MS) break;
    objectCache.delete(k);
    objectCacheBytes -= entry.body.length;
  }
}

/** Every key under `prefix`, at any depth. */
async function keysUnder(prefix: string): Promise<string[]> {
  const store = workObjectStore();
  const { files, folders } = await store.list(prefix);
  const keys = [...files];
  for (const folder of folders) keys.push(...(await keysUnder(folder)));
  return keys;
}

/** Delete one generation's objects. */
export async function deleteGeneration(row: Keyed, generation: string): Promise<void> {
  const keys = await keysUnder(generationPrefix(row, generation));
  for (let i = 0; i < keys.length; i += 100) await workObjectStore().remove(keys.slice(i, i + 100));
}

/** Delete every stored copy of the session's changes. Meta goes last, so a reader never finds a meta without its parts. */
export async function deleteAllChanges(row: Keyed): Promise<void> {
  metaCache.delete(row.id);
  try {
    const keys = await keysUnder(changesPrefix(row));
    const meta = changesMetaKey(row);
    const rest = keys.filter((k) => k !== meta);
    for (let i = 0; i < rest.length; i += 100) await workObjectStore().remove(rest.slice(i, i + 100));
    await workObjectStore().remove([meta]);
  } catch (err) {
    if (!(err instanceof WorkStorageUnavailableError)) throw err;
  }
}

/**
 * A list read of the box found other changes than the stored copy: its
 * patches no longer match. Marks the meta so the diff read does not serve
 * them; the next capture replaces it. Best effort.
 */
export function noteListRead(row: Keyed & Partial<Pick<WorkbenchRow, 'changesEtag'>>, changes: WorkbenchChanges): Promise<void> {
  return withChangesLock(row.id, async () => {
    const cached = await readChangesMeta(row);
    if (!cached || cached.listNewer || listsKey(changes) === cached.listsKey) return;
    // Read it again, uncached: a capture may have replaced it, and its meta must not be put back.
    const meta = await readChangesMeta(row, { fresh: true });
    if (!meta || meta.listNewer || meta.generation !== cached.generation) return;
    await writeChangesMeta(row, { ...meta, listNewer: new Date().toISOString() });
  });
}

const locks = new Map<string, Promise<unknown>>();

/** Writes of one session's stored changes run one at a time in this process, in call order. */
export function withChangesLock<T>(workbenchId: string, work: () => Promise<T>): Promise<T> {
  const next = (locks.get(workbenchId) ?? Promise.resolve()).catch(() => undefined).then(work);
  locks.set(workbenchId, next);
  void next.catch(() => undefined).finally(() => {
    if (locks.get(workbenchId) === next) locks.delete(workbenchId);
  });
  return next;
}

/** The live answer for the Run panel, kept so it shows while the box sleeps. Best effort. */
export async function storeConfig(row: Keyed, config: unknown): Promise<void> {
  try {
    await workObjectStore().put(changesConfigKey(row), Buffer.from(JSON.stringify({ version: 1, takenAt: new Date().toISOString(), config })));
    jsonCache.delete(changesConfigKey(row));
  } catch (err) {
    if (!(err instanceof WorkStorageUnavailableError)) console.warn(`[workbench] storing the config of ${row.id} failed:`, err);
  }
}
