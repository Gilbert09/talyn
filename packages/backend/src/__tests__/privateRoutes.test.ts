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
  listPrivatePeers,
  mapPrivateRoutesError,
  normalizePrivatePeers,
  sandboxPolicyForWorkspace,
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
});
