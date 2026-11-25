/**
 * @jest-environment node
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { closeMcpLoopback, openMcpLoopback, waitMcpLoopback } from '../main/mcpOAuthLoopback';

/**
 * The loopback listener for MCP server sign-in. It must hand on only the
 * callback whose state matches, and free its port when the sign-in ends.
 */

function get(url: string, method = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

function base(redirectUri: string): string {
  return redirectUri.replace(/\/callback$/, '');
}

const opened: string[] = [];
async function open(port = 0) {
  const listener = await openMcpLoopback(port);
  opened.push(listener.id);
  return listener;
}

afterEach(() => {
  opened.splice(0).forEach(closeMcpLoopback);
});

describe('MCP loopback listener', () => {
  it('listens on 127.0.0.1 with a /callback redirect', async () => {
    const { redirectUri } = await open();
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it('falls back to another port when the preferred one is busy', async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const busy = (blocker.address() as AddressInfo).port;
    try {
      const { redirectUri } = await open(busy);
      expect(new URL(redirectUri).port).not.toBe(String(busy));
    } finally {
      blocker.close();
    }
  });

  it.each([
    ['a code', '?state=s-1&code=c-1', { state: 's-1', code: 'c-1' }],
    ['a refusal', '?state=s-1&error=access_denied', { state: 's-1', error: 'access_denied' }],
  ])('hands on %s for the matching state, then closes', async (_name, query, expected) => {
    const { id, redirectUri } = await open();
    const waiting = waitMcpLoopback(id, 's-1');
    expect(await get(`${redirectUri}${query}`)).toBe(200);
    await expect(waiting).resolves.toEqual(expected);
    await expect(get(`${redirectUri}${query}`)).rejects.toThrow();
  });

  it.each([
    ['a different state', '/callback?state=forged&code=c-1', 400],
    ['no state', '/callback?code=c-1', 400],
    ['no code and no error', '/callback?state=s-1', 400],
    ['another path', '/other?state=s-1&code=c-1', 404],
  ])('ignores %s and keeps waiting', async (_name, path, status) => {
    const { id, redirectUri } = await open();
    const waiting = waitMcpLoopback(id, 's-1');
    expect(await get(`${base(redirectUri)}${path}`)).toBe(status);
    expect(await get(`${redirectUri}?state=s-1&code=c-1`)).toBe(200);
    await expect(waiting).resolves.toEqual({ state: 's-1', code: 'c-1' });
  });

  it('ignores a POST', async () => {
    const { id, redirectUri } = await open();
    void waitMcpLoopback(id, 's-1');
    expect(await get(`${redirectUri}?state=s-1&code=c-1`, 'POST')).toBe(404);
  });

  it('refuses a callback before the state is known', async () => {
    const { redirectUri } = await open();
    expect(await get(`${redirectUri}?state=s-1&code=c-1`)).toBe(400);
  });

  it('resolves null and frees the port when closed', async () => {
    const { id, redirectUri } = await open();
    const waiting = waitMcpLoopback(id, 's-1');
    closeMcpLoopback(id);
    await expect(waiting).resolves.toBeNull();
    await expect(get(`${redirectUri}?state=s-1&code=c-1`)).rejects.toThrow();
  });

  it('closes the older listener when a new sign-in starts', async () => {
    const first = await open();
    const waiting = waitMcpLoopback(first.id, 's-1');
    const second = await open();
    await expect(waiting).resolves.toBeNull();
    // A late close of the old id leaves the new listener alone.
    closeMcpLoopback(first.id);
    const next = waitMcpLoopback(second.id, 's-2');
    expect(await get(`${second.redirectUri}?state=s-2&code=c-2`)).toBe(200);
    await expect(next).resolves.toEqual({ state: 's-2', code: 'c-2' });
  });

  it.each([
    ['an unknown id', 'nope', 's-1'],
    ['an empty state', null, ''],
  ])('resolves null at once for %s', async (_name, id, state) => {
    const listener = await open();
    await expect(waitMcpLoopback(id ?? listener.id, state)).resolves.toBeNull();
  });

  it('resolves null for a second wait on the same listener', async () => {
    const { id } = await open();
    void waitMcpLoopback(id, 's-1');
    await expect(waitMcpLoopback(id, 's-1')).resolves.toBeNull();
  });
});
