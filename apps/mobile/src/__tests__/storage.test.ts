import { SecureSessionStorage, SecureStorageError } from '../auth/storage';

function setup() {
  const values = new Map<string, string>();
  let revision = 0;
  const driver = {
    getItemAsync: jest.fn(async (key: string) => values.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => { values.set(key, value); }),
    deleteItemAsync: jest.fn(async (key: string) => { values.delete(key); }),
  };
  return { values, driver, create: () => new SecureSessionStorage(driver, 'test', () => `revision-${++revision}`) };
}

describe('secure session storage', () => {
  it.each(['short session', '🔐'.repeat(3000)])('reads and writes across restarts', async (value) => {
    const { create, values } = setup();
    await create().setItem('session', value);
    expect(await create().getItem('session')).toBe(value);
    expect([...values].filter(([key]) => /\.\d+$/.test(key)).every(([, chunk]) => chunk.length <= 1800)).toBe(true);
  });
  it('checks read, write, and removal before client creation', async () => {
    const { create, values } = setup();
    await create().checkAvailable();
    expect(values.size).toBe(0);
  });
  it('returns null for a missing item', async () => { expect(await setup().create().getItem('session')).toBeNull(); });
  it('removes all session, verifier, user, and attempt chunks on logout', async () => {
    const { create, values } = setup();
    const storage = create();
    for (const key of ['session', 'session-code-verifier', 'session-user', 'attempt']) await storage.setItem(key, 'secret'.repeat(1000));
    await storage.clearAuth();
    expect(values.size).toBe(0);
  });
  it.each(['getItemAsync', 'setItemAsync', 'deleteItemAsync'] as const)('fails closed when %s is unavailable', async (method) => {
    const { create, driver } = setup();
    driver[method].mockRejectedValueOnce(new Error('raw secure storage data'));
    await expect(create().checkAvailable()).rejects.toThrow(SecureStorageError);
  });
  it.each(['manifest', 'chunk', 'missing chunk'])('rejects corrupt %s data', async (kind) => {
    const { create, values } = setup();
    await create().setItem('session', 'secret');
    if (kind === 'manifest') values.set('test.session', '{');
    else if (kind === 'chunk') values.set('test.session.revision-1.0', 'invalid JSON');
    else values.delete('test.session.revision-1.0');
    await expect(create().getItem('session')).rejects.toThrow(SecureStorageError);
  });
  it.each([2, 3, 4])('recovers an interrupted write at step %s without replacing the session', async (failure) => {
    const { create, driver, values } = setup();
    await create().setItem('session', 'old');
    const original = driver.setItemAsync.getMockImplementation()!;
    let writes = 0;
    driver.setItemAsync.mockImplementation(async (...args) => {
      if (++writes === failure) throw new Error('storage failed');
      await original(...args);
    });
    await expect(create().setItem('session', 'new'.repeat(1500))).rejects.toThrow(SecureStorageError);
    driver.setItemAsync.mockImplementation(original);
    expect(await create().getItem('session')).toBe('old');
    await create().clearAuth();
    expect(values.size).toBe(0);
  });
  it('keeps the new session if cleanup fails after the atomic replacement', async () => {
    const { create, driver } = setup();
    await create().setItem('session', 'old');
    driver.deleteItemAsync.mockRejectedValueOnce(new Error());
    await expect(create().setItem('session', 'new')).rejects.toThrow(SecureStorageError);
    expect(await create().getItem('session')).toBe('new');
  });
  it('serializes overlapping updates and logout', async () => {
    const { create, values } = setup(); const storage = create();
    await Promise.all([storage.setItem('session', 'one'), storage.setItem('session', 'two'), storage.clearAuth()]);
    expect(values.size).toBe(0);
  });
});

it('rejects stale SDK writes after runtime disposal', async () => {
  const { create } = setup(); const storage = create();
  await storage.setItem('session', 'current'); await storage.seal();
  await expect(storage.setItem('session', 'stale refresh')).rejects.toThrow(SecureStorageError);
  await expect(storage.removeItem('session')).rejects.toThrow(SecureStorageError);
  expect(await create().getItem('session')).toBe('current');
});
