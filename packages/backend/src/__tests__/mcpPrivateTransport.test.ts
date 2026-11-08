import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateMcpServer, mcpServerInputProblem } from '@talyn/shared';
import { mcpFetch, readMcpBody, selectMcpDestination } from '../services/mcpServers/http.js';
import { startMcpOAuth, completeMcpOAuth, resolveMcpAccessToken, readMcpAccount, mcpClientMetadataUrl, mcpRedirectUri } from '../services/mcpServers/oauth.js';
import { encryptString, decryptString } from '../services/tokenCrypto.js';
import { resetWebAppUrlCacheForTests } from '../services/webApp.js';
import { readFileSync } from 'node:fs';
import { McpTransportError } from '../services/mcpServers/privateTcp.js';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(), connector: vi.fn(), dispatcher: vi.fn(), evict: vi.fn(), release: vi.fn(),
}));
vi.mock('../services/selfHosted/privateRoutes.js', () => ({
  workspaceMayUsePrivateRoutes: mocks.enabled,
  getPrivateConnector: mocks.connector,
  mapPrivateRoutesError: (error: unknown) => error,
}));
vi.mock('../services/mcpServers/privateTcp.js', async (original) => ({
  ...await original<typeof import('../services/mcpServers/privateTcp.js')>(),
  privateDispatcher: mocks.dispatcher,
  evictPrivateConnections: mocks.evict,
}));
vi.mock('../db/client.js', () => ({ getDbClient: () => ({}) }));
vi.mock('../services/advisoryLock.js', () => ({ withBlockingAdvisoryLock: async (_db: unknown, _key: string, run: () => Promise<unknown>) => run() }));

const context = { workspaceId: 'ws-1', purpose: 'discovery' as const, requestId: 'request-1' };
const privateAgent = {};
const connector = (patch = {}) => ({
  id: 'connector-1', workspaceId: 'ws-1', status: 'connected',
  routes: [{ host: 'mcp.internal.local', port: 443 }, { host: 'oauth.internal.local', port: 8443 }],
  ...patch,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.enabled.mockResolvedValue(true);
  mocks.connector.mockResolvedValue(connector());
  mocks.dispatcher.mockReturnValue({ agent: privateAgent, release: mocks.release });
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('workspace destination selection', () => {
  it.each([
    ['https://MCP.internal.local./mcp', 'connector-1'],
    ['https://mcp.internal.local:443/mcp', 'connector-1'],
    ['https://oauth.internal.local:8443/token', 'connector-1'],
    ['https://public.example.com/mcp', undefined],
  ])('selects each exact destination: %s', async (url, expected) => {
    expect((await selectMcpDestination(url, context)).connectorId).toBe(expected);
    expect(mocks.connector).toHaveBeenCalledWith('ws-1', undefined);
  });
  it.each(['https://mcp.internal.local:444/mcp', 'https://other.internal.local/mcp', 'https://mcp.internal.local.evil.local/mcp'])('refuses an unlisted private destination: %s', async (url) => {
      await expect(selectMcpDestination(url, context)).rejects.toMatchObject({ code: 'route_missing' });
    });
  it.each(['connecting', 'unavailable', 'needs_login'])('never falls back for a %s connector', async (status) => {
    mocks.connector.mockResolvedValue(connector({ status }));
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(mcpFetch('https://mcp.internal.local/mcp', {}, context)).rejects.toMatchObject({ code: 'connector_not_connected' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('fails closed when connector state cannot be read', async () => {
    mocks.connector.mockRejectedValue({ status: 503, code: 'unavailable', message: 'Private routes are unavailable.' });
    vi.stubGlobal('fetch', vi.fn());
    await expect(mcpFetch('https://public.example.com/mcp', {}, context)).rejects.toThrow('unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([false, true])('retains public routing when private access is absent (flag: %s)', async (enabled) => {
    mocks.enabled.mockResolvedValue(enabled);
    mocks.connector.mockRejectedValue({ status: 404 });
    expect((await selectMcpDestination('https://public.example.com/mcp', context)).connectorId).toBeUndefined();
    await expect(selectMcpDestination('https://mcp.internal.local/mcp', context)).rejects.toThrow(/exact private route/);
  });
  it('refuses a connector from another workspace', async () => {
    mocks.connector.mockResolvedValue(connector({ workspaceId: 'ws-2' }));
    await expect(selectMcpDestination('https://mcp.internal.local/mcp', context)).rejects.toMatchObject({ code: 'workspace_mismatch' });
  });
  it('uses the replacement connector on the next request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    await (await mcpFetch('https://mcp.internal.local/mcp', {}, context)).text();
    mocks.connector.mockResolvedValue(connector({ id: 'connector-2' }));
    await (await mcpFetch('https://mcp.internal.local/mcp', {}, context)).text();
    expect(mocks.dispatcher.mock.calls.map((args) => args[1])).toEqual(['connector-1', 'connector-2']);
    expect(mocks.evict).toHaveBeenLastCalledWith('ws-1', expect.stringContaining('connector-2'));
  });
  it('does not retry a denied private request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new McpTransportError('destination_denied', 'Denied.'); }));
    await expect(mcpFetch('https://mcp.internal.local/mcp', { method: 'POST', body: 'secret' }, context)).rejects.toThrow('Denied');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.evict).toHaveBeenLastCalledWith('ws-1');
  });
});

describe('redirect decisions and credentials', () => {
  it('selects the OAuth route independently and strips all resource headers across origins', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://oauth.internal.local:8443/info' } }))
      .mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
    await (await mcpFetch('https://mcp.internal.local/mcp?key=resource-secret', {
      headers: { authorization: 'Bearer resource-secret', 'x-api-key': 'header-secret', 'mcp-session-id': 'session-secret', accept: 'application/json' },
    }, context)).text();
    expect(mocks.dispatcher.mock.calls.map((args) => [args[2], args[3]])).toEqual([
      ['mcp.internal.local', 443], ['oauth.internal.local', 8443],
    ]);
    const [url, init] = fetcher.mock.calls[1];
    expect(url).not.toContain('secret');
    expect([...init.headers.entries()]).toEqual([['accept', 'application/json']]);
  });
  it('checks a public redirect with the public dispatcher', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://public.example.com/info' } }))
      .mockResolvedValueOnce(new Response('{}')));
    await (await mcpFetch('https://mcp.internal.local/mcp', {}, context)).text();
    expect((vi.mocked(fetch).mock.calls[1][1] as RequestInit & { dispatcher: unknown }).dispatcher).not.toBe(privateAgent);
    expect(mocks.dispatcher).toHaveBeenCalledTimes(1);
  });
  it.each(['POST', 'DELETE'])('does not replay %s at a redirect', async (method) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 307, headers: { location: 'https://public.example.com/info' } })));
    await expect(mcpFetch('https://mcp.internal.local/mcp', { method }, context)).rejects.toMatchObject({ code: 'redirect_refused' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('refuses a redirect to an unlisted private host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://other.local/info' } })));
    await expect(mcpFetch('https://mcp.internal.local/mcp', {}, context)).rejects.toMatchObject({ code: 'route_missing' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['removed', 'replaced'])(
    'does not switch a matched private destination when its route is %s during a redirect', async (change) => {
      const routes = [{ host: 'mcp.example.test', port: 443 }];
      mocks.connector.mockResolvedValueOnce(connector({ routes }));
      mocks.connector.mockResolvedValue(connector({ routes: change === 'removed' ? [] : routes, id: change === 'replaced' ? 'connector-2' : 'connector-1' }));
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: '/final' } })));
      await expect(mcpFetch('https://mcp.example.test/mcp', { headers: { authorization: 'Bearer resource-test-value' } }, context))
        .rejects.toMatchObject({ code: 'route_changed' });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(mocks.dispatcher).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps query strings, headers, and bodies out of audit records', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    await (await mcpFetch('https://mcp.internal.local/mcp?token=query-secret', {
      method: 'POST', headers: { authorization: 'Bearer header-secret' }, body: 'body-secret',
    }, context)).text();
    const audit = JSON.stringify(vi.mocked(console.info).mock.calls);
    for (const secret of ['query-secret', 'header-secret', 'body-secret', '/mcp?', 'authorization']) expect(audit).not.toContain(secret);
    expect(JSON.parse(audit)[0][1]).toMatchObject({ workspaceId: 'ws-1', connectorId: 'connector-1', transport: 'private', purpose: 'discovery', result: '200', requestId: 'request-1' });
  });
  it('cancels pending route selection', async () => {
    mocks.connector.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = mcpFetch('https://mcp.internal.local/mcp', { signal: controller.signal }, context);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('releases a private connection after bounded consumption', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('12345')));
    const response = await mcpFetch('https://mcp.internal.local/mcp', {}, context);
    await expect(readMcpBody(response, 4)).rejects.toThrow(/too large/);
    expect(mocks.release).toHaveBeenCalled();
    expect(vi.mocked(console.info).mock.calls.at(-1)?.[1]).toMatchObject({ result: 'response_too_large' });
  });
});

describe('shared editor validation', () => {
  const input = { name: 'private', url: 'https://mcp.internal.local/mcp', authKind: 'none' as const };
  it('allows only the exact configured HTTPS route', () => {
    const routes = [{ host: 'mcp.internal.local', port: 443 }];
    expect(validateMcpServer(input, routes).url).toBe(input.url);
    expect(mcpServerInputProblem(input, routes)).toBeNull();
    expect(mcpServerInputProblem(input)).toContain('exact private route');
    expect(mcpServerInputProblem({ ...input, url: 'https://mcp.internal.local:8443/mcp' }, routes)).toContain('exact private route');
    expect(mcpServerInputProblem({ ...input, url: 'http://mcp.internal.local/mcp' }, routes)).toContain('exact private route');
  });
});


describe('private OAuth destinations', () => {
  it('routes discovery, registration, exchange, refresh, and account reads through the owning workspace', async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', Buffer.alloc(32, 4).toString('base64'));
    vi.stubEnv('WEB_APP_URL', 'https://app.talyn.dev');
    resetWebAppUrlCacheForTests();
    const auth = 'https://oauth.internal.local:8443';
    const endpoint = 'https://mcp.internal.local/mcp';
    const metadata = {
      issuer: auth, authorization_endpoint: `${auth}/authorize`, token_endpoint: `${auth}/token`,
      registration_endpoint: `${auth}/register`, userinfo_endpoint: `${auth}/account`,
      code_challenge_methods_supported: ['S256'],
    };
    const tokenBodies: URLSearchParams[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
      if (input === endpoint) return new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${endpoint}/metadata"` } });
      if (input === `${endpoint}/metadata`) return Response.json({ resource: endpoint, authorization_servers: [auth] });
      if (input === `${auth}/.well-known/oauth-authorization-server`) return Response.json(metadata);
      if (input === `${auth}/register`) return Response.json({ client_id: 'client-test-value', client_secret: 'client-secret-test-value' });
      if (input === `${auth}/token`) {
        tokenBodies.push(new URLSearchParams(init.body as URLSearchParams));
        return Response.json({ access_token: 'access-test-value', refresh_token: 'refresh-test-value', expires_in: 3600 });
      }
      if (input === `${auth}/account`) return Response.json({ name: 'Example', email: 'user@example.test' });
      throw new Error('Unexpected test endpoint');
    }));
    try {
      const flow = await startMcpOAuth({ id: 'server-1', workspaceId: 'ws-1', url: endpoint }, null, new Date());
      expect(flow.stored.flow?.verifier).toBeUndefined();
      expect(flow.stored.flow?.verifierEnc).toBeDefined();
      const state = new URL(flow.authorizeUrl).searchParams.get('state')!;
      const stored = await completeMcpOAuth(flow.stored, state, 'code-test-value', new Date(), { ...context, purpose: 'exchange' });
      expect(tokenBodies[0].get('code_verifier')).toBe(decryptString(flow.stored.flow!.verifierEnc!));
      expect(tokenBodies[0].get('client_secret')).toBe('client-secret-test-value');
      let current = { ...stored, expiresAt: new Date(0).toISOString(), refreshTokenEnc: encryptString('refresh-test-value') };
      const store = { read: async () => current, write: vi.fn(async (_id, next) => { current = next; }) };
      expect(await resolveMcpAccessToken('server-1', store, new Date(), { ...context, purpose: 'refresh' })).toBe('access-test-value');
      expect(tokenBodies[1].get('grant_type')).toBe('refresh_token');
      expect(tokenBodies[1].get('refresh_token')).toBe('refresh-test-value');
      expect(await readMcpAccount('server-1', store, { ...context, purpose: 'account' })).toEqual({ name: 'Example', email: 'user@example.test' });
      for (const call of mocks.dispatcher.mock.calls) expect(call.slice(0, 2)).toEqual(['ws-1', 'connector-1']);
      expect(mocks.dispatcher.mock.calls.some((call) => call[2] === 'oauth.internal.local' && call[3] === 8443)).toBe(true);
      const audit = JSON.stringify(vi.mocked(console.info).mock.calls);
      for (const secret of ['access-test-value', 'refresh-test-value', 'code-test-value', 'client-secret-test-value']) expect(audit).not.toContain(secret);
    } finally { vi.unstubAllEnvs(); resetWebAppUrlCacheForTests(); }
  });
  it('does not expose a credential from an invalid token response', async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', Buffer.alloc(32, 4).toString('base64'));
    vi.stubEnv('WEB_APP_URL', 'https://app.talyn.dev'); resetWebAppUrlCacheForTests();
    const existing = { status: 'pending' as const, authorizationEndpoint: 'https://oauth.internal.local:8443/authorize', tokenEndpoint: 'https://oauth.internal.local:8443/token', clientId: 'client-test-value' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('access-token-must-not-escape', { status: 400 })));
    try {
      const flow = await startMcpOAuth({ id: 'server-1', workspaceId: 'ws-1', url: 'https://mcp.internal.local/mcp' }, existing, new Date());
      const state = new URL(flow.authorizeUrl).searchParams.get('state')!;
      await expect(completeMcpOAuth(flow.stored, state, 'code-test-value', new Date(), { ...context, purpose: 'exchange' })).rejects.toThrow('invalid JSON');
      expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('access-token-must-not-escape');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { vi.unstubAllEnvs(); resetWebAppUrlCacheForTests(); }
  });
  it('serves the checked-in CIMD identity and public callback without a session', () => {
    vi.stubEnv('WEB_APP_URL', 'https://app.talyn.dev'); resetWebAppUrlCacheForTests();
    try {
      const document = JSON.parse(readFileSync('../../apps/web/public/.well-known/oauth-client/talyn.json', 'utf8'));
      expect(document.client_id).toBe(mcpClientMetadataUrl());
      expect(document.redirect_uris).toEqual([mcpRedirectUri()]);
      expect(document.token_endpoint_auth_method).toBe('none');
    } finally { vi.unstubAllEnvs(); resetWebAppUrlCacheForTests(); }
  });
});
