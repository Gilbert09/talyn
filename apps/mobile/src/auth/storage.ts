export interface SecureDriver {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export class SecureStorageError extends Error {
  constructor() { super('Secure storage is not available. Unlock this device and try again.'); }
}

type Manifest = { revision: string; count: number };
const CHUNK_SIZE = 1800;
const MAX_CHUNKS = 256;

function manifest(value: unknown): Manifest {
  const item = value as Manifest;
  if (!item || !/^[a-zA-Z0-9-]{1,64}$/.test(item.revision) ||
    !Number.isInteger(item.count) || item.count < 1 || item.count > MAX_CHUNKS) throw new SecureStorageError();
  return item;
}

export class SecureSessionStorage {
  private tail: Promise<unknown> = Promise.resolve();
  private sealed = false;
  constructor(private driver: SecureDriver, private namespace: string, private revision: () => string) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation).catch(() => { throw new SecureStorageError(); });
    this.tail = result.catch(() => {});
    return result;
  }

  private key(key: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new SecureStorageError();
    return `${this.namespace}.${key}`;
  }

  private async current(key: string): Promise<Manifest | null> {
    const raw = await this.driver.getItemAsync(key);
    return raw === null ? null : manifest(JSON.parse(raw));
  }

  private async recover(key: string) {
    const raw = await this.driver.getItemAsync(`${key}.journal`);
    if (!raw) return;
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length > 2) throw new SecureStorageError();
    const current = await this.current(key);
    for (const entry of entries) {
      const item = manifest(entry);
      if (item.revision !== current?.revision) await this.deleteChunks(key, item);
    }
    await this.driver.deleteItemAsync(`${key}.journal`);
  }

  private async deleteChunks(key: string, item: Manifest) {
    for (let i = 0; i < item.count; i++) await this.driver.deleteItemAsync(`${key}.${item.revision}.${i}`);
  }

  getItem = (name: string): Promise<string | null> => this.serial(async () => {
    if (this.sealed) throw new SecureStorageError();
    const key = this.key(name);
    await this.recover(key);
    const item = await this.current(key);
    if (!item) return null;
    let raw = '';
    for (let i = 0; i < item.count; i++) {
      const chunk = await this.driver.getItemAsync(`${key}.${item.revision}.${i}`);
      if (chunk === null) throw new SecureStorageError();
      raw += chunk;
    }
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'string') throw new SecureStorageError();
    return value;
  });

  setItem = (name: string, value: string): Promise<void> => this.serial(async () => {
    if (this.sealed) throw new SecureStorageError();
    const key = this.key(name);
    await this.recover(key);
    const previous = await this.current(key);
    // ASCII chunks stay below SecureStore limits, including Unicode profile data.
    const raw = JSON.stringify(value).replace(/[^\x20-\x7e]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const next = manifest({ revision: this.revision(), count: Math.ceil(raw.length / CHUNK_SIZE) });
    await this.driver.setItemAsync(`${key}.journal`, JSON.stringify([...(previous ? [previous] : []), next]));
    for (let i = 0; i < next.count; i++) {
      await this.driver.setItemAsync(`${key}.${next.revision}.${i}`, raw.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
    }
    await this.driver.setItemAsync(key, JSON.stringify(next));
    await this.recover(key);
  });

  removeItem = (name: string): Promise<void> => this.serial(async () => {
    if (this.sealed) throw new SecureStorageError();
    const key = this.key(name);
    await this.recover(key);
    const current = await this.current(key);
    if (current) {
      await this.driver.setItemAsync(`${key}.journal`, JSON.stringify([current]));
      await this.driver.deleteItemAsync(key);
      await this.recover(key);
    }
  });

  seal(): Promise<unknown> {
    this.sealed = true;
    return this.tail;
  }

  async checkAvailable() {
    await this.setItem('probe', 'available');
    if (await this.getItem('probe') !== 'available') throw new SecureStorageError();
    await this.removeItem('probe');
  }

  async clearAuth() {
    const results = await Promise.allSettled(
      ['session', 'session-code-verifier', 'session-user', 'attempt'].map(this.removeItem),
    );
    if (results.some((result) => result.status === 'rejected')) throw new SecureStorageError();
  }
}
