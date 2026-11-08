import type { ClientLifecycleEvent } from '@talyn/client/native';

import { AccountActions } from '../auth/account';
import type { AuthController } from '../auth/controller';
import { createNativeLifecycle, reachability } from '../native/lifecycle';
import { WorkspaceController } from '../workspaces/controller';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('native lifecycle', () => {
  it.each([
    [true, true, 'online'], [false, null, 'offline'], [true, false, 'offline'], [null, null, 'unknown'], [true, null, 'unknown'],
  ] as const)('maps connected=%s reachable=%s to %s', (isConnected, isInternetReachable, expected) => {
    expect(reachability({ isConnected, isInternetReachable })).toBe(expected);
  });
  it('sends state changes once and releases every native listener', () => {
    let appListener!: (value: string) => void;
    let networkListener!: (value: { isConnected: boolean; isInternetReachable: boolean }) => void;
    const removeApp = jest.fn(); const removeNetwork = jest.fn();
    const lifecycle = createNativeLifecycle({ currentState: 'active', addEventListener: (_, listener) => {
      appListener = listener; return { remove: removeApp };
    } }, { addEventListener: (listener) => { networkListener = listener; return removeNetwork; } });
    const events: ClientLifecycleEvent[] = []; const unsubscribe = lifecycle.subscribe((event) => events.push(event));
    appListener('background'); appListener('background'); appListener('inactive');
    networkListener({ isConnected: false, isInternetReachable: false });
    appListener('active'); networkListener({ isConnected: true, isInternetReachable: true });
    expect(events).toHaveLength(4);
    expect(lifecycle.getSnapshot()).toEqual({ activity: 'active', reachability: 'online' });
    unsubscribe(); appListener('background'); expect(events).toHaveLength(4);
    lifecycle.dispose(); expect(removeApp).toHaveBeenCalledTimes(1); expect(removeNetwork).toHaveBeenCalledTimes(1);
  });
});

function workspaces() {
  const values = new Map<string, string>();
  const preferences = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: jest.fn(async (key: string, value: string) => { values.set(key, value); }),
    removeItem: jest.fn(async (key: string) => { values.delete(key); }),
  };
  const list = jest.fn(async () => [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }]);
  return { values, preferences, list, make: (env: string) => new WorkspaceController(preferences, env, list) };
}
describe('workspace access and preferences', () => {
  it('scopes selection by environment and user', async () => {
    const { make } = workspaces(); const dev = make('dev'); await dev.load('alice'); await dev.select('one');
    const restart = make('dev'); await restart.load('alice'); expect(restart.getSnapshot().selected).toBe('one');
    await restart.load('bob'); expect(restart.getSnapshot().selected).toBeNull();
    const prod = make('prod'); await prod.load('alice'); expect(prod.getSnapshot().selected).toBeNull();
  });
  it('removes saved selection when access is revoked', async () => {
    const { make, list, values } = workspaces(); const store = make('dev'); await store.load('alice'); await store.select('one');
    list.mockResolvedValue([{ id: 'two', name: 'Two' }]); await store.load('alice');
    expect(store.getSnapshot().selected).toBeNull(); expect(values.size).toBe(0);
    await store.select('one'); expect(values.size).toBe(0);
  });
  it('does not expose saved access before validation succeeds', async () => {
    const { make, list } = workspaces(); const store = make('dev'); await store.load('alice'); await store.select('one');
    list.mockRejectedValue(new Error('offline')); await store.load('alice');
    expect(store.getSnapshot()).toMatchObject({ status: 'error', choices: [], selected: null });
  });
  it('does not restore a stale list after logout', async () => {
    const { make, list } = workspaces(); const pending = deferred<{ id: string; name: string }[]>(); list.mockReturnValue(pending.promise);
    const store = make('dev'); const load = store.load('alice'); await store.clear('alice');
    pending.resolve([{ id: 'one', name: 'One' }]); await load;
    expect(store.getSnapshot()).toEqual({ status: 'idle', choices: [], selected: null });
  });
  it('serializes a preference write with logout cleanup', async () => {
    const { make, preferences, values } = workspaces(); const store = make('dev'); await store.load('alice');
    const pending = deferred<void>(); preferences.setItem.mockImplementation(async (key, value) => { await pending.promise; values.set(key, value); });
    const selection = store.select('one'); const cleanup = store.clear('alice'); pending.resolve(); await Promise.all([selection, cleanup]);
    expect(values.size).toBe(0); expect(store.getSnapshot().selected).toBeNull();
  });
});

describe('account deletion', () => {
  function setup() {
    let signedOut = false;
    const auth = {
      getSnapshot: () => ({ status: signedOut ? 'signedOut' : 'signedIn', user: signedOut ? null : { id: 'alice' } }),
      signOut: jest.fn(async () => { signedOut = true; }),
      markAccountDeleted: jest.fn(),
    };
    const wipe = jest.fn(async () => {});
    return { auth, wipe, account: new AccountActions(auth as unknown as AuthController, wipe) };
  }
  it('clears the account only after successful deletion', async () => {
    const { account, auth, wipe } = setup(); expect(await account.deleteAccount()).toBe('deleted');
    expect(wipe).toHaveBeenCalledTimes(1); expect(auth.signOut).toHaveBeenCalledTimes(1);
  });
  it.each([[409, 'blocked'], [500, 'failed'], [0, 'failed']])('keeps the account when deletion returns %s', async (status, expected) => {
    const { account, auth, wipe } = setup(); wipe.mockRejectedValue({ status, message: 'raw private error' });
    expect(await account.deleteAccount()).toBe(expected); expect(auth.signOut).not.toHaveBeenCalled();
  });
  it('serializes destructive requests', async () => {
    const { account, wipe } = setup(); const pending = deferred<void>(); wipe.mockReturnValue(pending.promise);
    const first = account.deleteAccount(); expect(account.deleteAccount()).toBe(first); pending.resolve(); await first;
    expect(wipe).toHaveBeenCalledTimes(1);
  });
});
