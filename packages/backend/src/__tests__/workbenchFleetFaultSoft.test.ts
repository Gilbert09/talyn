import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { eq } from 'drizzle-orm';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn } from './helpers/fakeFleet.js';
import { repositories, workbenches, workspaces } from '../db/schema.js';

/** Passive reads (config) and the wake prefetch answer quietly while the fleet has no room or is out of reach. */

vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: () => undefined,
}));
vi.mock('../services/selfHosted/credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/selfHosted/credentials.js')>()),
  getSelfHostedCredentials: async () => ({ claudeToken: 'sk-ant-oat-claude', openaiKey: 'oa-codex' }),
  fleetAgentStatus: async () => ({ connectedAgents: ['claude', 'codex'], reauthAgents: [] }),
}));
vi.mock('../services/cloudProviders/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/cloudProviders/registry.js')>()),
  getCloudProvider: () => ({ type: 'selfhosted' }),
}));
vi.mock('../services/repoDefaultBranch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/repoDefaultBranch.js')>()),
  reconcileDefaultBranch: async (input: { stored: string }) => input.stored || 'main',
}));

const { settleArchivesForTests } = await import('../services/workbenches/lifecycle.js');
const { memoryWorkObjectStore, setWorkObjectStoreForTests } = await import('../services/workbenches/workStorage.js');
const { workbenchRoutes } = await import('../routes/workbenches.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { githubService } = await import('../services/github.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { setWorkbenchFleetClientForTests } = await import('../services/workbenches/sandboxRuntime.js');
const { resetSandboxStatusCacheForTests } = await import('../services/workbenches/sandboxStatus.js');
const { resetChangesSnapshotsForTests } = await import('../services/workbenches/changesSnapshot.js');
const { resetChangesStoreForTests } = await import('../services/workbenches/changesStore.js');
const { resetChangesStoredForTests } = await import('../services/workbenches/changesStored.js');
const { getWorkbench } = await import('../services/workbenches/store.js');
const { FleetCapacityError, FleetThrottleError, FleetHttpError } = await import('../services/selfHosted/client.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

describe('a fleet fault on a passive read', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;
  let fleet: FakeFleet;
  let store: ReturnType<typeof memoryWorkObjectStore>;

  async function call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
    const resp = await fetch(`${base}${path}`, {
      method,
      headers: {
        'x-user': 'owner-a',
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await resp.text();
    let body: Loose = text;
    try { body = JSON.parse(text); } catch { /* a proxied answer */ }
    return { status: resp.status, body };
  }

  async function readySession(): Promise<Loose> {
    const res = await call('POST', '/workbenches', {
      body: { workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude' },
    });
    expect(res.status).toBe(200);
    const id = res.body.data.id as string;
    await vi.waitFor(async () => expect((await getWorkbench(id))?.status).toBe('ready'), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    resetSandboxStatusCacheForTests();
    return (await getWorkbench(id))!;
  }

  beforeEach(async () => {
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    vi.stubEnv('FLEET_API_TOKEN', 'fleet-token');
    vi.stubEnv('FLEET_PINNED_ENDPOINT', '');
    vi.stubEnv('FLEET_GATEWAY_TOKEN', '');
    vi.stubEnv('FLEET_ALLOWED', 'true');
    resetFeatureFlagsForTests();
    resetSandboxStatusCacheForTests();
    resetChangesSnapshotsForTests();
    resetChangesStoreForTests();
    resetChangesStoredForTests();
    store = memoryWorkObjectStore();
    setWorkObjectStoreForTests(store);
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    await testDb.db.insert(repositories).values({
      id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main',
    });
    vi.spyOn(githubService, 'branchExists').mockResolvedValue(false);
    vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    fleet = new FakeFleet();
    fleet.handler = async (script) => {
      if (isAgentTurn(script)) return { stdout: claudeTurnLines('sess-1', 'done') };
      if (script.includes('git commit-tree')) return { stdout: `${'c'.repeat(40)}\n` };
      return { exitCode: 0, stdout: '' };
    };
    // The port proxy: an exec-like call, which the fleet's `ensureRunning` answers by waking the box.
    Object.assign(fleet, { proxyPort: async () => new Response('app') });
    setWorkbenchFleetClientForTests(async () => fleet.asClient());

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const id = req.headers['x-user'] as string;
      req.user = { id, email: `${id}@example.test`, isAdmin: false };
      next();
    });
    app.use('/workbenches', wrapAsyncRoutes(workbenchRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await settleArchivesForTests();
    setWorkObjectStoreForTests(null);
    setWorkbenchFleetClientForTests(null);
    await new Promise((resolve) => server.close(resolve));
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
  });

  const faults = [
    ['no capacity', () => new FleetCapacityError('no free sandbox', undefined, 'no_capacity')],
    ['host unreachable', () => new FleetCapacityError('could not reach the host', undefined, 'unreachable')],
    ['throttled', () => new FleetThrottleError('slow down')],
    ['fleet http 502', () => new FleetHttpError('bad gateway', 502)],
  ] as const;

  it.each(faults)('answers the default config, marked, when a config read hits %s', async (_name, make) => {
    const wb = await readySession();
    fleet.handler = async () => { throw make(); };
    const res = await call('GET', `/workbenches/${wb.id}/config?live=1`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ source: 'none', run: [], unavailable: true });
  });

  it('answers the config without a marker when the box answers', async () => {
    const wb = await readySession();
    const res = await call('GET', `/workbenches/${wb.id}/config`);
    expect(res.status).toBe(200);
    expect(res.body.data.unavailable).toBeUndefined();
  });

  it('keeps refusing a config read for a session that is not ready', async () => {
    const wb = await readySession();
    await testDb.db.update(workbenches).set({ status: 'provisioning' }).where(eq(workbenches.id, wb.id));
    const res = await call('GET', `/workbenches/${wb.id}/config?live=1`);
    expect([res.status, res.body.code]).toEqual([409, 'not_ready']);
  });

  it.each(faults)('answers a wake with status unavailable when the fleet hits %s', async (_name, make) => {
    const wb = await readySession();
    fleet.getSandbox = async () => { throw make(); };
    const res = await call('POST', `/workbenches/${wb.id}/wake`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'unavailable' });
  });

  it('still fails a wake for a fault that is not the fleet', async () => {
    const wb = await readySession();
    fleet.getSandbox = async () => { throw new Error('boom'); };
    const res = await call('POST', `/workbenches/${wb.id}/wake`);
    expect(res.status).toBe(500);
  });
});
