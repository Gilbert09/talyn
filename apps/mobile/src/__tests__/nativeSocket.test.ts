import { createNativeSocket, NATIVE_SOCKET_OPTIONS } from '../native/socket';

describe('native socket', () => {
  const original = global.WebSocket;
  afterEach(() => { global.WebSocket = original; });

  it('sends an empty Origin so the API reads the app as a native client', () => {
    const calls: unknown[][] = [];
    global.WebSocket = jest.fn((...args: unknown[]) => { calls.push(args); return {}; }) as unknown as typeof WebSocket;
    createNativeSocket('wss://api.example/ws');
    expect(calls).toEqual([['wss://api.example/ws', undefined, { headers: { origin: '' } }]]);
    expect(NATIVE_SOCKET_OPTIONS.headers.origin).toBe('');
  });
});
