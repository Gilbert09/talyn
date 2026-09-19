import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverMcpAuth } from '../services/mcpServers/authDiscovery.js';
import {
  challengeParameter,
  discover,
  discoverAuthServer,
} from '../services/mcpServers/discovery.js';
import {
  isPublicAddress,
  mcpFetch,
  publicHttpsUrl,
  readMcpBody,
} from '../services/mcpServers/http.js';

const endpoint = 'https://mcp.example.com/tools/mcp';
const issuer = 'https://auth.example.com/tenant';
const resource = {
  resource: endpoint,
  authorization_servers: [issuer],
  scopes_supported: ['read'],
};
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  code_challenge_methods_supported: ['S256'],
  client_id_metadata_document_supported: true,
};
const initialized = {
  jsonrpc: '2.0',
  id: 1,
  result: { protocolVersion: '2025-06-18', serverInfo: { name: 'test' }, capabilities: {} },
};
function stub(routes: Record<string, unknown>, status = 401, challenge = '') {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST')
      return new Response(status === 200 ? JSON.stringify(initialized) : '', {
        status,
        headers: { 'www-authenticate': challenge, 'content-type': 'application/json' },
      });
    return new Response(JSON.stringify(routes[url] ?? {}), { status: url in routes ? 200 : 404 });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}
afterEach(() => vi.unstubAllGlobals());

describe('MCP authentication detection', () => {
  it.each([
    [
      'header',
      'https://mcp.example.com/metadata',
      'Bearer resource_metadata="https://mcp.example.com/metadata", scope="write"',
    ],
    ['path', 'https://mcp.example.com/.well-known/oauth-protected-resource/tools/mcp', ''],
    ['root', 'https://mcp.example.com/.well-known/oauth-protected-resource', ''],
  ])('discovers OAuth through the %s metadata location', async (_name, location, challenge) => {
    const fetchSpy = stub(
      {
        [location]: resource,
        'https://auth.example.com/.well-known/oauth-authorization-server/tenant': metadata,
      },
      401,
      challenge
    );
    expect(await discoverMcpAuth(endpoint)).toMatchObject({ methods: ['oauth'], source: 'server' });
    const sent = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(sent.params).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'talyn' },
    });
    expect(
      fetchSpy.mock.calls.every(
        ([, options]) => !new Headers(options?.headers).has('authorization')
      )
    ).toBe(true);
  });

  it('discovers optional OAuth after an anonymous initialize', async () => {
    stub(
      {
        'https://mcp.example.com/.well-known/oauth-protected-resource': resource,
        'https://auth.example.com/.well-known/oauth-authorization-server/tenant': metadata,
      },
      200
    );
    expect((await discoverMcpAuth(endpoint)).methods).toEqual(['oauth']);
  });

  it.each([
    [200, '', ['none']],
    [401, 'Basic realm="tools"', ['basic']],
    [401, 'Bearer realm="tools"', ['bearer']],
    [401, 'Basic realm="tools", Bearer realm="tools"', ['basic', 'bearer']],
    [401, '', []],
    [403, '', []],
    [404, '', []],
    [500, '', []],
  ])('handles HTTP %s and challenge %s', async (status, challenge, methods) => {
    stub({}, status, challenge);
    expect((await discoverMcpAuth(endpoint)).methods).toEqual(methods);
  });

  it('does not treat an HTML success page as an anonymous MCP server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Sign in</html>'))
    );
    expect((await discoverMcpAuth(endpoint)).methods).toEqual([]);
  });

  it('reads an initialize event without waiting for the stream to close', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) =>
        options.method === 'POST'
          ? new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(`data: ${JSON.stringify(initialized)}\n\n`)
                  );
                },
                cancel,
              }),
              { headers: { 'content-type': 'text/event-stream' } }
            )
          : new Response('', { status: 404 })
      )
    );
    expect((await discoverMcpAuth(endpoint)).methods).toEqual(['none']);
    expect(cancel).toHaveBeenCalled();
  });

  it('uses exact catalog addresses for API-key configuration', async () => {
    stub({});
    expect(await discoverMcpAuth('https://mcp.context7.com/mcp')).toMatchObject({
      methods: ['header'],
      source: 'catalog',
      inject: { header: 'CONTEXT7_API_KEY' },
    });
    expect((await discoverMcpAuth('https://mcp.context7.com/other')).methods).toEqual([]);
    expect(
      (await discoverMcpAuth('https://mcp.context7.com.attacker.example/mcp')).methods
    ).toEqual([]);
  });

  it('keeps the catalog API-key option alongside detected OAuth', async () => {
    const url = 'https://mcp.linear.app/mcp';
    stub({
      'https://mcp.linear.app/.well-known/oauth-protected-resource': { ...resource, resource: url },
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant': metadata,
    });
    expect((await discoverMcpAuth(url)).methods).toEqual(['oauth', 'bearer']);
  });

  it('reports network failures without claiming that no credential is needed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));
    expect(await discoverMcpAuth(endpoint)).toMatchObject({ methods: [], source: 'unknown' });
    expect(await discoverMcpAuth('https://mcp.notion.com/mcp')).toMatchObject({
      methods: ['oauth'],
      source: 'catalog',
    });
  });

  it('uses challenge scopes before resource scopes', async () => {
    stub(
      {
        'https://mcp.example.com/.well-known/oauth-protected-resource': resource,
        'https://auth.example.com/.well-known/oauth-authorization-server/tenant': metadata,
      },
      401,
      'Bearer scope="write"'
    );
    expect((await discover(endpoint)).resource.scope).toBe('write');
  });

  it('uses resource scopes when the challenge has none', async () => {
    stub({
      'https://mcp.example.com/.well-known/oauth-protected-resource': resource,
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant': metadata,
    });
    expect((await discover(endpoint)).resource.scope).toBe('read');
  });

  it('rejects metadata for another resource', async () => {
    stub({
      'https://mcp.example.com/.well-known/oauth-protected-resource': {
        ...resource,
        resource: 'https://other.example.com/mcp',
      },
    });
    await expect(discover(endpoint)).rejects.toThrow(/resource metadata/);
  });

  it('rejects a mismatched issuer', async () => {
    stub({
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant': {
        ...metadata,
        issuer: 'https://other.example.com',
      },
    });
    await expect(discoverAuthServer(issuer, AbortSignal.timeout(1000))).rejects.toThrow(/issuer/);
  });

  it.each([
    [
      'Bearer resource_metadata="https://example.com/meta", scope="read write"',
      'scope',
      'read write',
    ],
    [
      'Basic realm="hello", Bearer resource_metadata="https://example.com/meta", scope="read"',
      'scope',
      'read',
    ],
    [
      'Bearer RESOURCE_METADATA=https://example.com/meta',
      'resource_metadata',
      'https://example.com/meta',
    ],
    ['Basic resource_metadata="https://example.com/meta"', 'resource_metadata', undefined],
  ])('parses challenge parameters: %s', (value, name, expected) => {
    expect(challengeParameter(value, name)).toBe(expected);
  });
});

describe('MCP discovery network boundaries', () => {
  it.each([
    '127.0.0.1',
    '10.2.3.4',
    '169.254.169.254',
    '100.64.0.1',
    '172.16.1.1',
    '192.168.1.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
    'fe80::1',
  ])('rejects %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'accepts public address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    }
  );
  it.each([
    'http://public.example.com',
    'https://user:password@example.com',
    'https://localhost',
    'https://[::1]',
    'https://127.0.0.1',
    'https://example.com/#fragment',
  ])('rejects URL %s before making a request', async (url) => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(publicHttpsUrl(url)).toBeNull();
    await expect(mcpFetch(url)).rejects.toThrow(/public HTTPS/);
    expect(spy).not.toHaveBeenCalled();
  });
  it('disables redirects and uses the DNS-checking dispatcher', async () => {
    const spy = stub({});
    await mcpFetch(endpoint);
    expect(spy).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({ redirect: 'error', dispatcher: expect.anything() })
    );
  });
  it('cancels oversized responses', async () => {
    const response = new Response('12345');
    await expect(readMcpBody(response, 4)).rejects.toThrow(/too large/);
  });
});
