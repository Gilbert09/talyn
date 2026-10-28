import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Environment, Task } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  environments as environmentsTable,
  fleetAccounts,
  repositories as repositoriesTable,
  tasks as tasksTable,
  workbenches as workbenchesTable,
  workspaces as workspacesTable,
} from '../db/schema.js';

/**
 * A run on the fleet, from its dispatch to the moment its account fills up.
 *
 * - The dispatch picks the account by usage and records which one it used.
 * - A re-credential and a host pull give back the RECORDED account.
 * - The poll tick moves a running task to the next account of the same agent
 *   as soon as its account crosses the threshold, and a workbench turn does
 *   the same while it runs. The push replaces the whole credential set, so it
 *   must carry the MCP secrets, and it never changes vendor.
 */

const fleet = vi.hoisted(() => ({
  createSandbox: vi.fn(),
  getSandbox: vi.fn(),
  getEvents: vi.fn(),
  setSandboxCredentials: vi.fn(),
}));

vi.mock('../services/selfHosted/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/selfHosted/client.js')>();
  return {
    ...actual,
    FleetClient: class {
      createSandbox = fleet.createSandbox;
      getSandbox = fleet.getSandbox;
      getEvents = fleet.getEvents;
      setSandboxCredentials = fleet.setSandboxCredentials;
    },
  };
});
vi.mock('../services/github.js', () => ({
  githubService: { getVerifiedAccessToken: vi.fn(async () => 'gho_token') },
}));
vi.mock('../services/repoDefaultBranch.js', () => ({
  reconcileDefaultBranch: vi.fn(async () => 'main'),
}));
vi.mock('../services/mcpServers/dispatch.js', () => ({
  mcpIntegrationSecrets: vi.fn(async () => ({ linear: 'mcp-secret' })),
  mcpServerIdsFromMetadata: vi.fn(() => null),
}));
vi.mock('../services/httpTimeout.js', () => ({ fetchWithTimeout: vi.fn() }));

const accounts = await import('../services/selfHosted/accounts.js');
const { dispatchTaskToFleet } = await import('../services/selfHosted/executor.js');
const { selfHostedPoller } = await import('../services/selfHosted/poller.js');
const { resolveRunCredentials } = await import('../services/selfHosted/runCredentials.js');
const hotSwap = await import('../services/selfHosted/hotSwap.js');
const { setUsageFetchForTests } = await import('../services/selfHosted/accountSelection.js');
const { drainTaskMetadata } = await import('../services/taskMetadataMutex.js');
const { encryptString } = await import('../services/tokenCrypto.js');
const runtime = await import('../services/workbenches/sandboxRuntime.js');
const { resolveWorkbenchRunCredentials } = await import('../services/workbenches/runCredentials.js');
const { getWorkbench } = await import('../services/workbenches/store.js');

type Kind = import('../services/selfHosted/accounts.js').FleetAccountKind;
type Window = import('../services/selfHosted/accounts.js').FleetUsageWindow;
type CloudTaskRow = import('../services/cloudProviders/types.js').CloudTaskRow;

const WS = 'ws1';
const ENV = { id: 'fleet1', type: 'selfhosted', config: {} } as unknown as Environment;

function win(usedPercent: number, label = '5-hour'): Window {
  return { key: label, label, usedPercent, resetsAt: null };
}

describe('fleet accounts on a running run', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ['TALYN_TOKEN_KEY', 'FLEET_API_TOKEN', 'FLEET_PINNED_ENDPOINT']) saved[k] = process.env[k];
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    process.env.FLEET_API_TOKEN = 'fleet-token';
    process.env.FLEET_PINNED_ENDPOINT = 'https://fleet.test';
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({
      id: WS,
      ownerId: TEST_USER_ID,
      name: 'ws',
      settings: { fleetSwitchAtPercent: 95 },
    });
    await db.insert(environmentsTable).values({
      id: 'fleet1',
      ownerId: TEST_USER_ID,
      name: 'Talyn Fleet',
      type: 'selfhosted',
      status: 'connected',
      config: { type: 'selfhosted' },
    });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: WS,
      name: 'acme/widgets',
      url: 'https://github.com/acme/widgets',
      defaultBranch: 'main',
    });
    for (const f of Object.values(fleet)) f.mockReset();
    fleet.createSandbox.mockImplementation(async (input: { id: string }) => ({
      sandbox: { id: input.id, status: 'starting', workspaceId: WS },
      host: 'host-1',
    }));
    fleet.getEvents.mockResolvedValue({ events: [] });
    fleet.setSandboxCredentials.mockResolvedValue(undefined);
    // Every snapshot below is fresh, so no vendor is ever asked.
    setUsageFetchForTests(vi.fn(async () => new Response('unexpected', { status: 500 })));
    hotSwap.resetHotSwapChecksForTests();
  });
  afterEach(async () => {
    setUsageFetchForTests(undefined);
    await drainTaskMetadata();
    await cleanup();
  });

  async function add(kind: Kind, label: string, usedPercent?: number) {
    const credential =
      kind === 'claude_oauth' || kind === 'codex_oauth'
        ? {
            accessTokenEnc: encryptString(`tok-${label}`),
            refreshTokenEnc: encryptString(`r-${label}`),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            ...(kind === 'codex_oauth' ? { accountId: 'chatgpt-1' } : {}),
          }
        : { keyEnc: encryptString(`tok-${label}`) };
    const account = await accounts.addFleetAccount(WS, { kind, credential, label });
    if (usedPercent !== undefined) {
      await accounts.setFleetAccountUsage(account.id, {
        fetchedAt: new Date().toISOString(),
        windows: [win(usedPercent)],
      });
    }
    return account;
  }

  async function setUsage(accountId: string, usedPercent: number) {
    await accounts.setFleetAccountUsage(accountId, {
      fetchedAt: new Date().toISOString(),
      windows: [win(usedPercent)],
    });
  }

  function task(metadata: Record<string, unknown> = {}): Task {
    return {
      id: 't1',
      workspaceId: WS,
      type: 'code_writing',
      status: 'queued',
      priority: 'medium',
      title: 'work',
      description: 'd',
      prompt: 'do it',
      repositoryId: 'repo1',
      metadata: { model: 'claude-sonnet-5', ...metadata },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as Task;
  }

  async function seedTask(metadata: Record<string, unknown>) {
    await db.insert(tasksTable).values({
      id: 't1',
      workspaceId: WS,
      type: 'code_writing',
      status: 'in_progress',
      priority: 'medium',
      title: 'work',
      description: 'd',
      prompt: 'do it',
      repositoryId: 'repo1',
      metadata,
    });
  }

  async function taskMeta(): Promise<Record<string, unknown>> {
    await drainTaskMetadata();
    const [row] = await db
      .select({ metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.id, 't1'));
    return (row?.metadata ?? {}) as Record<string, unknown>;
  }

  const extraOf = (meta: Record<string, unknown>) =>
    ((meta.cloudTask as { extra?: Record<string, unknown> } | undefined)?.extra ?? {}) as Record<
      string,
      unknown
    >;

  function runningRow(extra: Record<string, unknown>): CloudTaskRow {
    return {
      id: 't1',
      workspaceId: WS,
      title: 'work',
      repositoryId: null,
      metadata: {
        cloudTask: { provider: 'selfhosted', status: 'running', remoteTaskId: 'talyn-t1', extra },
      },
      transcriptFinal: false,
      watched: false,
      status: 'in_progress',
      completedAt: null,
      updatedAt: new Date(),
    } as CloudTaskRow;
  }

  function sandboxRunning(adoptedAt?: string) {
    fleet.getSandbox.mockResolvedValue({
      sandbox: {
        id: 'talyn-t1',
        status: 'busy',
        workspaceId: WS,
        ...(adoptedAt ? { adopted: true, adoptedAt } : {}),
      },
    });
  }

  describe('dispatch', () => {
    it.each([
      ['A is under the threshold', 50, 'A'],
      ['A is at the threshold', 95, 'B'],
      ['A is over it', 99, 'B'],
    ])('picks by usage when %s, and records the account', async (_label, aUsed, expected) => {
      await seedTask({ model: 'claude-sonnet-5' });
      const a = await add('claude_oauth', 'A', aUsed);
      const b = await add('claude_oauth', 'B', 5);
      expect(await dispatchTaskToFleet(task(), ENV)).toEqual({ ok: true });

      const body = fleet.createSandbox.mock.calls[0]![0] as { anthropicKey?: string; openaiKey?: string };
      expect(body.anthropicKey).toBe(`tok-${expected}`);
      expect(body.openaiKey).toBeUndefined();
      expect(extraOf(await taskMeta()).accountId).toBe(expected === 'A' ? a.id : b.id);
    });

    it('moves to the other agent when every account of this one is over', async () => {
      await seedTask({ model: 'claude-sonnet-5' });
      await add('claude_oauth', 'A', 99);
      await add('claude_oauth', 'B', 97);
      const c = await add('codex_oauth', 'C', 10);
      expect(await dispatchTaskToFleet(task(), ENV)).toEqual({ ok: true });

      const body = fleet.createSandbox.mock.calls[0]![0] as {
        openaiKey?: string;
        anthropicKey?: string;
        task: { provider: string };
      };
      expect(body.openaiKey).toBe('tok-C');
      expect(body.anthropicKey).toBeUndefined();
      expect(body.task.provider).toBe('openai');
      expect(extraOf(await taskMeta()).accountId).toBe(c.id);
    });

    it('runs on the least-full account rather than refusing, when nothing else can take it', async () => {
      await seedTask({ model: 'claude-sonnet-5' });
      const a = await add('claude_oauth', 'A', 99);
      await add('claude_oauth', 'B', 97);
      expect(await dispatchTaskToFleet(task(), ENV)).toEqual({ ok: true });
      const body = fleet.createSandbox.mock.calls[0]![0] as { anthropicKey?: string };
      expect(body.anthropicKey).toBe('tok-A');
      expect(extraOf(await taskMeta()).accountId).toBe(a.id);
    });

    it('avoids an account a failover already tried on this task', async () => {
      const a = await add('claude_oauth', 'A', 10);
      const b = await add('claude_oauth', 'B', 10);
      const meta = { model: 'claude-sonnet-5', quotaFailover: { tried: [`fleet:claude:${a.id}`] } };
      await seedTask(meta);
      expect(await dispatchTaskToFleet(task(meta), ENV)).toEqual({ ok: true });
      const body = fleet.createSandbox.mock.calls[0]![0] as { anthropicKey?: string };
      expect(body.anthropicKey).toBe('tok-B');
      expect(extraOf(await taskMeta()).accountId).toBe(b.id);
    });
  });

  describe('findHotSwap', () => {
    it('moves a run whose account crossed the threshold, and says why', async () => {
      const a = await add('claude_oauth', 'Work', 96);
      const b = await add('claude_oauth', 'Personal', 10);
      const decision = await hotSwap.findHotSwap({
        key: 'k',
        workspaceId: WS,
        agent: 'claude',
        currentAccountId: a.id,
      });
      expect(decision?.to.id).toBe(b.id);
      expect(decision?.token).toBe('tok-Personal');
      expect(decision?.note).toBe('Switched to Personal because Work reached 96% of its 5-hour limit.');
    });

    it.each([
      ['the account is under the threshold', 94, 10],
      ['every other account is over too', 96, 99],
    ])('does nothing when %s', async (_label, aUsed, bUsed) => {
      const a = await add('claude_oauth', 'A', aUsed);
      await add('claude_oauth', 'B', bUsed);
      expect(
        await hotSwap.findHotSwap({ key: 'k', workspaceId: WS, agent: 'claude', currentAccountId: a.id }),
      ).toBeNull();
    });

    it('never moves a run to the other vendor', async () => {
      const a = await add('claude_oauth', 'A', 99);
      await add('codex_oauth', 'C', 1);
      expect(
        await hotSwap.findHotSwap({ key: 'k', workspaceId: WS, agent: 'claude', currentAccountId: a.id }),
      ).toBeNull();
    });

    it('never moves a run with no account recorded', async () => {
      await add('claude_oauth', 'A', 99);
      await add('claude_oauth', 'B', 1);
      expect(
        await hotSwap.findHotSwap({ key: 'k', workspaceId: WS, agent: 'claude', currentAccountId: undefined }),
      ).toBeNull();
    });

    it('checks one run at most once a minute', async () => {
      const a = await add('claude_oauth', 'A', 10);
      await add('claude_oauth', 'B', 10);
      const target = { key: 'k', workspaceId: WS, agent: 'claude' as const, currentAccountId: a.id };
      const t0 = Date.now();
      expect(await hotSwap.findHotSwap(target, t0)).toBeNull();
      await setUsage(a.id, 99);
      expect(await hotSwap.findHotSwap(target, t0 + 30_000)).toBeNull();
      expect(await hotSwap.findHotSwap(target, t0 + 59_999)).toBeNull();
      expect((await hotSwap.findHotSwap(target, t0 + 60_000))?.to.label).toBe('B');
    });

    it('rate-limits each run on its own', async () => {
      const a = await add('claude_oauth', 'A', 99);
      await add('claude_oauth', 'B', 10);
      const now = Date.now();
      expect(await hotSwap.findHotSwap({ key: 'run-1', workspaceId: WS, agent: 'claude', currentAccountId: a.id }, now)).not.toBeNull();
      expect(await hotSwap.findHotSwap({ key: 'run-2', workspaceId: WS, agent: 'claude', currentAccountId: a.id }, now)).not.toBeNull();
    });
  });

  describe('the poll tick', () => {
    it('pushes the next account with the whole credential set, and records it', async () => {
      const a = await add('claude_oauth', 'A', 97);
      const b = await add('claude_oauth', 'B', 10);
      const extra = { repo: 'acme/widgets', llm: 'anthropic', model: 'claude-sonnet-5', accountId: a.id };
      await seedTask({ cloudTask: { provider: 'selfhosted', status: 'running', remoteTaskId: 'talyn-t1', extra } });
      sandboxRunning();

      await selfHostedPoller.reconcileTask(runningRow(extra));

      expect(fleet.setSandboxCredentials).toHaveBeenCalledTimes(1);
      expect(fleet.setSandboxCredentials).toHaveBeenCalledWith('talyn-t1', {
        githubToken: 'gho_token',
        anthropicKey: 'tok-B',
        repo: 'acme/widgets',
        integrations: { linear: 'mcp-secret' },
      });
      const meta = await taskMeta();
      expect(extraOf(meta).accountId).toBe(b.id);
      expect(meta.accountSwitch).toMatchObject({
        from: a.id,
        to: b.id,
        note: 'Switched to B because A reached 97% of its 5-hour limit.',
      });
      selfHostedPoller.stopStreaming('t1');
    });

    it('does not push a Claude key into a Codex run', async () => {
      const c = await add('codex_oauth', 'C', 99);
      await add('claude_oauth', 'A', 1);
      const extra = { repo: 'acme/widgets', llm: 'openai', model: 'gpt-6.1-sol', accountId: c.id };
      await seedTask({ cloudTask: { provider: 'selfhosted', status: 'running', remoteTaskId: 'talyn-t1', extra } });
      sandboxRunning();

      await selfHostedPoller.reconcileTask(runningRow(extra));
      expect(fleet.setSandboxCredentials).not.toHaveBeenCalled();
      selfHostedPoller.stopStreaming('t1');
    });

    it('moves a Codex run to the next Codex account with the OpenAI key', async () => {
      const c = await add('codex_oauth', 'C', 99);
      await add('codex_oauth', 'D', 1);
      const extra = { repo: 'acme/widgets', llm: 'openai', model: 'gpt-6.1-sol', accountId: c.id };
      await seedTask({ cloudTask: { provider: 'selfhosted', status: 'running', remoteTaskId: 'talyn-t1', extra } });
      sandboxRunning();

      await selfHostedPoller.reconcileTask(runningRow(extra));
      expect(fleet.setSandboxCredentials).toHaveBeenCalledWith('talyn-t1', {
        githubToken: 'gho_token',
        openaiKey: 'tok-D',
        repo: 'acme/widgets',
        integrations: { linear: 'mcp-secret' },
      });
      selfHostedPoller.stopStreaming('t1');
    });

    it('re-credentials an adopted run with its RECORDED account, not the first one', async () => {
      await add('claude_oauth', 'A', 10);
      const b = await add('claude_oauth', 'B', 10);
      const extra = { repo: 'acme/widgets', llm: 'anthropic', model: 'claude-sonnet-5', accountId: b.id };
      await seedTask({ cloudTask: { provider: 'selfhosted', status: 'running', remoteTaskId: 'talyn-t1', extra } });
      sandboxRunning(new Date().toISOString());

      await selfHostedPoller.reconcileTask(runningRow(extra));
      expect(fleet.setSandboxCredentials).toHaveBeenCalledTimes(1);
      expect(fleet.setSandboxCredentials.mock.calls[0]![1]).toMatchObject({ anthropicKey: 'tok-B' });
      selfHostedPoller.stopStreaming('t1');
    });

    it('re-credentials with a fresh choice when the recorded account was removed, and records it', async () => {
      const a = await add('claude_oauth', 'A', 10);
      const gone = await add('claude_oauth', 'Gone', 10);
      await db.delete(fleetAccounts).where(eq(fleetAccounts.id, gone.id));
      const extra = { repo: 'acme/widgets', llm: 'anthropic', model: 'claude-sonnet-5', accountId: gone.id };
      await seedTask({ cloudTask: { provider: 'selfhosted', status: 'running', remoteTaskId: 'talyn-t1', extra } });
      sandboxRunning(new Date().toISOString());

      await selfHostedPoller.reconcileTask(runningRow(extra));
      expect(fleet.setSandboxCredentials.mock.calls[0]![1]).toMatchObject({ anthropicKey: 'tok-A' });
      expect(extraOf(await taskMeta()).accountId).toBe(a.id);
      selfHostedPoller.stopStreaming('t1');
    });
  });

  describe('the host pull', () => {
    it('serves the recorded account', async () => {
      await add('claude_oauth', 'A', 10);
      const b = await add('claude_oauth', 'B', 10);
      await seedTask({
        cloudTask: {
          provider: 'selfhosted',
          status: 'running',
          remoteTaskId: 'talyn-t1',
          extra: { host: 'host-1', llm: 'anthropic', accountId: b.id },
        },
      });
      const answer = await resolveRunCredentials('host-1', 'talyn-t1');
      expect(answer).toMatchObject({ ok: true, credentials: { anthropicKey: 'tok-B' } });
    });
  });

  describe('a workbench session', () => {
    async function seedWorkbench(agent: 'claude' | 'codex', settings: Record<string, unknown>) {
      await db.insert(workbenchesTable).values({
        id: 'wb1',
        workspaceId: WS,
        repositoryId: 'repo1',
        repoFullName: 'acme/widgets',
        name: 'wb',
        branch: 'talyn/wb',
        baseBranch: 'main',
        runtime: 'sandbox',
        agent,
        sandboxId: 'talyn-wb-wb1',
        sandboxState: 'running',
        status: 'ready',
        settings: settings as never,
      });
      return (await getWorkbench('wb1'))!;
    }

    beforeEach(() => {
      runtime.setWorkbenchFleetClientForTests(async () => {
        const { FleetClient } = await import('../services/selfHosted/client.js');
        return new FleetClient('https://fleet.test', 'x');
      });
    });
    afterEach(() => runtime.setWorkbenchFleetClientForTests(null));

    it('records the account at the first turn, with no note', async () => {
      const a = await add('claude_oauth', 'A', 10);
      const row = await seedWorkbench('claude', {});
      expect(await runtime.refreshSandboxCredentials(row)).toEqual({ accountId: a.id, note: null });
      expect(runtime.workbenchFleetAccountId((await getWorkbench('wb1'))!)).toBe(a.id);
    });

    it('moves to the next account at a turn start, and says why', async () => {
      const a = await add('claude_oauth', 'A', 99);
      const b = await add('claude_oauth', 'B', 10);
      const row = await seedWorkbench('claude', { fleetAccountId: a.id, internetAccess: false });
      const result = await runtime.refreshSandboxCredentials(row);
      expect(result).toEqual({
        accountId: b.id,
        note: 'Switched to B because A reached 99% of its 5-hour limit.',
      });
      expect(fleet.setSandboxCredentials).toHaveBeenCalledWith('talyn-wb-wb1', {
        githubToken: 'gho_token',
        anthropicKey: 'tok-B',
        repo: 'acme/widgets',
        integrations: { linear: 'mcp-secret' },
      });
      const stored = (await getWorkbench('wb1'))!;
      // Only the one key is written: the user's own settings stay.
      expect(stored.settings).toEqual({ fleetAccountId: b.id, internetAccess: false });
    });

    it('moves mid-turn with the whole set, and keeps the row in step', async () => {
      const c = await add('codex_oauth', 'C', 96);
      const d = await add('codex_oauth', 'D', 10);
      const row = await seedWorkbench('codex', { fleetAccountId: c.id });
      const note = await runtime.checkSandboxHotSwap(row);
      expect(note).toBe('Switched to D because C reached 96% of its 5-hour limit.');
      expect(fleet.setSandboxCredentials).toHaveBeenCalledWith('talyn-wb-wb1', {
        githubToken: 'gho_token',
        openaiKey: 'tok-D',
        repo: 'acme/widgets',
        integrations: { linear: 'mcp-secret' },
      });
      expect(runtime.workbenchFleetAccountId(row)).toBe(d.id);
      expect(runtime.workbenchFleetAccountId((await getWorkbench('wb1'))!)).toBe(d.id);
    });

    it('does nothing mid-turn when the account is under the threshold', async () => {
      const a = await add('claude_oauth', 'A', 10);
      await add('claude_oauth', 'B', 10);
      const row = await seedWorkbench('claude', { fleetAccountId: a.id });
      expect(await runtime.checkSandboxHotSwap(row)).toBeNull();
      expect(fleet.setSandboxCredentials).not.toHaveBeenCalled();
    });

    it.each([
      ['recorded derived id', 'talyn-wb-e6f8c6534f5342308a5d3f8e--3542ee', 'talyn-wb-e6f8c6534f5342308a5d3f8e--3542ee', true],
      ['unrecorded derived id', 'talyn-wb-e6f8c6534f5342308a5d3f8e--3542ee', null, false],
      ['different derived id', 'talyn-wb-e6f8c6534f5342308a5d3f8e--3542ee', 'talyn-wb-e6f8c6534f5342308a5d3f8e--abcdef', false],
      ['literal id', 'talyn-wb-e6f8c6534f5342308a5d3f8e', null, true],
    ] as const)('serves a host pull for %s', async (_case, runId, recordedId, allowed) => {
      await add('claude_oauth', 'A', 10);
      const b = await add('claude_oauth', 'B', 10);
      await seedWorkbench('claude', { fleetAccountId: b.id, ...(recordedId ? { fleetSandboxId: recordedId } : {}) });
      await db.update(workbenchesTable).set({
        sandboxId: 'talyn-wb-e6f8c6534f5342308a5d3f8e',
        fleetHost: 'host-1',
      }).where(eq(workbenchesTable.id, 'wb1'));
      const answer = await resolveWorkbenchRunCredentials('host-1', runId);
      if (allowed) expect(answer).toMatchObject({ ok: true, credentials: { anthropicKey: 'tok-B' } });
      else expect(answer).toEqual({ ok: false, reason: 'unknown_run' });
    });
  });
});
