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
  mapPrivateRoutesError,
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
    expect(composePrivateRoutesPolicy(policy, { ...connector, status: 'connecting' })).toBe(policy);
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

  it('adds only routes from a connected workspace connector', async () => {
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
});
