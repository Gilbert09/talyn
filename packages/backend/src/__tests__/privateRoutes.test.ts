import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivateConnector } from '@talyn/shared';

const mocks = vi.hoisted(() => ({ enabled: true }));

vi.mock('../services/featureFlags.js', () => ({
  workspaceHasFeature: vi.fn(async (flag: string) => ({
    enabled: flag === 'privateRoutes' ? mocks.enabled : false,
    source: 'env',
  })),
}));

vi.mock('../services/selfHosted/credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/selfHosted/credentials.js')>()),
  fleetPinnedEndpoint: () => 'https://yas.test',
  fleetGatewayToken: () => 'gateway-token',
}));

import { FleetClient, FleetHttpError } from '../services/selfHosted/client.js';
import {
  composePrivateRoutesPolicy,
  deletePrivateConnector,
  invalidatePrivateConnectorCache,
  listPrivatePeers,
  mapPrivateRoutesError,
  normalizePrivatePeers,
  replacePrivateRoutes,
  resetPrivateConnectorCache,
  sandboxPolicyForWorkspace,
  startPrivateConnector,
  validatePrivateRoutes,
} from '../services/selfHosted/privateRoutes.js';
import { buildSandboxCreateBody } from '../services/selfHosted/sandboxRun.js';

const connector: PrivateConnector = {
  id: 'connector-1',
  workspaceId: 'workspace-1',
  createdAt: '2026-11-07T00:00:00Z',
  status: 'connected',
  routes: [{ host: 'db.corp', port: 5432 }],
};

describe('private routes', () => {
  beforeEach(() => {
    mocks.enabled = true;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetPrivateConnectorCache();
  });

  it('validates and canonicalizes exact TCP destinations', () => {
    expect(validatePrivateRoutes([
      { host: 'DB.CORP.', port: 5432 },
      { host: '10.0.0.8', port: 443 },
      { host: '2001:DB8::1', port: 8443 },
    ])).toEqual([
      { host: 'db.corp', port: 5432 },
      { host: '10.0.0.8', port: 443 },
      { host: '2001:db8::1', port: 8443 },
    ]);
  });

  it.each([
    ['a CIDR', [{ host: '10.0.0.0/24', port: 443 }]],
    ['a wildcard', [{ host: '*.corp', port: 443 }]],
    ['a URL', [{ host: 'https://db.corp', port: 443 }]],
    ['port zero', [{ host: 'db.corp', port: 0 }]],
    ['a fractional port', [{ host: 'db.corp', port: 4.5 }]],
    ['an unknown field', [{ host: 'db.corp', port: 443, protocol: 'tcp' }]],
    ['a duplicate', [{ host: 'DB.corp', port: 443 }, { host: 'db.corp.', port: 443 }]],
  ])('rejects %s', (_label, routes) => {
    expect(() => validatePrivateRoutes(routes)).toThrow();
  });

  it('adds connected routes and preserves credentials and open internet access', () => {
    const policy = {
      credentials: { anthropic: 'none' as const },
      egress: { mode: 'open' as const },
      github: { readAllRepos: true },
    };
    expect(composePrivateRoutesPolicy(policy, connector)).toEqual({
      ...policy,
      version: 2,
      privateRoutes: [{ connectorId: 'connector-1', host: 'db.corp', port: 5432 }],
    });
    expect(composePrivateRoutesPolicy(policy, { ...connector, status: 'connecting' })).toEqual(composePrivateRoutesPolicy(policy, connector));
    expect(composePrivateRoutesPolicy(policy, null)).toBe(policy);
  });

  it('omits connector state when the backend flag is off', async () => {
    mocks.enabled = false;
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const policy = { egress: { mode: 'open' as const } };
    expect(await sandboxPolicyForWorkspace('workspace-1', policy)).toBe(policy);
    expect(request).not.toHaveBeenCalled();
  });

  it('adds only routes from the owning workspace connector', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(connector), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const policy = {
      credentials: { openai: 'none' as const },
      egress: { mode: 'open' as const },
    };
    expect(await sandboxPolicyForWorkspace('workspace-1', policy)).toEqual({
      ...policy,
      version: 2,
      privateRoutes: [{ connectorId: 'connector-1', host: 'db.corp', port: 5432 }],
    });
  });

  it.each(['connecting', 'unavailable', 'needs_login'] as const)(
    'retains exact runtime grants for a %s connector', async (status) => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...connector, status })));
      const policy = await sandboxPolicyForWorkspace('workspace-1', { egress: { mode: 'open' } });
      expect(policy.privateRoutes).toEqual([{ connectorId: 'connector-1', host: 'db.corp', port: 5432 }]);
      expect(policy.egress).toEqual({ mode: 'open' });
    },
  );

  it.each([403, 409, 503])('refuses runtime policy when route lookup returns %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'private_routes_unavailable' }, { status })));
    await expect(sandboxPolicyForWorkspace('workspace-1', { egress: { mode: 'open' } })).rejects.toMatchObject({ status });
  });

  it('refuses runtime grants from another workspace', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...connector, workspaceId: 'other-workspace' })));
    await expect(sandboxPolicyForWorkspace('workspace-1', {})).rejects.toMatchObject({ code: 'workspace_mismatch' });
  });

  it('builds sandbox bodies with connected routes and unchanged public internet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(connector), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const built = await buildSandboxCreateBody({
      id: 'sandbox-1',
      workspaceId: 'workspace-1',
      provider: 'anthropic',
      model: 'Claude',
      creds: { claudeToken: 'claude-token' },
      githubToken: 'github-token',
      internetAccess: true,
      mcpServerIds: [],
    });
    expect(built).toMatchObject({
      ok: true,
      body: {
        workspaceId: 'workspace-1',
        policy: {
          version: 2,
          credentials: { openai: 'none' },
          egress: { mode: 'open' },
          privateRoutes: [{ connectorId: 'connector-1', host: 'db.corp', port: 5432 }],
        },
      },
    });
  });

  it('builds the existing sandbox policy when private routes are off', async () => {
    mocks.enabled = false;
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const built = await buildSandboxCreateBody({
      id: 'sandbox-1',
      workspaceId: 'workspace-1',
      provider: 'anthropic',
      model: 'Claude',
      creds: { claudeToken: 'claude-token' },
      githubToken: 'github-token',
      internetAccess: true,
      mcpServerIds: [],
    });
    expect(built).toMatchObject({
      ok: true,
      body: {
        workspaceId: 'workspace-1',
        policy: {
          credentials: { openai: 'none' },
          egress: { mode: 'open' },
        },
      },
    });
    if (!built.ok) throw new Error(built.error);
    expect(built.body.policy).not.toHaveProperty('privateRoutes');
    expect(request).not.toHaveBeenCalled();
  });

  it('treats a missing connector as disconnected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'connector not found',
      code: 'connector_not_found',
    }), { status: 404, headers: { 'content-type': 'application/json' } })));
    const policy = { egress: { mode: 'open' as const } };
    expect(await sandboxPolicyForWorkspace('workspace-1', policy)).toBe(policy);
  });

  it('does not expose an internal YAS error message', () => {
    const mapped = mapPrivateRoutesError(new FleetHttpError(
      'request to http://100.64.0.9 failed with gateway-token',
      500,
      'connector_failed',
    ));
    expect(mapped).toMatchObject({
      status: 500,
      code: 'connector_failed',
      message: 'Private routes are temporarily unavailable.',
    });
  });

  it('requires YAS to return 204 for a successful disconnect', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    await expect(new FleetClient('https://yas.test', 'gateway-token').deletePrivateConnector('workspace-1'))
      .rejects.toMatchObject({ status: 502, code: 'unexpected_status' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(new FleetClient('https://yas.test', 'gateway-token').deletePrivateConnector('workspace-1'))
      .resolves.toBeUndefined();
  });

  it.each([
    ['a non-array value', 'nope', []],
    ['a missing value', undefined, []],
    ['a null entry', [null], []],
    ['an array entry', [[]], []],
    ['a peer with no name, DNS name, or address', [{ os: 'linux' }], []],
    ['a peer with a name but no address', [{ name: 'lonely' }], []],
    [
      'a complete peer',
      [{ name: 'db-1', dnsName: 'db-1.tail.ts.net', addresses: ['100.64.0.5'], os: 'linux', online: true, subnetRoutes: ['10.0.0.0/24'] }],
      [{ name: 'db-1', dnsName: 'db-1.tail.ts.net', addresses: ['100.64.0.5'], os: 'linux', online: true, subnetRoutes: ['10.0.0.0/24'] }],
    ],
    [
      'a trailing DNS dot and missing optional fields',
      [{ name: 'db-1', dnsName: 'db-1.tail.ts.net.' }],
      [{ name: 'db-1', dnsName: 'db-1.tail.ts.net', addresses: [], os: '', online: false, subnetRoutes: [] }],
    ],
    [
      'a missing name taken from the DNS name',
      [{ dnsName: 'api.tail.ts.net', addresses: ['100.64.0.6'] }],
      [{ name: 'api', dnsName: 'api.tail.ts.net', addresses: ['100.64.0.6'], os: '', online: false, subnetRoutes: [] }],
    ],
    [
      'a missing name taken from the first address',
      [{ addresses: ['100.64.0.7', 7, ''] }],
      [{ name: '100.64.0.7', dnsName: '', addresses: ['100.64.0.7'], os: '', online: false, subnetRoutes: [] }],
    ],
    [
      'online values that are not true',
      [{ name: 'x', addresses: ['100.64.0.8'], online: 'yes', subnetRoutes: 'nope' }],
      [{ name: 'x', dnsName: '', addresses: ['100.64.0.8'], os: '', online: false, subnetRoutes: [] }],
    ],
  ])('normalizes peers with %s', (_label, input: unknown, expected) => {
    expect(normalizePrivatePeers(input)).toEqual(expected);
  });

  it('caps the peer list', () => {
    const many = Array.from({ length: 1_500 }, (_, index) => ({ name: `p${index}`, addresses: [`100.64.0.${index % 250}`] }));
    expect(normalizePrivatePeers(many)).toHaveLength(1_000);
  });

  it('reads peers from YAS', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      peers: [{ name: 'db-1', dnsName: 'db-1.tail.ts.net.', addresses: ['100.64.0.5'], os: 'linux', online: true, subnetRoutes: [] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await listPrivatePeers('workspace-1')).toEqual([
      { name: 'db-1', dnsName: 'db-1.tail.ts.net', addresses: ['100.64.0.5'], os: 'linux', online: true, subnetRoutes: [] },
    ]);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0]))
      .toBe('https://yas.test/v1/workspaces/workspace-1/private-connector/peers');
  });

  it.each([
    [409, 'connector_not_connected', 'The private connector is not connected.'],
    [409, 'conflict', 'The private connector cannot make that change in its current state.'],
    [404, 'connector_not_found', 'This workspace has no private connector.'],
  ])('maps a YAS %s %s error for peers', async (status, code, message) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: code, message: 'internal detail' }), {
      status,
      headers: { 'content-type': 'application/json' },
    })));
    await expect(listPrivatePeers('workspace-1')).rejects.toMatchObject({ status, code, message });
  });

  describe('connector read retry and cache', () => {
    const policy = { egress: { mode: 'open' as const } };
    const throttled = (retryAfter?: string) => new Response(JSON.stringify({ error: 'slow down' }), {
      status: 429,
      headers: retryAfter ? { 'retry-after': retryAfter } : {},
    });
    const notFound = () => Response.json({ code: 'connector_not_found' }, { status: 404 });
    const ok = (body: PrivateConnector = connector) => Response.json(body);

    function queueFetch(...answers: Array<() => Response>) {
      let index = 0;
      const mock = vi.fn(async () => answers[Math.min(index++, answers.length - 1)]());
      vi.stubGlobal('fetch', mock);
      return mock;
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    it.each([
      ['one throttle', [throttled], 1],
      ['two throttles', [throttled, throttled], 2],
    ])('retries after %s and then succeeds', async (_label, failures, retries) => {
      const mock = queueFetch(...failures.map((f) => () => f()), () => ok());
      const result = sandboxPolicyForWorkspace('workspace-1', policy);
      await vi.advanceTimersByTimeAsync(retries * 1_000);
      expect((await result).privateRoutes).toHaveLength(1);
      expect(mock).toHaveBeenCalledTimes(retries + 1);
    });

    it('gives up after two retries and returns the 429', async () => {
      const mock = queueFetch(() => throttled());
      const result = sandboxPolicyForWorkspace('workspace-1', policy);
      const assertion = expect(result).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(mock).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['no header', undefined, 1_000],
      ['a short Retry-After', '2', 2_000],
      ['a long Retry-After, capped at 5 s', '60', 5_000],
    ])('waits for %s', async (_label, header, expectedWait) => {
      const mock = queueFetch(() => throttled(header), () => ok());
      const result = sandboxPolicyForWorkspace('workspace-1', policy);
      await vi.advanceTimersByTimeAsync(expectedWait - 1);
      expect(mock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await result).privateRoutes).toHaveLength(1);
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it('does not retry a non-throttle error', async () => {
      const mock = queueFetch(() => Response.json({ error: 'x' }, { status: 403 }));
      await expect(sandboxPolicyForWorkspace('workspace-1', policy)).rejects.toMatchObject({ status: 403 });
      expect(mock).toHaveBeenCalledTimes(1);
    });

    it('serves a second call within 60 s from the cache', async () => {
      const mock = queueFetch(() => ok());
      await sandboxPolicyForWorkspace('workspace-1', policy);
      await vi.advanceTimersByTimeAsync(59_000);
      expect((await sandboxPolicyForWorkspace('workspace-1', policy)).privateRoutes).toHaveLength(1);
      expect(mock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await sandboxPolicyForWorkspace('workspace-1', policy);
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it('keeps one entry per workspace', async () => {
      const mock = queueFetch(() => ok(), () => ok({ ...connector, workspaceId: 'workspace-2' }));
      await sandboxPolicyForWorkspace('workspace-1', policy);
      await sandboxPolicyForWorkspace('workspace-2', policy);
      await sandboxPolicyForWorkspace('workspace-1', policy);
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it('caches a missing connector', async () => {
      const mock = queueFetch(notFound);
      expect(await sandboxPolicyForWorkspace('workspace-1', policy)).toBe(policy);
      expect(await sandboxPolicyForWorkspace('workspace-1', policy)).toBe(policy);
      expect(mock).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['startPrivateConnector', () => startPrivateConnector('workspace-1')],
      ['replacePrivateRoutes', () => replacePrivateRoutes('workspace-1', [{ host: 'db.corp', port: 5432 }])],
      ['deletePrivateConnector', () => deletePrivateConnector('workspace-1')],
      ['invalidatePrivateConnectorCache', async () => invalidatePrivateConnectorCache('workspace-1')],
    ])('drops the cache on %s', async (_label, write) => {
      const mock = queueFetch(notFound);
      await sandboxPolicyForWorkspace('workspace-1', policy);
      expect(mock).toHaveBeenCalledTimes(1);
      vi.stubGlobal('fetch', mock.mockImplementation(async () => new Response(null, { status: 204 })));
      mock.mockImplementation(async (_url, init) => {
        const method = (init as RequestInit | undefined)?.method ?? 'GET';
        return method === 'GET' ? ok() : method === 'DELETE' ? new Response(null, { status: 204 }) : ok();
      });
      await write();
      const before = mock.mock.calls.length;
      expect((await sandboxPolicyForWorkspace('workspace-1', policy)).privateRoutes).toHaveLength(1);
      expect(mock.mock.calls.length).toBe(before + 1);
    });

    it('does not cache a read that raced with a write', async () => {
      let release: (r: Response) => void = () => undefined;
      const mock = vi.fn()
        .mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }))
        .mockImplementation(async () => ok());
      vi.stubGlobal('fetch', mock);
      const pending = sandboxPolicyForWorkspace('workspace-1', policy);
      await vi.advanceTimersByTimeAsync(0);
      invalidatePrivateConnectorCache('workspace-1');
      release(notFound());
      await pending;
      expect((await sandboxPolicyForWorkspace('workspace-1', policy)).privateRoutes).toHaveLength(1);
    });

    it.each([
      ['a throttle', () => throttled()],
      ['a 502', () => Response.json({ error: 'bad gateway' }, { status: 502 })],
      ['a 503 capacity answer', () => Response.json({ error: 'full' }, { status: 503 })],
    ])('uses a connector cached 2 minutes ago when the fleet answers %s', async (_label, failure) => {
      queueFetch(() => ok());
      await sandboxPolicyForWorkspace('workspace-1', policy);
      await vi.advanceTimersByTimeAsync(120_000);
      const mock = queueFetch(failure);
      const result = sandboxPolicyForWorkspace('workspace-1', policy);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await result).privateRoutes).toHaveLength(1);
      expect(mock).toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it('uses a connector cached when the fleet is unreachable', async () => {
      queueFetch(() => ok());
      await sandboxPolicyForWorkspace('workspace-1', policy);
      await vi.advanceTimersByTimeAsync(120_000);
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
      expect((await sandboxPolicyForWorkspace('workspace-1', policy)).privateRoutes).toHaveLength(1);
    });

    it('does not use a connector cached more than 10 minutes ago', async () => {
      queueFetch(() => ok());
      await sandboxPolicyForWorkspace('workspace-1', policy);
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      queueFetch(() => Response.json({ error: 'bad gateway' }, { status: 502 }));
      await expect(sandboxPolicyForWorkspace('workspace-1', policy)).rejects.toMatchObject({ code: expect.any(String) });
      expect(console.warn).not.toHaveBeenCalled();
    });

    it('does not use a cached connector for a 403', async () => {
      queueFetch(() => ok());
      await sandboxPolicyForWorkspace('workspace-1', policy);
      await vi.advanceTimersByTimeAsync(120_000);
      queueFetch(() => Response.json({ error: 'x' }, { status: 403 }));
      await expect(sandboxPolicyForWorkspace('workspace-1', policy)).rejects.toMatchObject({ status: 403 });
    });

    it('refuses another workspace connector on every use, cached or not', async () => {
      queueFetch(() => ok({ ...connector, workspaceId: 'other-workspace' }));
      await expect(sandboxPolicyForWorkspace('workspace-1', policy)).rejects.toMatchObject({ code: 'workspace_mismatch' });
      await expect(sandboxPolicyForWorkspace('workspace-1', policy)).rejects.toMatchObject({ code: 'workspace_mismatch' });
    });

    it('keeps the flag gate ahead of the cache', async () => {
      const mock = queueFetch(() => ok());
      await sandboxPolicyForWorkspace('workspace-1', policy);
      mocks.enabled = false;
      expect(await sandboxPolicyForWorkspace('workspace-1', policy)).toBe(policy);
      expect(mock).toHaveBeenCalledTimes(1);
    });
  });
});
