import { debugBus } from '../debugBus.js';
import { getSupabaseServiceClient, isSupabaseConfigured } from '../supabase.js';

/**
 * Talyn's store for a session's saved work: Supabase Storage, in ONE private
 * bucket, reached only from the backend with the service-role key. No public
 * URL and no signed URL is ever made, so neither a client nor a sandbox can
 * reach an object; every byte goes through the backend.
 *
 * The bucket must exist (see docs/SETUP.md). The backend never creates it.
 */

export const WORK_STORAGE_BUCKET = 'workbench-work';

export class WorkStorageUnavailableError extends Error {
  constructor(message = 'Talyn storage is not configured, so the session work could not be saved.') {
    super(message);
    this.name = 'WorkStorageUnavailableError';
  }
}

export interface WorkObjectStore {
  /** Write the object, replacing one at the same key. */
  put(key: string, body: Buffer): Promise<void>;
  /** The object, or null when there is none. */
  get(key: string): Promise<Buffer | null>;
  /** Delete the objects. Missing ones are not an error. */
  remove(keys: string[]): Promise<void>;
  /** The object keys directly under `prefix` (one level, folders excluded) and the folder names. */
  list(prefix: string): Promise<{ files: string[]; folders: string[] }>;
}

function isNotFound(err: unknown): boolean {
  const e = err as { status?: unknown; statusCode?: unknown; message?: unknown } | null;
  return String(e?.statusCode) === '404' || e?.status === 404 || /not.?found/i.test(String(e?.message ?? ''));
}

/** Every storage call goes through here, so the Debug panel sees each one. */
async function timed<T>(method: string, key: string, work: () => Promise<{ value: T; status?: number; bytes?: number }>): Promise<T> {
  const started = Date.now();
  try {
    const { value, status, bytes } = await work();
    debugBus.recordHttp({
      service: 'supabase_storage', method, url: `/storage/${WORK_STORAGE_BUCKET}/${key}`,
      status: status ?? 200, durationMs: Date.now() - started, ok: true, ...(bytes !== undefined ? { bytes } : {}),
    });
    return value;
  } catch (err) {
    debugBus.recordHttp({
      service: 'supabase_storage', method, url: `/storage/${WORK_STORAGE_BUCKET}/${key}`,
      durationMs: Date.now() - started, ok: false, error: err,
    });
    throw err;
  }
}

const supabaseStore: WorkObjectStore = {
  put: (key, body) => timed('PUT', key, async () => {
    const { error } = await getSupabaseServiceClient().storage.from(WORK_STORAGE_BUCKET)
      .upload(key, body, { upsert: true, contentType: 'application/octet-stream' });
    if (error) throw error;
    return { value: undefined, bytes: body.length };
  }),
  get: (key) => timed('GET', key, async () => {
    const { data, error } = await getSupabaseServiceClient().storage.from(WORK_STORAGE_BUCKET).download(key);
    if (error) {
      if (isNotFound(error)) return { value: null, status: 404 };
      throw error;
    }
    const body = Buffer.from(await data.arrayBuffer());
    return { value: body, bytes: body.length };
  }),
  remove: (keys) => keys.length === 0 ? Promise.resolve() : timed('DELETE', keys[0], async () => {
    const { error } = await getSupabaseServiceClient().storage.from(WORK_STORAGE_BUCKET).remove(keys);
    if (error && !isNotFound(error)) throw error;
    return { value: undefined };
  }),
  list: (prefix) => timed('LIST', prefix, async () => {
    const { data, error } = await getSupabaseServiceClient().storage.from(WORK_STORAGE_BUCKET).list(prefix, { limit: 1000 });
    if (error) {
      if (isNotFound(error)) return { value: { files: [], folders: [] } };
      throw error;
    }
    const files: string[] = [];
    const folders: string[] = [];
    // A folder is a prefix, not an object: Storage lists it with no id.
    for (const entry of data ?? []) (entry.id ? files : folders).push(`${prefix}/${entry.name}`);
    return { value: { files, folders } };
  }),
};

const unavailableStore: WorkObjectStore = {
  put: () => Promise.reject(new WorkStorageUnavailableError()),
  get: () => Promise.reject(new WorkStorageUnavailableError()),
  remove: () => Promise.reject(new WorkStorageUnavailableError()),
  list: () => Promise.reject(new WorkStorageUnavailableError()),
};

let override: WorkObjectStore | null = null;

/** Tests swap in a fake store; production never calls this. */
export function setWorkObjectStoreForTests(store: WorkObjectStore | null): void {
  override = store;
}

export function workObjectStore(): WorkObjectStore {
  if (override) return override;
  return isSupabaseConfigured() ? supabaseStore : unavailableStore;
}

/** An in-memory store, for tests and local experiments. */
export function memoryWorkObjectStore(): WorkObjectStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    put: async (key, body) => { objects.set(key, Buffer.from(body)); },
    get: async (key) => objects.get(key) ?? null,
    remove: async (keys) => { for (const k of keys) objects.delete(k); },
    list: async (prefix) => {
      const files = new Set<string>();
      const folders = new Set<string>();
      for (const key of objects.keys()) {
        if (!key.startsWith(`${prefix}/`)) continue;
        const rest = key.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) files.add(key);
        else folders.add(`${prefix}/${rest.slice(0, slash)}`);
      }
      return { files: [...files], folders: [...folders] };
    },
  };
}
