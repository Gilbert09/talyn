import { describe, it, expect, afterEach } from 'vitest';
import {
  adminSandboxClient,
  FleetNotConfiguredError,
  HostUnknownError,
} from '../services/admin/fleetProxy.js';
import { createTestDb } from './helpers/testDb.js';

/**
 * Which fleet endpoint a run read or a Cancel goes to.
 *
 * A direct dial with FLEET_API_TOKEN resolves to the fleet's EMPTY tenant, so a
 * host asked directly cannot see a sandbox the gateway placed. The run detail
 * page and Cancel used to dial the host directly: the detail answered "no such
 * sandbox" for every gateway-placed box, and Cancel read that as "already gone"
 * and reported a success while the box kept running.
 */
const ENV = ['FLEET_PINNED_ENDPOINT', 'FLEET_GATEWAY_TOKEN', 'FLEET_API_TOKEN'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('adminSandboxClient', () => {
  it('goes through the gateway when one is configured, whatever host the page names', async () => {
    process.env.FLEET_PINNED_ENDPOINT = 'https://api.yetanothersandbox.dev/';
    process.env.FLEET_GATEWAY_TOKEN = 'gw-token';
    const { client, viaGateway } = await adminSandboxClient('-');
    expect(viaGateway).toBe(true);
    expect((client as unknown as { endpoint: string }).endpoint).toBe('https://api.yetanothersandbox.dev');
  });

  it('refuses rather than dialling a host when the gateway has no token', async () => {
    process.env.FLEET_PINNED_ENDPOINT = 'https://api.yetanothersandbox.dev';
    delete process.env.FLEET_GATEWAY_TOKEN;
    delete process.env.FLEET_API_TOKEN;
    await expect(adminSandboxClient('hetzner-64')).rejects.toBeInstanceOf(FleetNotConfiguredError);
  });

  it('dials the named host when there is no gateway', async () => {
    const { cleanup } = await createTestDb();
    try {
      delete process.env.FLEET_PINNED_ENDPOINT;
      process.env.FLEET_API_TOKEN = 'op-token';
      // No such host in the registry: the direct path is the one that looks it up.
      await expect(adminSandboxClient('hetzner-64')).rejects.toBeInstanceOf(HostUnknownError);
    } finally {
      await cleanup();
    }
  });
});
