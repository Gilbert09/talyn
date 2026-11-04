import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { eq } from 'drizzle-orm';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn } from './helpers/fakeFleet.js';
import { repositories, workbenches, workspaces } from '../db/schema.js';

/**
 * Opening a session must never wake its sleeping box. Every read the app
 * sends when a session opens or a tab shows goes to the routes here, against
 * a box the fleet reports suspended, and the fleet may be asked about the box
 * (`getSandbox`, which never wakes it) and nothing else.
 */

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
const { getWorkbench, listChats, listEvents } = await import('../services/workbenches/store.js');
const { readWorkMeta } = await import('../services/workbenches/workCheckpoint.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/** Calls that never wake a box: they read the fleet's record or manage the box itself. */
const NEVER_WAKES = new Set(['getSandbox', 'deleteSandbox']);

describe('opening a session with a sleeping box', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;
  let fleet: FakeFleet;
  let store: ReturnType<typeof memoryWorkObjectStore>;
  let calls: string[];

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

  /** A ready session, then put to sleep the way production does it: only the fleet's record changes. */
  async function sleepingSession(): Promise<Loose> {
    const res = await call('POST', '/workbenches', {
      body: { workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude' },
    });
    expect(res.status).toBe(200);
    const id = res.body.data.id as string;
    await vi.waitFor(async () => expect((await getWorkbench(id))?.status).toBe('ready'), { timeout: 5000 });
    // Let provisioning's own reads land before the box sleeps.
    await new Promise((resolve) => setTimeout(resolve, 50));
    fleet.sandboxStatus = 'suspended';
    resetSandboxStatusCacheForTests();
    calls.length = 0;
    fleet.execs.length = 0;
    return (await getWorkbench(id))!;
  }

  const wakingCalls = () => calls.filter((name) => !NEVER_WAKES.has(name));

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
    calls = [];
    const recorded = new Proxy(fleet, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function' || typeof prop !== 'string' || prop === 'asClient') return value;
        return (...args: unknown[]) => {
          calls.push(prop);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    setWorkbenchFleetClientForTests(async () => recorded.asClient());

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

  it('answers every read the app sends on open without waking the box', async () => {
    const wb = await sleepingSession();
    const chatId = (await listChats(wb.id))[0].id;
    // Nothing is stored for the files, the file or the diff: each one must still refuse rather than wake.
    store.objects.clear();
    resetChangesStoreForTests();
    resetChangesStoredForTests();
    const reads: Array<[string, Record<string, string>?]> = [
      ['/workbenches?workspaceId=ws-a'],
      [`/workbenches/${wb.id}`],
      [`/workbenches/chats/${chatId}/events?before=latest&limit=500`],
      [`/workbenches/chats/${chatId}/events?after=0`],
      [`/workbenches/${wb.id}/scripts/output`],
      [`/workbenches/${wb.id}/config`],
      [`/workbenches/${wb.id}/sandbox-status`],
      [`/workbenches/${wb.id}/timing`],
      [`/workbenches/${wb.id}/changes`],
      [`/workbenches/${wb.id}/files`],
      [`/workbenches/${wb.id}/file?path=src/a.ts`],
      [`/workbenches/${wb.id}/diff?path=src/a.ts`],
      [`/workbenches/${wb.id}/ports/3000/`, { 'x-talyn-no-wake': '1' }],
    ];
    const answers: Array<[string, number]> = [];
    for (const [path, headers] of reads) {
      const res = await call('GET', path, { headers });
      answers.push([path, res.status]);
    }
    // Let anything a read started in the background run.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(wakingCalls()).toEqual([]);
    expect(fleet.resumes).toBe(0);
    expect(fleet.execs).toHaveLength(0);
    // The reads answered: a refusal says the box sleeps, nothing failed on the box.
    for (const [path, status] of answers) expect([path, status < 500]).toEqual([path, true]);
    expect(answers.find(([path]) => path.endsWith('/changes'))?.[1]).toBe(409);
    expect(answers.find(([path]) => path.includes('/ports/'))?.[1]).toBe(409);
  });

  it.each([
    ['a refresh of the changes', 'GET', (id: string) => `/workbenches/${id}/changes?live=1`],
    ['a preview port the person opens', 'GET', (id: string) => `/workbenches/${id}/ports/3000/`],
    ['the Wake action', 'POST', (id: string) => `/workbenches/${id}/wake`],
  ])('still wakes the box for %s', async (_name, method, path) => {
    const wb = await sleepingSession();
    await call(method, path(wb.id));
    expect(wakingCalls().length + fleet.resumes).toBeGreaterThan(0);
  });

  describe('a manual archive', () => {
    const generation = 'g1';
    async function putCheckpoint(id: string) {
      const prefix = `ws-a/${id}/checkpoint`;
      await store.put(`${prefix}/${generation}/part-00000`, Buffer.from('bundle'));
      await store.put(`${prefix}/meta.json`, Buffer.from(JSON.stringify({
        version: 1, kind: 'checkpoint', sha: 'a'.repeat(40), base: null, branch: 'b', takenAt: new Date().toISOString(),
        size: 6, sha256: 'b'.repeat(64), parts: 1, generation,
      })));
    }
    const archiveNote = async (id: string) => {
      const chatId = (await listChats(id))[0].id;
      return (await listEvents(chatId, 0, 500)).events.find((e) => e.event.subtype === 'sleeping_archive')?.event;
    };

    it.each([
      ['suspended', () => undefined],
      ['hibernated', () => { fleet.hibernated = true; }],
    ])('of a %s box with a save newer than its last activity uses the save and never wakes it', async (_name, arrange) => {
      const wb = await sleepingSession();
      arrange();
      await putCheckpoint(wb.id);
      await testDb.db.update(workbenches).set({ workCheckedAt: new Date(Date.now() + 60_000) }).where(eq(workbenches.id, wb.id));
      const res = await call('POST', `/workbenches/${wb.id}/archive`);
      expect(res.status).toBe(200);
      await settleArchivesForTests();
      expect(wakingCalls()).toEqual([]);
      expect(fleet.resumes).toBe(0);
      expect(fleet.deleted).toEqual([wb.sandboxId]);
      const done = (await getWorkbench(wb.id))!;
      expect(done.archivedAt).not.toBeNull();
      expect(done.archivePendingAt).toBeNull();
      expect(await readWorkMeta({ workspaceId: 'ws-a', id: wb.id }, 'archive')).toMatchObject({ kind: 'archive', generation });
      expect(String((await archiveNote(wb.id))?.text)).toContain('archived the last saved copy');
    });

    it.each([
      ['no save was ever confirmed', null],
      ['the save is older than the last activity', -24 * 60 * 60_000],
    ])('of a sleeping box wakes it when %s, and says so', async (_name, offsetMs) => {
      const wb = await sleepingSession();
      await testDb.db.update(workbenches)
        .set({ workCheckedAt: offsetMs === null ? null : new Date(Date.now() + offsetMs) })
        .where(eq(workbenches.id, wb.id));
      const res = await call('POST', `/workbenches/${wb.id}/archive`);
      expect(res.status).toBe(200);
      await settleArchivesForTests();
      // The ordinary archive: the box is read and saved, which is what wakes it.
      expect(fleet.execs.length).toBeGreaterThan(0);
      expect((await getWorkbench(wb.id))?.settings).not.toMatchObject({ archiveFromSaved: true });
      expect(String((await archiveNote(wb.id))?.text)).toContain('woke it to save the work');
    });

    it('of a running box takes the ordinary archive with no note', async () => {
      const wb = await sleepingSession();
      fleet.sandboxStatus = 'idle';
      resetSandboxStatusCacheForTests();
      await call('POST', `/workbenches/${wb.id}/archive`);
      await settleArchivesForTests();
      expect(fleet.execs.length).toBeGreaterThan(0);
      expect(await archiveNote(wb.id)).toBeUndefined();
    });
  });
});
