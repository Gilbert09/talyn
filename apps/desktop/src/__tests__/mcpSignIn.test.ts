import { api } from '../renderer/lib/api';
import { startMcpSignIn } from '../renderer/lib/mcpSignIn';

/**
 * The renderer side of a loopback MCP sign-in: offer the listener to the
 * backend, and forward the callback only when the backend chose it.
 */

const LOOPBACK = 'http://127.0.0.1:47823/callback';
const HOSTED = 'https://app.talyn.dev/mcp/callback';

function flowFor(redirectUri: string, state: string | null = 'srv-1.abc') {
  const url = new URL('https://auth.example.com/authorize');
  url.searchParams.set('redirect_uri', redirectUri);
  if (state) url.searchParams.set('state', state);
  return { flowId: 'flow-1', authorizeUrl: url.toString(), expiresAt: new Date().toISOString(), scopes: [] };
}

const bridge = {
  listen: jest.fn(),
  wait: jest.fn(),
  close: jest.fn(),
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let startSignIn: jest.SpyInstance;
let complete: jest.SpyInstance;
const original = window.electron;

beforeEach(() => {
  bridge.listen.mockReset().mockResolvedValue({ id: 'l-1', redirectUri: LOOPBACK });
  bridge.wait.mockReset().mockResolvedValue(null);
  bridge.close.mockReset().mockResolvedValue(undefined);
  (window as unknown as { electron: unknown }).electron = { mcpOAuth: bridge };
  startSignIn = jest.spyOn(api.mcpServers, 'startSignIn');
  complete = jest.spyOn(api.mcpServers, 'complete').mockResolvedValue(null);
});

afterEach(() => {
  (window as unknown as { electron: unknown }).electron = original;
  jest.restoreAllMocks();
});

describe('startMcpSignIn', () => {
  it('starts without a loopback when the app has no bridge', async () => {
    (window as unknown as { electron: unknown }).electron = undefined;
    startSignIn.mockResolvedValue(flowFor(HOSTED));
    const { flow, close } = await startMcpSignIn('srv-1');
    close();
    expect(startSignIn).toHaveBeenCalledWith('srv-1', undefined);
    expect(flow.flowId).toBe('flow-1');
  });

  it('starts without a loopback when the listener cannot open', async () => {
    bridge.listen.mockRejectedValue(new Error('no port'));
    startSignIn.mockResolvedValue(flowFor(HOSTED));
    await startMcpSignIn('srv-1');
    expect(startSignIn).toHaveBeenCalledWith('srv-1', undefined);
    expect(bridge.close).not.toHaveBeenCalled();
  });

  it.each([
    ['the hosted callback', flowFor(HOSTED)],
    ['another loopback', flowFor('http://127.0.0.1:1234/callback')],
    ['no state', flowFor(LOOPBACK, null)],
  ])('closes the listener when the backend chose %s', async (_name, flow) => {
    startSignIn.mockResolvedValue(flow);
    await startMcpSignIn('srv-1');
    expect(startSignIn).toHaveBeenCalledWith('srv-1', { loopbackRedirectUri: LOOPBACK });
    expect(bridge.close).toHaveBeenCalledWith('l-1');
    expect(bridge.wait).not.toHaveBeenCalled();
  });

  it.each([
    [{ state: 'srv-1.abc', code: 'c-1' }, ['srv-1.abc', 'c-1', undefined]],
    [{ state: 'srv-1.abc', error: 'access_denied' }, ['srv-1.abc', '', 'access_denied']],
  ])('forwards the loopback callback %j to the backend', async (callback, args) => {
    startSignIn.mockResolvedValue(flowFor(LOOPBACK));
    bridge.wait.mockResolvedValue(callback);
    const { close } = await startMcpSignIn('srv-1');
    await flush();
    expect(bridge.wait).toHaveBeenCalledWith('l-1', 'srv-1.abc');
    expect(complete).toHaveBeenCalledWith(...args);
    expect(bridge.close).not.toHaveBeenCalled();
    close();
    expect(bridge.close).toHaveBeenCalledWith('l-1');
  });

  it('forwards nothing when the listener closes first', async () => {
    startSignIn.mockResolvedValue(flowFor(LOOPBACK));
    await startMcpSignIn('srv-1');
    await flush();
    expect(complete).not.toHaveBeenCalled();
  });

  it('swallows a failed forward, which the status poll reports', async () => {
    startSignIn.mockResolvedValue(flowFor(LOOPBACK));
    bridge.wait.mockResolvedValue({ state: 'srv-1.abc', code: 'c-1' });
    complete.mockRejectedValue(new Error('exchange failed'));
    await startMcpSignIn('srv-1');
    await flush();
    expect(complete).toHaveBeenCalled();
  });

  it('closes the listener and rethrows when the backend refuses to start', async () => {
    startSignIn.mockRejectedValue(new Error('refused'));
    await expect(startMcpSignIn('srv-1')).rejects.toThrow('refused');
    expect(bridge.close).toHaveBeenCalledWith('l-1');
  });
});
