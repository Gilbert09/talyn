import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import {
  CONCURRENT_BOX_LIMIT_ERROR_CODE,
  PLAN_LIMITS,
  SIZE_REQUIRES_PRO_ERROR_CODE,
  USAGE_EXHAUSTED_ERROR_CODE,
} from '@talyn/shared';
import type { UsageBudget } from '../services/billing/usage/charge.js';

const { getBudget } = vi.hoisted(() => ({ getBudget: vi.fn() }));
vi.mock('../services/billing/usage/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/billing/usage/index.js')>()),
  getBudget,
}));

// Loaded before anything else reaches the ledger, so the gate binds the mock
// rather than the module the mock's own factory imports.
import '../services/billing/entitlements.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn, type ExecReply } from './helpers/fakeFleet.js';
import { repositories, usageIntervals, workbenches, workspaces } from '../db/schema.js';

/**
 * The box gate on every path that starts or wakes a session box: create (a
 * session and a thread), each turn start, wake, retry and restore. A person
 * waits on each, so a refusal is a 402 with its notice; wake answers 200 with
 * the refusal because the client calls it on mount. A turn already running
 * is never stopped.
 */


vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: () => undefined,
}));

vi.mock('../services/selfHosted/credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/selfHosted/credentials.js')>()),
  getSelfHostedCredentials: async () => ({ claudeToken: 'sk-ant-oat-claude' }),
  fleetAgentStatus: async () => ({ connectedAgents: ['claude'], reauthAgents: [] }),
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
const { workbenchRoutes } = await import('../routes/workbenches.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { githubService } = await import('../services/github.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { setWorkbenchFleetClientForTests } = await import('../services/workbenches/sandboxRuntime.js');
const { getChat, getWorkbench, listChats, listEvents, payerBlockedSiblings, queuedIdleChats, updateWorkbench } = await import('../services/workbenches/store.js');
const { sweepOrphanedTurns, TURN_HELD_NOTE } = await import('../services/workbenches/turns.js');
const { resetBoxDeferralsForTests } = await import('../services/billing/boxDeferral.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const PERIOD_END = new Date('2026-12-01T00:00:00.000Z');
function budget(exhausted: boolean): UsageBudget {
  return {
    tier: 'free',
    period: { start: new Date('2026-11-01T00:00:00.000Z'), end: PERIOD_END },
    includedWsec: PLAN_LIMITS.free.includedBoxHours * 3600,
    usedWsec: 0,
    includedLeftWsec: exhausted ? 0 : 3600,
    creditMicros: 0,
    autoTopupPossible: false,
    exhausted,
  };
}

type Refusal = 'exhausted' | 'box cap' | 'size';
const CODE: Record<Refusal, string> = {
  exhausted: USAGE_EXHAUSTED_ERROR_CODE,
  'box cap': CONCURRENT_BOX_LIMIT_ERROR_CODE,
  size: SIZE_REQUIRES_PRO_ERROR_CODE,
};

describe('the box gate on sessions', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;
  let fleet: FakeFleet;
  let seq = 0;
  const savedPolar = process.env.POLAR_ACCESS_TOKEN;

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Loose }> {
    const resp = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-user': 'owner-a', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: resp.status, body: await resp.json() };
  }

  function scriptedFleet(turn: (script: string) => ExecReply | null = () => null): void {
    fleet.handler = async (script) => {
      const custom = turn(script);
      if (custom) return custom;
      if (isAgentTurn(script)) return { stdout: claudeTurnLines('sess-1', 'done') };
      if (script.includes('git commit-tree')) return { stdout: `${'c'.repeat(40)}\n` };
      return { exitCode: 0, stdout: '' };
    };
  }

  /** Other boxes the owner runs, by their open usage intervals. */
  async function openOtherBoxes(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await testDb.db.insert(usageIntervals).values({
        id: `iv-other-${++seq}`,
        ownerId: 'owner-a',
        subjectKind: 'workbench',
        subjectId: `other-${seq}`,
        sandboxId: `sb-other-${seq}`,
        size: 'standard',
        weight: '1.00',
        startedAt: new Date(),
        billedThrough: new Date(),
      });
    }
  }

  async function arrange(refusal: Refusal): Promise<void> {
    if (refusal === 'exhausted') getBudget.mockResolvedValue(budget(true));
    if (refusal === 'box cap') await openOtherBoxes(PLAN_LIMITS.free.concurrentBoxes);
    if (refusal === 'size') {
      await testDb.db.update(repositories).set({ settings: { sandboxSize: 'large' } }).where(eq(repositories.id, 'repo-a'));
    }
  }

  async function createSession(): Promise<Loose> {
    const res = await call('POST', '/workbenches', { workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude' });
    expect(res.status).toBe(200);
    await vi.waitFor(async () => expect((await getWorkbench(res.body.data.id))?.status).toBe('ready'), { timeout: 5000 });
    return res.body.data;
  }

  const chatIdOf = async (workbenchId: string) => (await listChats(workbenchId))[0].id;
  const idle = (chatId: string) =>
    vi.waitFor(async () => expect((await getChat(chatId))?.status).not.toBe('running'), { timeout: 5000 });

  /** Close the session box's own interval: it sleeps, so waking it adds a box. */
  async function putBoxToSleep(workbenchId: string): Promise<void> {
    await testDb.db
      .update(usageIntervals)
      .set({ endedAt: new Date() })
      .where(and(eq(usageIntervals.subjectId, workbenchId), isNull(usageIntervals.endedAt)));
  }

  beforeEach(async () => {
    process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
    getBudget.mockReset();
    getBudget.mockResolvedValue(budget(false));
    resetBoxDeferralsForTests();
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    vi.stubEnv('FLEET_API_TOKEN', 'fleet-token');
    vi.stubEnv('FLEET_PINNED_ENDPOINT', '');
    vi.stubEnv('FLEET_GATEWAY_TOKEN', '');
    vi.stubEnv('FLEET_ALLOWED', 'true');
    resetFeatureFlagsForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    // A chosen size, so sizing never reads GitHub.
    await testDb.db.insert(repositories).values({
      id: 'repo-a',
      workspaceId: 'ws-a',
      name: 'acme/app',
      url: 'https://github.com/acme/app',
      defaultBranch: 'main',
      settings: { sandboxSize: 'standard' },
    });
    vi.spyOn(githubService, 'branchExists').mockResolvedValue(false);
    vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    fleet = new FakeFleet();
    scriptedFleet();
    setWorkbenchFleetClientForTests(async () => fleet.asClient());

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'owner-a', email: 'owner-a@example.test', isAdmin: false };
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
    setWorkbenchFleetClientForTests(null);
    await new Promise((resolve) => server.close(resolve));
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
    if (savedPolar === undefined) delete process.env.POLAR_ACCESS_TOKEN;
    else process.env.POLAR_ACCESS_TOKEN = savedPolar;
  });

  describe('create', () => {
    it.each<Refusal>(['exhausted', 'box cap', 'size'])('a session: %s → 402 with the notice, nothing inserted', async (refusal) => {
      await arrange(refusal);
      const res = await call('POST', '/workbenches', { workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude' });
      expect(res.status).toBe(402);
      expect(res.body.code).toBe(CODE[refusal]);
      expect(res.body.notice).toMatchObject({ code: CODE[refusal], workspaceId: 'ws-a' });
      expect(await testDb.db.select({ id: workbenches.id }).from(workbenches)).toHaveLength(0);
      expect(fleet.created).toHaveLength(0);
    });

    it.each<Refusal>(['exhausted', 'box cap'])('a thread: %s → 402', async (refusal) => {
      await arrange(refusal);
      const res = await call('POST', '/workbenches', { workspaceId: 'ws-a', kind: 'thread', runtime: 'sandbox', agent: 'claude' });
      expect(res.status).toBe(402);
      expect(res.body.code).toBe(CODE[refusal]);
    });

    it('a thread is small: a size the repository asks for does not apply', async () => {
      await arrange('size');
      const res = await call('POST', '/workbenches', { workspaceId: 'ws-a', kind: 'thread', runtime: 'sandbox', agent: 'claude' });
      expect(res.status).toBe(200);
    });

    it('a local session runs on the person\'s machine: never gated', async () => {
      await arrange('exhausted');
      const res = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'local', agent: 'claude', deviceId: 'dev-1', localPath: '/tmp/wt',
      });
      expect(res.status).toBe(200);
    });

    it('billing off: nothing is checked', async () => {
      delete process.env.POLAR_ACCESS_TOKEN;
      await arrange('exhausted');
      await arrange('box cap');
      expect((await call('POST', '/workbenches', { workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude' })).status).toBe(200);
      expect(getBudget).not.toHaveBeenCalled();
    });
  });

  describe('a turn start', () => {
    it.each<[string, boolean, Refusal | null, number]>([
      // [label, box awake?, refusal, expected status]
      ['awake box, budget left', true, null, 200],
      ['awake box, out of hours', true, 'exhausted', 402],
      // The box is already counted: a full cap does not stop a turn on it.
      ['awake box, at the box cap', true, 'box cap', 200],
      ['sleeping box, at the box cap', false, 'box cap', 402],
      ['sleeping box, out of hours', false, 'exhausted', 402],
      // The box exists: its size is never checked again.
      ['awake box, a size the plan cannot start', true, 'size', 200],
    ])('%s → %s', async (_label, awake, refusal, status) => {
      const wb = await createSession();
      const chatId = await chatIdOf(wb.id);
      if (!awake) await putBoxToSleep(wb.id);
      if (refusal) await arrange(refusal);
      const before = await getChat(chatId);

      const res = await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'go' });

      expect(res.status).toBe(status);
      if (status === 402) {
        expect(res.body.code).toBe(CODE[refusal!]);
        expect(res.body.notice.code).toBe(CODE[refusal!]);
        // Refused before it queued: the composer keeps the text, no turn ran.
        const after = await getChat(chatId);
        expect(after?.queuedMessages).toEqual([]);
        expect(after?.turnCount).toBe(before?.turnCount);
        expect(fleet.execs.some((e) => isAgentTurn(e.script))).toBe(false);
      } else {
        await idle(chatId);
        expect(fleet.execs.some((e) => isAgentTurn(e.script))).toBe(true);
      }
    });

    it('a running turn is never stopped; the queued message behind it is held, with a note', async () => {
      const releases: Array<() => void> = [];
      scriptedFleet((script) =>
        isAgentTurn(script) ? { stdout: claudeTurnLines('sess-1', 'ok'), hold: new Promise<void>((r) => releases.push(r)) } : null
      );
      const wb = await createSession();
      const chatId = await chatIdOf(wb.id);
      const post = (text: string) => call('POST', `/workbenches/chats/${chatId}/messages`, { text });

      expect((await post('one')).body.data).toEqual({ queued: false });
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      // The hours run out mid-turn. The message behind the turn still queues:
      // that box is paid for until the turn ends.
      getBudget.mockResolvedValue(budget(true));
      expect((await post('two')).body.data).toEqual({ queued: true });

      releases[0]();
      await idle(chatId);

      // The first turn finished normally…
      const chat = await getChat(chatId);
      expect(chat?.turnCount).toBe(1);
      expect(fleet.execs.filter((e) => isAgentTurn(e.script))).toHaveLength(1);
      // …and the next one did not start: still queued, and the chat says why.
      expect(chat?.status).toBe('idle');
      expect(chat?.queuedMessages.map((m) => m.text)).toEqual(['two']);
      const heldNotes = async () => (await listEvents(chatId, 0, 500)).events
        .filter((e) => e.event.type === 'system' && e.event.subtype === 'usage_exhausted');
      await vi.waitFor(async () => {
        const notes = await heldNotes();
        expect(notes).toHaveLength(1);
        expect(notes[0].event.text).toContain(TURN_HELD_NOTE);
      });

      // Neither the queue sweep nor another chat's completed turn can retry it.
      expect(await queuedIdleChats()).toEqual([]);
      expect(await payerBlockedSiblings(wb.id, 'another-chat')).toEqual([]);
      const budgetChecks = getBudget.mock.calls.length;
      for (let i = 0; i < 3; i++) await sweepOrphanedTurns();
      expect(getBudget).toHaveBeenCalledTimes(budgetChecks);
      expect(await heldNotes()).toHaveLength(1);
      expect((await getChat(chatId))?.queuedMessages.map((m) => m.text)).toEqual(['two']);
      expect(releases).toHaveLength(1);

      // Once credit is available, a new message retries the held message first.
      getBudget.mockResolvedValue(budget(false));
      expect((await post('three')).body.data).toEqual({ queued: true });
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      expect((await getChat(chatId))?.queuedMessages.map((m) => m.text)).toEqual(['three']);
      releases[1]();
      await vi.waitFor(() => expect(releases).toHaveLength(3));
      releases[2]();
      await idle(chatId);
      expect((await getChat(chatId))?.turnCount).toBe(3);
      expect((await getChat(chatId))?.queuedMessages).toEqual([]);
      expect(await heldNotes()).toHaveLength(1);
    });
  });

  describe('wake', () => {
    it.each<[string, Refusal | null, string]>([
      ['budget left', null, 'resuming'],
      ['out of hours', 'exhausted', 'exhausted'],
      ['at the box cap', 'box cap', 'box_limit'],
    ])('a suspended box, %s → %s', async (_label, refusal, expected) => {
      const wb = await createSession();
      await putBoxToSleep(wb.id);
      fleet.sandboxStatus = 'suspended';
      if (refusal) await arrange(refusal);

      const res = await call('POST', `/workbenches/${wb.id}/wake`);

      expect(res.body.data.status).toBe(expected);
      if (refusal) {
        // 200 with the refusal: the client calls this on mount.
        expect(res.status).toBe(200);
        expect(res.body.data.notice.code).toBe(CODE[refusal]);
        await new Promise((r) => setTimeout(r, 50));
        expect(fleet.resumes).toBe(0);
      }
    });

    it('an awake box needs nothing', async () => {
      const wb = await createSession();
      await arrange('exhausted');
      const res = await call('POST', `/workbenches/${wb.id}/wake`);
      expect(res.body.data.status).toBe('awake');
    });
  });

  describe('retry and restore', () => {
    it.each<Refusal>(['exhausted', 'box cap', 'size'])('retry after a failed start: %s → 402, the session stays failed', async (refusal) => {
      const wb = await createSession();
      await updateWorkbench(wb.id, { status: 'error' });
      await putBoxToSleep(wb.id);
      await arrange(refusal);
      const created = fleet.created.length;

      const res = await call('POST', `/workbenches/${wb.id}/retry`);

      expect(res.status).toBe(402);
      expect(res.body.code).toBe(CODE[refusal]);
      expect((await getWorkbench(wb.id))?.status).toBe('error');
      expect(fleet.created).toHaveLength(created);
    });

    it.each<Refusal>(['exhausted', 'box cap'])('restore from archive: %s → 402, still archived', async (refusal) => {
      const wb = await createSession();
      await updateWorkbench(wb.id, { archivedAt: new Date(), status: 'archived' });
      await putBoxToSleep(wb.id);
      await arrange(refusal);

      const res = await call('POST', `/workbenches/${wb.id}/restore`);

      expect(res.status).toBe(402);
      expect(res.body.code).toBe(CODE[refusal]);
      expect((await getWorkbench(wb.id))?.archivedAt).toBeTruthy();
    });
  });

  describe('resize', () => {
    it('a size the plan cannot start → 402; a replacement needs no budget or slot', async () => {
      const wb = await createSession();
      await arrange('exhausted');
      await arrange('box cap');
      const large = await call('PUT', `/workbenches/${wb.id}/sandbox-size`, { size: 'large' });
      expect(large.status).toBe(402);
      expect(large.body.code).toBe(SIZE_REQUIRES_PRO_ERROR_CODE);
      const small = await call('PUT', `/workbenches/${wb.id}/sandbox-size`, { size: 'small' });
      expect(small.status).toBe(200);
    });
  });
});
