import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SANDBOX_SIZES, type SandboxSize } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn, type ExecReply } from './helpers/fakeFleet.js';
import { repositories, workspaces } from '../db/schema.js';
import type { FleetExecFrame, FleetExecRequest, FleetSandbox } from '../services/selfHosted/client.js';

/**
 * The meter hooks on a session's box. A box is billed while it is awake:
 * provisioning, a resume and a turn start open its interval; an archive, a
 * delete, a retry, a lost box and the end of a move close it. A resize is a
 * move to a box of the new size, so the new weight starts at the new box's
 * create and the old one stops at its delete.
 */

const { openInterval, closeInterval } = vi.hoisted(() => ({ openInterval: vi.fn(), closeInterval: vi.fn() }));

vi.mock('../services/billing/usage/index.js', () => ({ openInterval, closeInterval }));
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
vi.mock('../services/mcpServers/dispatch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mcpServers/dispatch.js')>()),
  mcpIntegrationSecrets: async () => ({}),
}));
vi.mock('../services/repoDefaultBranch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/repoDefaultBranch.js')>()),
  reconcileDefaultBranch: async (input: { stored: string }) => input.stored || 'main',
}));

const { githubService } = await import('../services/github.js');
const runtime = await import('../services/workbenches/sandboxRuntime.js');
const { FleetRunNotFoundError } = await import('../services/selfHosted/client.js');
const store = await import('../services/workbenches/store.js');
const move = await import('../services/workbenches/move.js');
const turns = await import('../services/workbenches/turns.js');
const resize = await import('../services/workbenches/resize.js');
const lifecycle = await import('../services/workbenches/lifecycle.js');
const recovery = await import('../services/workbenches/recovery.js');
const meter = await import('../services/workbenches/usageMeter.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { resetUsageHookCacheForTests } = await import('../services/billing/usageHooks.js');

const WB = '11111111-2222-4333-8444-555555555555';
const OLD_BOX = 'talyn-wb-111111112222433384445555';
const NEW_BOX = `${OLD_BOX}-r1`;
const SESSION = '4f1c2b9e-1111-4222-8333-944455556666';
const HEAD = 'a'.repeat(40);
const GIB = 1024 * 1024 * 1024;
const OWNER = 'owner-a';
const b64 = (s: string) => Buffer.from(s).toString('base64');
const BODIES: Record<string, string> = { 'repo.bundle': 'bundle', 'staged.patch.gz': 'staged', 'unstaged.patch.gz': 'unstaged' };

function manifest(): string[] {
  return [
    `HEAD ${HEAD}`,
    `BRANCH ${b64('paris')}`,
    `UPSTREAM ${b64('origin/paris')}`,
    `REF ${HEAD} refs/heads/paris origin/paris`,
    ...Object.keys(BODIES).map((name, i) => `FILE ${name} ${Buffer.byteLength(BODIES[name])} ${String(i + 1).repeat(64)}`),
    'SKIPPED_COUNT 0',
    'END',
  ];
}

type Kind = 'stop' | 'export' | 'chunk' | 'clone' | 'checkpoint' | 'probe' | 'agent' | 'other';

function kindOf(script: string): Kind {
  if (script.includes('TALYN_PREFIX')) return 'stop';
  if (script.includes('git bundle create -')) return 'export';
  if (script.startsWith('dd if=')) return 'chunk';
  if (script.includes('git clone --filter=blob:none')) return 'clone';
  if (script.includes('git commit-tree')) return 'checkpoint';
  if (script.includes('TALYN_DISK') && script.includes('df -B1')) return 'probe';
  if (isAgentTurn(script)) return 'agent';
  return 'other';
}

class MeterFleet extends FakeFleet {
  log: Array<{ kind: Kind | 'create'; box: string }> = [];
  memMib = SANDBOX_SIZES.standard.memMib;
  milliVcpu = SANDBOX_SIZES.standard.milliVcpu;
  status = 'idle';

  override async exec(id: string, req: FleetExecRequest): Promise<FleetExecFrame> {
    this.log.push({ kind: kindOf(req.env?.TALYN_DURABLE_SCRIPT ?? req.env?.TALYN_SCRIPT ?? ''), box: id });
    return super.exec(id, req);
  }

  override async *execFollow(id: string, req: FleetExecRequest, signal: AbortSignal): AsyncGenerator<FleetExecFrame> {
    this.log.push({ kind: kindOf(req.env?.TALYN_DURABLE_SCRIPT ?? req.env?.TALYN_SCRIPT ?? ''), box: id });
    yield* super.execFollow(id, req, signal);
  }

  override async createSandbox(input: Parameters<FakeFleet['createSandbox']>[0]) {
    this.log.push({ kind: 'create', box: input.id });
    return super.createSandbox(input);
  }

  override async getSandbox(id: string) {
    if (id !== OLD_BOX && !this.created.some((c) => c.id === id)) throw new FleetRunNotFoundError('no such sandbox');
    return {
      sandbox: { id, status: this.status, memMib: this.memMib, milliVcpu: this.milliVcpu } as FleetSandbox,
      terminal: false,
    };
  }

  first(kind: string, box?: string): number {
    return this.log.findIndex((e) => e.kind === kind && (!box || e.box === box));
  }
}

describe('the meter on a session box', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: MeterFleet;
  let replies: Partial<Record<Kind, ExecReply>>;
  /** Every ledger call, in order, so open-before-close can be asserted. */
  let calls: Array<['open', Record<string, unknown>] | ['close', string, Date, string]>;

  beforeEach(async () => {
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    vi.stubEnv('FLEET_API_TOKEN', 'fleet-token');
    vi.stubEnv('FLEET_PINNED_ENDPOINT', '');
    vi.stubEnv('FLEET_GATEWAY_TOKEN', '');
    vi.stubEnv('FLEET_ALLOWED', 'true');
    resetFeatureFlagsForTests();
    resetUsageHookCacheForTests();
    recovery.resetLostRecoveryForTests();
    move.resetMovesForTests();
    calls = [];
    openInterval.mockReset().mockImplementation(async (input: Record<string, unknown>) => { calls.push(['open', input]); });
    closeInterval.mockReset().mockImplementation(async (id: string, at: Date, reason: string) => { calls.push(['close', id, at, reason]); });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: OWNER });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: OWNER, name: 'A' });
    await testDb.db.insert(repositories).values({
      id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main',
    });
    await store.insertWorkbench({
      id: WB, workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'acme/app', name: 'paris',
      branch: 'paris', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
      sandboxState: 'running', sandboxId: OLD_BOX, fleetHost: 'host-0', settings: { boxSize: 'standard' },
    });
    await store.insertChat({ id: 'chat-a', workbenchId: WB, workspaceId: 'ws-a', title: 'Chat', agent: 'claude', agentSessionId: SESSION });
    vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    vi.spyOn(githubService, 'branchExists').mockResolvedValue(false);
    vi.spyOn(githubService, 'getRefSha').mockRejectedValue(new Error('offline'));
    replies = {};
    fleet = new MeterFleet();
    fleet.noise = [];
    fleet.handler = async (script) => {
      const kind = kindOf(script);
      const reply = replies[kind];
      if (reply) return reply;
      if (kind === 'export') return { stdout: manifest() };
      if (kind === 'chunk') {
        const name = Object.keys(BODIES).find((n) => script.includes(`/${n} `));
        return { stdout: name ? BODIES[name] : '' };
      }
      if (kind === 'checkpoint') return { stdout: `${'c'.repeat(40)}\n`, stderr: `TALYN_DISK ${10 * GIB} ${16 * GIB}` };
      if (kind === 'probe') return { stderr: `TALYN_DISK ${10 * GIB} ${16 * GIB}` };
      if (kind === 'agent') return { stdout: claudeTurnLines(SESSION, 'done') };
      if (kind === 'stop') return { stdout: '0' };
      return { exitCode: 0, stdout: '' };
    };
    runtime.setWorkbenchFleetClientForTests(async () => fleet.asClient());
  });

  afterEach(async () => {
    if (fleet.first('agent') >= 0) {
      await vi.waitFor(async () => expect((await store.getChat('chat-a'))?.status).not.toBe('running'), { timeout: 5000 });
    }
    await move.settleMovesForTests();
    await lifecycle.settleArchivesForTests();
    runtime.setWorkbenchFleetClientForTests(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
    await testDb.cleanup();
  });

  const row = async () => (await store.getWorkbench(WB))!;
  const opens = () => calls.filter((c) => c[0] === 'open').map((c) => c[1] as Record<string, unknown>);
  const closes = () => calls.filter((c) => c[0] === 'close').map((c) => ({ id: c[1], reason: c[3] }));
  const workbenchInterval = (sandboxId: string, size: SandboxSize) => ({
    ownerId: OWNER, workspaceId: 'ws-a', subjectKind: 'workbench', subjectId: WB, sandboxId, size,
  });

  describe('provisioning', () => {
    it.each<SandboxSize>(['small', 'standard', 'medium', 'large'])('opens the new box at the session size %s and records it', async (size) => {
      await store.updateWorkbench(WB, {
        status: 'provisioning', sandboxState: 'creating', sandboxId: null, settings: { sandboxSize: size },
      });
      await lifecycle.provisionWorkbench(WB);
      const after = await row();
      expect(after.status).toBe('ready');
      expect(after.settings?.boxSize).toBe(size);
      expect(fleet.created[0]).toMatchObject({ memMib: SANDBOX_SIZES[size].memMib, milliVcpu: SANDBOX_SIZES[size].milliVcpu, idleTtlSec: 600 });
      expect(opens()).toEqual([workbenchInterval(after.sandboxId!, size)]);
      expect(closes()).toEqual([]);
    });

    it('opens a thread box at the small size', async () => {
      await store.updateWorkbench(WB, {
        kind: 'thread', repositoryId: null, repoFullName: '', status: 'provisioning', sandboxState: 'creating', sandboxId: null, settings: {},
      });
      await lifecycle.provisionWorkbench(WB);
      expect((await row()).status).toBe('ready');
      expect(opens()).toEqual([workbenchInterval((await row()).sandboxId!, 'small')]);
    });

    it('a meter failure never fails the provision', async () => {
      openInterval.mockRejectedValue(new Error('ledger down'));
      await store.updateWorkbench(WB, { status: 'provisioning', sandboxState: 'creating', sandboxId: null, settings: {} });
      await lifecycle.provisionWorkbench(WB);
      expect((await row()).status).toBe('ready');
    });
  });

  describe('waking', () => {
    it('a turn start meters the box and shows a suspended box as running', async () => {
      await store.updateWorkbench(WB, { sandboxState: 'suspended', settings: { boxSize: 'medium' } });
      await turns.sendMessage('chat-a', { text: 'go on' });
      await vi.waitFor(() => expect(fleet.first('agent')).toBeGreaterThanOrEqual(0), { timeout: 5000 });
      expect(opens()).toContainEqual(workbenchInterval(OLD_BOX, 'medium'));
      expect((await row()).sandboxState).toBe('running');
    });

    it('a resume meters the box at its recorded size', async () => {
      await store.updateWorkbench(WB, { sandboxState: 'suspended', settings: { boxSize: 'large' } });
      await runtime.resumeOnce(fleet.asClient(), OLD_BOX);
      expect(opens()).toEqual([workbenchInterval(OLD_BOX, 'large')]);
      expect((await row()).sandboxState).toBe('running');
    });

    it('a resume of a box no session names meters nothing', async () => {
      await runtime.resumeOnce(fleet.asClient(), 'talyn-someone-else');
      expect(opens()).toEqual([]);
    });

    it('a box that was asleep, not lost, is resumed and metered', async () => {
      fleet.status = 'suspended';
      await recovery.recoverLostSandbox(await row(), new FleetRunNotFoundError('not on this host'));
      expect(opens()).toEqual([workbenchInterval(OLD_BOX, 'standard')]);
      expect(closes()).toEqual([]);
    });
  });

  describe('what the fleet reports', () => {
    it.each<[string, Partial<FleetSandbox> & { retired?: boolean }, 'open' | 'close' | 'none', string | undefined, string]>([
      ['idle', { status: 'idle' }, 'open', undefined, 'running'],
      ['busy', { status: 'busy' }, 'open', undefined, 'running'],
      ['suspended', { status: 'suspended', suspendedAt: '2026-11-01T10:00:00Z' }, 'close', 'suspended', 'suspended'],
      ['stopped', { status: 'stopped' }, 'close', 'terminal', 'running'],
      ['retired', { status: 'idle', retired: true }, 'close', 'terminal', 'running'],
      ['queued', { status: 'queued' }, 'none', undefined, 'running'],
    ])('a %s box', async (_label, sandbox, action, reason, state) => {
      await meter.observeWorkbenchSandbox({ ...(await row()), sandboxId: OLD_BOX }, { id: OLD_BOX, ...sandbox } as FleetSandbox);
      if (action === 'open') expect(opens()).toEqual([workbenchInterval(OLD_BOX, 'standard')]);
      else expect(opens()).toEqual([]);
      if (action === 'close') expect(closes()).toEqual([{ id: OLD_BOX, reason }]);
      else expect(closes()).toEqual([]);
      expect((await row()).sandboxState).toBe(state);
    });

    it('closes a suspended box at the fleet suspend time', async () => {
      await meter.observeWorkbenchSandbox({ ...(await row()), sandboxId: OLD_BOX }, {
        id: OLD_BOX, status: 'suspended', suspendedAt: '2026-11-01T10:00:00Z',
      } as FleetSandbox);
      expect(closeInterval).toHaveBeenCalledWith(OLD_BOX, new Date('2026-11-01T10:00:00Z'), 'suspended');
    });

    it.each(['lost', 'deleted', 'error'] as const)('never overwrites a %s box with suspended', async (state) => {
      await store.updateWorkbench(WB, { sandboxState: state });
      await meter.meterWorkbenchSuspended({ workspaceId: 'ws-a', sandboxId: OLD_BOX });
      expect((await row()).sandboxState).toBe(state);
    });
  });

  describe('removing the box', () => {
    it('a delete closes the box, also when the fleet delete fails', async () => {
      fleet.deleteSandbox = async () => { throw new Error('fleet is down'); };
      await lifecycle.deleteWorkbench(WB);
      expect(closes()).toEqual([{ id: OLD_BOX, reason: 'deleted' }]);
    });

    it('an archive of a thread closes its box', async () => {
      await store.updateWorkbench(WB, { kind: 'thread', repositoryId: null, repoFullName: '' });
      await lifecycle.archiveWorkbench(WB);
      await lifecycle.settleArchivesForTests();
      expect(fleet.deleted).toEqual([OLD_BOX]);
      expect(closes()).toEqual([{ id: OLD_BOX, reason: 'deleted' }]);
    });

    it('a retry closes the failed box before the new one opens', async () => {
      await store.updateWorkbench(WB, { status: 'error', sandboxState: 'error' });
      await lifecycle.retryWorkbench(WB);
      await vi.waitFor(async () => expect((await row()).status).toBe('ready'), { timeout: 5000 });
      expect(closes()).toEqual([{ id: OLD_BOX, reason: 'deleted' }]);
      expect(opens()).toEqual([workbenchInterval(NEW_BOX, 'standard')]);
      expect(calls.findIndex((c) => c[0] === 'close')).toBeLessThan(calls.findIndex((c) => c[0] === 'open'));
    });

    it('a lost box closes as vanished and its replacement opens', async () => {
      fleet.status = 'stopped';
      await recovery.recoverLostSandbox(await row(), new FleetRunNotFoundError('not on this host'));
      await vi.waitFor(async () => expect((await row()).status).toBe('ready'), { timeout: 5000 });
      expect(closes()).toEqual([{ id: OLD_BOX, reason: 'vanished' }]);
      expect(opens()).toEqual([workbenchInterval(NEW_BOX, 'standard')]);
    });
  });

  describe('a resize', () => {
    it.each<SandboxSize>(['small', 'medium', 'large', 'xlarge'])('to %s opens the new box at the new weight, then closes the old one', async (size) => {
      const result = await resize.requestSessionResize(await row(), { size });
      expect(result.outcome).toBe('moving');
      await vi.waitFor(async () => expect((await row()).sandboxId).toBe(NEW_BOX), { timeout: 5000 });
      await vi.waitFor(() => expect(closes()).toEqual([{ id: OLD_BOX, reason: 'deleted' }]), { timeout: 5000 });
      expect(opens()).toEqual([workbenchInterval(NEW_BOX, size)]);
      expect(calls.findIndex((c) => c[0] === 'open')).toBeLessThan(calls.findIndex((c) => c[0] === 'close'));
      expect((await row()).settings?.boxSize).toBe(size);
    });

    it('reads a 4 GiB box with 2 vCPUs as small, so a resize to small does nothing', async () => {
      fleet.milliVcpu = SANDBOX_SIZES.small.milliVcpu;
      const result = await resize.requestSessionResize(await row(), { size: 'small' });
      expect(result.outcome).toBe('unchanged');
      expect(calls).toEqual([]);
    });

    it('reads a 4 GiB box with 4 vCPUs as standard, so a resize to small moves', async () => {
      const result = await resize.requestSessionResize(await row(), { size: 'small' });
      expect(result.outcome).toBe('moving');
      await vi.waitFor(async () => expect((await row()).sandboxId).toBe(NEW_BOX), { timeout: 5000 });
    });

    it('a failed move closes the half-made box and leaves the old one metered', async () => {
      replies.clone = { exitCode: 128, stderr: 'fatal: could not read from remote' };
      await resize.requestSessionResize(await row(), { size: 'large' });
      await move.settleMovesForTests();
      await vi.waitFor(() => expect(closes()).toEqual([{ id: NEW_BOX, reason: 'deleted' }]), { timeout: 5000 });
      expect(opens()).toEqual([workbenchInterval(NEW_BOX, 'large')]);
      expect((await row()).sandboxId).toBe(OLD_BOX);
    });
  });
});
