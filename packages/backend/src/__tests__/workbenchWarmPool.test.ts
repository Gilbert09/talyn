import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFleet } from './helpers/fakeFleet.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { fleetHosts, repositories, usageIntervals, workbenchChats, workbenchWarmBoxes, workbenches, workspaces } from '../db/schema.js';
import { UsageExhaustedError } from '../services/billing/entitlements.js';
import { githubService } from '../services/github.js';
import * as accountSelection from '../services/selfHosted/accountSelection.js';
import { FleetCapacityError } from '../services/selfHosted/client.js';
import * as sandboxRun from '../services/selfHosted/sandboxRun.js';
import * as boxGate from '../services/workbenches/boxGate.js';
import * as changes from '../services/workbenches/changes.js';
import * as changesCapture from '../services/workbenches/changesCapture.js';
import { createWorkbenchSandbox, PROVISION_CAPACITY_WAIT, provisionWorkbench } from '../services/workbenches/lifecycle.js';
import { resetWorkbenchDrainForTests } from '../services/workbenches/ownership.js';
import * as prLink from '../services/workbenches/prLink.js';
import * as runtime from '../services/workbenches/sandboxRuntime.js';
import * as sandboxSize from '../services/workbenches/sandboxSize.js';
import * as setupLayers from '../services/workbenches/setupLayers.js';
import { getWorkbench, insertChat, insertWorkbench, listEvents, type WorkbenchRow } from '../services/workbenches/store.js';
import {
  claimWarmBox,
  hostHasRoomForPool,
  settleWarmPoolForTests,
  sweepWarmPool,
  WARM_POOL,
  warmPoolConfig,
  warmSandboxId,
  yieldWarmPool,
} from '../services/workbenches/warmPool.js';

const SHA = 'a'.repeat(40);
const DEFAULT_WAIT = { ...PROVISION_CAPACITY_WAIT };

describe('the warm pool', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;
  let userLayer: unknown;

  beforeAll(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Test' });
    await testDb.db.insert(repositories).values([
      { id: 'repo', workspaceId: 'ws', name: 'o/r', url: 'https://github.com/o/r', defaultBranch: 'main', settings: { warmPool: 1 } },
      { id: 'other', workspaceId: 'ws', name: 'o/other', url: 'https://github.com/o/other', defaultBranch: 'main' },
    ]);
  });

  afterAll(async () => { await testDb.cleanup(); });

  beforeEach(async () => {
    Object.assign(PROVISION_CAPACITY_WAIT, { maxMs: 2_000, firstDelayMs: 5, maxDelayMs: 20, checkMs: 5, queuePollMs: 5 });
    await testDb.db.delete(workbenches);
    await testDb.db.delete(workbenchWarmBoxes);
    await testDb.db.delete(usageIntervals);
    await testDb.db.delete(fleetHosts);
    await testDb.db.execute(sql`DELETE FROM workbench_maintenance_claims`);
    await testDb.db.update(repositories).set({ settings: { warmPool: 1 } }).where(eq(repositories.id, 'repo'));
    await testDb.db.insert(fleetHosts).values({
      name: 'scaleway-1', apiEndpoint: 'http://10.0.0.1:8080', reportedAt: new Date(),
      runsLive: 4, runsMax: 40, memReservedMib: 16_000, memBudgetMib: 200_000,
    });
    fleet = new FakeFleet();
    fleet.handler = (script) => ({ exitCode: 0, stdout: script.includes('git rev-parse HEAD') ? SHA : '' });
    userLayer = { steps: ['a'] };
    runtime.setWorkbenchFleetClientForTests(async () => fleet.asClient());
    vi.spyOn(runtime, 'fleetCreateTarget').mockResolvedValue({ client: fleet.asClient(), host: 'scaleway-1' });
    vi.spyOn(sandboxRun, 'resolveSandboxCredentials').mockResolvedValue({ ok: true, creds: { claudeToken: 'claude-key' }, githubToken: 'gh-token' });
    vi.spyOn(sandboxRun, 'resolveRepository').mockResolvedValue({ slug: 'o/r', defaultBranch: 'main' });
    vi.spyOn(sandboxRun, 'buildSandboxCreateBody').mockImplementation(async (input) => ({
      ok: true,
      body: { id: input.id, workspaceId: input.workspaceId, ...(input.extraMcpServers?.length ? { mcpServers: input.extraMcpServers } : {}) },
    }));
    vi.spyOn(setupLayers, 'imageSetupForCreate').mockImplementation(async (input) => ({
      layers: { repo: { slug: input.slug, baseBranch: input.baseBranch }, user: userLayer as never },
      bake: null,
      legacyUserStepIds: [],
      specStepIds: [],
    }));
    vi.spyOn(accountSelection, 'resolveRunCredential').mockResolvedValue({ token: 'claude-key', accountId: 'acc-1' } as never);
    vi.spyOn(runtime, 'loadWorkbenchConfig').mockResolvedValue(null as never);
    vi.spyOn(sandboxSize, 'sizeForSession').mockResolvedValue('standard');
    vi.spyOn(prLink, 'linkPullRequest').mockImplementation(async (row) => row);
    vi.spyOn(changes, 'refreshDiffStat').mockImplementation(async (row) => row);
    vi.spyOn(changesCapture, 'captureChanges').mockResolvedValue({ kind: 'skipped' } as never);
    vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    vi.spyOn(githubService, 'compareCommits').mockResolvedValue({ files: [] });
  });

  afterEach(async () => {
    await settleWarmPoolForTests();
    Object.assign(PROVISION_CAPACITY_WAIT, DEFAULT_WAIT);
    runtime.setWorkbenchFleetClientForTests(null);
    resetWorkbenchDrainForTests();
    vi.restoreAllMocks();
  });

  const boxRows = () => testDb.db.select().from(workbenchWarmBoxes).orderBy(workbenchWarmBoxes.createdAt);
  const readyBoxes = async () => (await boxRows()).filter((b) => b.status === 'ready');
  const poolCreates = () => fleet.created.filter((c) => c.id.startsWith('talyn-wb-p-'));

  const insertReady = async (over: Partial<typeof workbenchWarmBoxes.$inferInsert> = {}) => {
    const id = randomUUID();
    const now = new Date();
    await testDb.db.insert(workbenchWarmBoxes).values({
      id, sandboxId: warmSandboxId(id), workspaceId: 'ws', repositoryId: 'repo', agent: 'claude', size: 'standard',
      internetAccess: true, baseBranch: 'main', specHash: 'spec', status: 'ready', fleetHost: 'scaleway-1',
      record: { layer: 'user', repoCommit: SHA, legacyUserStepIds: [] }, checkoutCommit: SHA, fillMs: 12_000,
      readyAt: now, touchedAt: now, checkedAt: now, ...over,
    });
    return warmSandboxId(id);
  };

  const insertSession = async (id: string, over: Partial<Parameters<typeof insertWorkbench>[0]> = {}): Promise<WorkbenchRow> => {
    const row = await insertWorkbench({
      id, workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', name: id, branch: `feat-${id}`, baseBranch: 'main',
      runtime: 'sandbox', agent: 'claude', status: 'provisioning', statusMessage: 'Creating the sandbox',
      sandboxState: 'creating', sandboxId: runtime.sandboxIdFor(id), allocatedBranch: true, ...over,
    });
    await insertChat({ id: `chat-${id}`, workbenchId: id, workspaceId: 'ws', title: 'Chat', agent: row.agent });
    await testDb.db.update(workbenchChats).set({ queuedMessages: [] as never }).where(eq(workbenchChats.workbenchId, id));
    return row;
  };

  const bootMetrics = async (id: string) => (await listEvents(`chat-${id}`, 0, 100)).events
    .map(({ event }) => event as Record<string, unknown>)
    .filter((event) => event.subtype === 'boot_metric');

  describe('config', () => {
    it.each([
      [undefined, null],
      [0, null],
      [-1, null],
      [1.5, null],
      [1, { slots: 1, agent: 'claude' }],
      [2, { slots: 2, agent: 'claude' }],
      [{ slots: 1 }, { slots: 1, agent: 'claude' }],
      [{ slots: 1, agent: 'codex' }, { slots: 1, agent: 'codex' }],
      [{ slots: 0, agent: 'codex' }, null],
    ] as const)('reads warmPool %j as %j', (warmPool, expected) => {
      expect(warmPoolConfig(warmPool === undefined ? {} : { warmPool: warmPool as never })).toEqual(expected);
    });

    it('names a warm box like a session box, inside the fleet limit', () => {
      const id = warmSandboxId(randomUUID());
      expect(id).toMatch(/^talyn-wb-p-[0-9a-f]{24}$/);
      expect(id.length).toBeLessThanOrEqual(runtime.FLEET_SANDBOX_ID_MAX);
      expect(runtime.sandboxGeneration(id)).toBe(0);
    });

    it('checks out the base detached and probes no session branch', () => {
      const script = runtime.cloneScript({ repoFullName: 'o/r', branch: 'main', baseBranch: 'main' }, { warm: true });
      expect(script).toMatch(/git checkout --detach '?origin\/main'?$/m);
      expect(script).not.toContain('ls-remote');
      expect(script).not.toContain('checkout -b');
      expect(runtime.cloneScript({ repoFullName: 'o/r', branch: 'feat', baseBranch: 'main' })).toContain('ls-remote');
    });
  });

  describe('filling', () => {
    it.each([
      ['both', 'claude-key', 'codex-key', {}, ['claude', 'codex']],
      ['Claude', 'claude-key', undefined, { openai: 'none' }, ['claude']],
      ['Codex', undefined, 'codex-key', { anthropic: 'none' }, ['codex']],
    ] as const)('creates and replaces a session box with %s credentials', async (_name, anthropicKey, openaiKey, policy, agents) => {
      vi.mocked(accountSelection.resolveRunCredential).mockImplementation(async (_workspace, agent) => {
        const token = agent === 'claude' ? anthropicKey : openaiKey;
        return token ? { token } : null;
      });
      const row = await insertSession('wb-keys');
      for (const sandboxId of [row.sandboxId!, `${row.sandboxId}-r1`]) {
        const made = await createWorkbenchSandbox(row, sandboxId);
        expect(made).toMatchObject({ ok: true, record: { credentialAgents: agents } });
        const body = fleet.created.at(-1)!;
        expect(body.anthropicKey).toBe(anthropicKey);
        expect(body.openaiKey).toBe(openaiKey);
        expect(body.policy?.credentials).toEqual(policy);
        expect((await getWorkbench(row.id))?.settings).toMatchObject({ sandboxAgents: { [sandboxId]: agents } });
      }
    });

    it('creates, checks out and readies one box, and bills nobody for it', async () => {
      await sweepWarmPool();
      const [box] = await boxRows();
      expect(box).toMatchObject({ status: 'ready', agent: 'claude', size: 'standard', internetAccess: true, baseBranch: 'main', checkoutCommit: SHA, fleetHost: 'scaleway-1' });
      expect(box.fillMs).toEqual(expect.any(Number));
      expect(poolCreates().map((c) => c.id)).toEqual([box.sandboxId]);
      expect(fleet.scripts.some((s) => /git checkout --detach '?origin\/main'?$/m.test(s))).toBe(true);
      // Fleet overhead until a claim: no usage interval, no credential push.
      expect(await testDb.db.select().from(usageIntervals)).toEqual([]);
      expect(fleet.credentialPushes).toEqual([]);
      // A second sweep keeps the one slot full and creates nothing.
      await sweepWarmPool();
      expect(poolCreates()).toHaveLength(1);
    });

    it.each([
      ['no slots', {}],
      ['zero slots', { warmPool: 0 }],
    ])('fills nothing with %s', async (_name, settings) => {
      await testDb.db.update(repositories).set({ settings }).where(eq(repositories.id, 'repo'));
      await sweepWarmPool();
      expect(fleet.created).toEqual([]);
    });

    it('fills every slot', async () => {
      await testDb.db.update(repositories).set({ settings: { warmPool: 2 } }).where(eq(repositories.id, 'repo'));
      await sweepWarmPool();
      expect(await readyBoxes()).toHaveLength(2);
    });

    it.each([
      ['memory', { memReservedMib: 170_000 }],
      ['run slots', { runsLive: 35 }],
      ['draining', { draining: true }],
      ['a stale report', { reportedAt: new Date(Date.now() - 10 * 60_000) }],
    ])('does not fill while no host has the reserve free (%s)', async (_name, patch) => {
      await testDb.db.update(fleetHosts).set(patch);
      await sweepWarmPool();
      expect(fleet.created).toEqual([]);
    });

    it('does not fill for an account the box gate refuses', async () => {
      vi.spyOn(boxGate, 'assertNewWorkbenchBox').mockRejectedValue(new UsageExhaustedError({ tier: 'free', periodEnd: new Date() }));
      await sweepWarmPool();
      expect(fleet.created).toEqual([]);
    });

    it('ends the row when the fleet refuses the create', async () => {
      vi.spyOn(fleet, 'createSandbox').mockRejectedValue(new FleetCapacityError('full'));
      await sweepWarmPool();
      expect((await boxRows()).map((b) => [b.status, b.endReason])).toEqual([['ended', 'fill_failed']]);
    });

    it('discards a box whose checkout failed', async () => {
      fleet.handler = (script) => (script.includes('git rev-parse HEAD') ? { exitCode: 128, stderr: 'fatal: no' } : { exitCode: 0 });
      await sweepWarmPool();
      const [box] = await boxRows();
      expect([box.status, box.endReason]).toEqual(['ended', 'checkout_failed']);
      expect(fleet.deleted).toEqual([box.sandboxId]);
    });

    it('discards a box a dead filler left behind', async () => {
      const sandboxId = await insertReady({ status: 'filling' });
      await sweepWarmPool();
      const rows = await boxRows();
      expect(rows.find((b) => b.sandboxId === sandboxId)).toMatchObject({ status: 'ended', endReason: 'fill_abandoned' });
      expect(fleet.deleted).toContain(sandboxId);
      expect(await readyBoxes()).toHaveLength(1);
    });

    it('retries a delete that failed', async () => {
      const sandboxId = await insertReady({ status: 'discarding', endReason: 'aged' });
      await sweepWarmPool();
      expect((await boxRows()).find((b) => b.sandboxId === sandboxId)).toMatchObject({ status: 'ended', endReason: 'aged' });
      expect(fleet.deleted).toEqual([sandboxId]);
    });
  });

  describe('the claim', () => {
    it('gives one ready box to exactly one of two concurrent sessions', async () => {
      const sandboxId = await insertReady();
      const [a, b] = await Promise.all([insertSession('wb-a'), insertSession('wb-b')]);
      const claims = await Promise.all([claimWarmBox(a), claimWarmBox(b)]);
      const won = claims.filter((c) => c !== null);
      expect(won).toHaveLength(1);
      expect(won[0]!.created.sandboxId).toBe(sandboxId);
      const [box] = (await boxRows()).filter((r) => r.sandboxId === sandboxId);
      expect(box.status).toBe('claimed');
      expect(['wb-a', 'wb-b']).toContain(box.claimedBy);
      const loser = box.claimedBy === 'wb-a' ? 'wb-b' : 'wb-a';
      expect((await bootMetrics(loser)).find((m) => m.metric === 'warm_pool')).toMatchObject({ hit: false });
      expect(fleet.credentialPushes.filter((p) => p.id === sandboxId)).toHaveLength(1);
    });

    it('starts a session on the warm box, bills it from the claim, and refills', async () => {
      const sandboxId = await insertReady();
      await insertSession('wb-hit');
      const before = Date.now();
      await provisionWorkbench('wb-hit');

      const row = await getWorkbench('wb-hit');
      expect(row).toMatchObject({ status: 'ready', sandboxState: 'running', sandboxId, fleetHost: 'scaleway-1' });
      // No fresh box for the session: its create never ran.
      expect(fleet.created.map((c) => c.id)).not.toContain(runtime.sandboxIdFor('wb-hit'));
      // The session's own credentials went in before anything ran, and its account is recorded.
      expect(fleet.credentialPushes[0]).toMatchObject({ id: sandboxId, creds: { githubToken: 'gh-token', anthropicKey: 'claude-key', repo: 'o/r' } });
      expect(row?.settings).toMatchObject({ fleetAccountId: 'acc-1', boxStart: { sandboxId, cause: 'new', warm: true } });
      // The branch is the session's, from the fetched base.
      expect(fleet.scripts.some((s) => /checkout --no-track -b '?feat-wb-hit'? '?origin\/main'?$/m.test(s))).toBe(true);
      // Billing starts at the claim, on the session.
      const intervals = await testDb.db.select().from(usageIntervals);
      expect(intervals).toHaveLength(1);
      expect(intervals[0]).toMatchObject({ subjectKind: 'workbench', subjectId: 'wb-hit', sandboxId, endedAt: null });
      expect(intervals[0].startedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);

      const metrics = await bootMetrics('wb-hit');
      expect(metrics.find((m) => m.metric === 'warm_pool')).toMatchObject({ hit: true, sandboxId, fillMs: 12_000 });
      expect(metrics.find((m) => m.metric === 'warm_pool_ready')).toMatchObject({ sandboxId, readyMs: expect.any(Number), savedMs: expect.any(Number) });
      expect(metrics.find((m) => m.metric === 'box_created')).toMatchObject({ warm: true });
      expect((await boxRows()).find((b) => b.sandboxId === sandboxId)).toMatchObject({ status: 'claimed', claimedBy: 'wb-hit', endReason: 'claimed' });

      // The claim refills the slot in the background.
      await settleWarmPoolForTests();
      expect(await readyBoxes()).toHaveLength(1);
      expect((await readyBoxes())[0].sandboxId).not.toBe(sandboxId);
    });

    it('falls back to a fresh box when none is ready', async () => {
      await testDb.db.update(fleetHosts).set({ runsLive: 39 }); // the kicked refill must not fill now
      await insertSession('wb-miss');
      await provisionWorkbench('wb-miss');
      expect(await getWorkbench('wb-miss')).toMatchObject({ status: 'ready', sandboxId: runtime.sandboxIdFor('wb-miss') });
      expect(fleet.created.map((c) => c.id)).toEqual([runtime.sandboxIdFor('wb-miss')]);
      expect((await bootMetrics('wb-miss')).find((m) => m.metric === 'warm_pool')).toMatchObject({ hit: false, reason: 'none_ready' });
    });

    it('claims a warm box for the other agent only when both keys were present at create', async () => {
      const sandboxId = await insertReady({ record: { credentialAgents: ['claude', 'codex'] } });
      const row = await insertSession('wb-codex', { agent: 'codex' });
      const claim = await claimWarmBox(row);
      expect(claim?.created.sandboxId).toBe(sandboxId);
      expect((await getWorkbench(row.id))?.settings).toMatchObject({ sandboxAgents: { [sandboxId]: ['claude', 'codex'] } });
      expect(fleet.credentialPushes.at(-1)?.creds).toMatchObject({ anthropicKey: 'claude-key', openaiKey: 'claude-key' });
    });

    it.each([
      ['another agent', { agent: 'codex' }],
      ['no internet', { settings: { internetAccess: false } }],
      ['a larger box', { settings: { sandboxSize: 'large' } }],
      ['another base', { baseBranch: 'release' }],
    ] as const)('leaves the box for a session that needs %s', async (_name, over) => {
      const sandboxId = await insertReady();
      const row = await insertSession('wb-other', over as never);
      expect(await claimWarmBox(row)).toBeNull();
      expect((await boxRows()).find((b) => b.sandboxId === sandboxId)?.status).toBe('ready');
      expect((await bootMetrics('wb-other')).find((m) => m.metric === 'warm_pool')).toMatchObject({ hit: false, reason: 'no_match' });
    });

    it.each([
      ['a thread', { kind: 'thread' }],
      ['a lost box', { sandboxState: 'lost' }],
      ['a restore', { memoryRestorePending: 'archive' }],
      ['a later generation', { sandboxId: runtime.sandboxIdFor('wb-not', 1) }],
      ['a repository with no pool', { repositoryId: 'other', repoFullName: 'o/other' }],
    ] as const)('never claims for %s', async (_name, over) => {
      const sandboxId = await insertReady();
      const row = await insertSession('wb-not', over as never);
      expect(await claimWarmBox(row)).toBeNull();
      expect((await boxRows()).find((b) => b.sandboxId === sandboxId)?.status).toBe('ready');
      expect((await bootMetrics('wb-not')).filter((m) => m.metric === 'warm_pool')).toEqual([]);
    });

    it('discards the box and creates a fresh one when the hand-over fails', async () => {
      await testDb.db.update(fleetHosts).set({ runsLive: 39 });
      const sandboxId = await insertReady();
      vi.spyOn(fleet, 'setSandboxCredentials').mockRejectedValueOnce(new Error('proxy down'));
      await insertSession('wb-fail');
      await provisionWorkbench('wb-fail');
      expect(await getWorkbench('wb-fail')).toMatchObject({ status: 'ready', sandboxId: runtime.sandboxIdFor('wb-fail') });
      expect((await boxRows()).find((b) => b.sandboxId === sandboxId)).toMatchObject({ status: 'ended', endReason: 'handover_failed' });
      expect(fleet.deleted).toContain(sandboxId);
      expect((await bootMetrics('wb-fail')).find((m) => m.metric === 'warm_pool')).toMatchObject({ hit: false, reason: 'handover_failed' });
    });
  });

  describe('staleness', () => {
    const fillAndAge = async (patch: Partial<typeof workbenchWarmBoxes.$inferInsert>) => {
      await sweepWarmPool();
      const [box] = await readyBoxes();
      if (Object.keys(patch).length > 0) await testDb.db.update(workbenchWarmBoxes).set(patch).where(eq(workbenchWarmBoxes.id, box.id));
      return box;
    };
    const old = new Date(Date.now() - WARM_POOL.checkMs - 1000);

    it.each([
      ['a dependency file', [{ filename: 'pnpm-lock.yaml', status: 'modified' }], 'dependencies_changed:pnpm-lock.yaml'],
      ['a nested lockfile', [{ filename: 'common/uv.lock', status: 'modified' }], 'dependencies_changed:common/uv.lock'],
      ['the setup config', [{ filename: '.talyn/settings.toml', status: 'added' }], 'dependencies_changed:.talyn/settings.toml'],
      ['too many files to tell', Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts`, status: 'modified' })), 'base_moved'],
    ])('replaces a box when the base changes %s', async (_name, files, reason) => {
      const box = await fillAndAge({ checkedAt: old });
      vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    vi.spyOn(githubService, 'compareCommits').mockResolvedValue({ files });
      await sweepWarmPool();
      expect((await boxRows()).find((b) => b.id === box.id)).toMatchObject({ status: 'ended', endReason: reason });
      expect(fleet.deleted).toEqual([box.sandboxId]);
      expect(await readyBoxes()).toHaveLength(1);
    });

    it('replaces a box whose base was rewritten', async () => {
      const box = await fillAndAge({ checkedAt: old });
      vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    vi.spyOn(githubService, 'compareCommits').mockResolvedValue(null);
      await sweepWarmPool();
      expect((await boxRows()).find((b) => b.id === box.id)?.endReason).toBe('base_rewritten');
    });

    it('keeps a box when only code changed, and stamps the check', async () => {
      const box = await fillAndAge({ checkedAt: old });
      vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    vi.spyOn(githubService, 'compareCommits').mockResolvedValue({ files: [{ filename: 'src/app.ts', status: 'modified' }] });
      await sweepWarmPool();
      const [kept] = await readyBoxes();
      expect(kept.id).toBe(box.id);
      expect(kept.checkedAt!.getTime()).toBeGreaterThan(old.getTime());
    });

    it('keeps a box when GitHub cannot answer', async () => {
      const box = await fillAndAge({ checkedAt: old });
      vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    vi.spyOn(githubService, 'compareCommits').mockRejectedValue(new Error('502'));
      await sweepWarmPool();
      expect((await readyBoxes()).map((b) => b.id)).toEqual([box.id]);
    });

    it('replaces a box when the image spec changes', async () => {
      const box = await fillAndAge({ checkedAt: old });
      userLayer = { steps: ['a', 'b'] };
      await sweepWarmPool();
      expect((await boxRows()).find((b) => b.id === box.id)?.endReason).toBe('spec_changed');
      expect(await readyBoxes()).toHaveLength(1);
    });

    it('does not compare before the check interval', async () => {
      await fillAndAge({});
      const compare = vi.spyOn(githubService, 'compareCommits');
      userLayer = { steps: ['changed'] };
      await sweepWarmPool();
      expect(compare).not.toHaveBeenCalled();
      expect(await readyBoxes()).toHaveLength(1);
    });

    it('replaces a box past its age cap', async () => {
      const box = await fillAndAge({ createdAt: new Date(Date.now() - WARM_POOL.maxAgeMs - 1000) });
      await sweepWarmPool();
      expect((await boxRows()).find((b) => b.id === box.id)?.endReason).toBe('aged');
      expect(await readyBoxes()).toHaveLength(1);
    });

    it.each([
      ['the pool is switched off', {}, 'pool_changed'],
      ['the pool moves to another agent', { warmPool: { slots: 1, agent: 'codex' } }, 'pool_changed'],
    ])('ends a box when %s', async (_name, settings, reason) => {
      const box = await fillAndAge({});
      await testDb.db.update(repositories).set({ settings }).where(eq(repositories.id, 'repo'));
      await sweepWarmPool();
      expect((await boxRows()).find((b) => b.id === box.id)?.endReason).toBe(reason);
    });

    it('ends the extra box when the slots go down', async () => {
      await testDb.db.update(repositories).set({ settings: { warmPool: 2 } }).where(eq(repositories.id, 'repo'));
      await sweepWarmPool();
      await testDb.db.update(repositories).set({ settings: { warmPool: 1 } }).where(eq(repositories.id, 'repo'));
      await sweepWarmPool();
      expect(await readyBoxes()).toHaveLength(1);
      expect((await boxRows()).filter((b) => b.endReason === 'over_slots')).toHaveLength(1);
    });
  });

  describe('keeping awake', () => {
    it('runs a keep-alive exec once the interval passes', async () => {
      await sweepWarmPool();
      const [box] = await readyBoxes();
      const stale = new Date(Date.now() - WARM_POOL.keepAliveMs - 1000);
      await testDb.db.update(workbenchWarmBoxes).set({ touchedAt: stale }).where(eq(workbenchWarmBoxes.id, box.id));
      const execs = fleet.scripts.length;
      await sweepWarmPool();
      expect(fleet.scripts.slice(execs)).toEqual(['true']);
      const [kept] = await readyBoxes();
      expect(kept.touchedAt!.getTime()).toBeGreaterThan(stale.getTime());
    });

    it('does not touch a box inside the interval', async () => {
      await sweepWarmPool();
      const execs = fleet.scripts.length;
      await sweepWarmPool();
      expect(fleet.scripts.length).toBe(execs);
    });

    it.each(['suspended', 'failed', 'stopped'])('replaces a box the fleet reports %s', async (status) => {
      await sweepWarmPool();
      const [box] = await readyBoxes();
      await testDb.db.update(workbenchWarmBoxes).set({ touchedAt: new Date(0) }).where(eq(workbenchWarmBoxes.id, box.id));
      fleet.sandboxStatus = status;
      await sweepWarmPool();
      expect((await boxRows()).find((b) => b.id === box.id)?.endReason).toBe(`not_awake:${status}`);
    });
  });

  describe('yielding to real sessions', () => {
    it('drops a ready box whose host goes near full, and does not refill', async () => {
      await sweepWarmPool();
      const [box] = await readyBoxes();
      await testDb.db.update(fleetHosts).set({ memReservedMib: 190_000 });
      await sweepWarmPool();
      expect((await boxRows()).find((b) => b.id === box.id)?.endReason).toBe('yielded');
      expect(poolCreates()).toHaveLength(1);
    });

    it('empties the pool when a session waits for room, and stays empty for the cooldown', async () => {
      const sandboxId = await insertReady();
      await insertSession('wb-wait', { repositoryId: 'other', repoFullName: 'o/other' });
      const create = fleet.createSandbox.bind(fleet);
      let tries = 0;
      vi.spyOn(fleet, 'createSandbox').mockImplementation(async (input) => {
        if (tries++ === 0) throw new FleetCapacityError('host full', undefined, 'no_capacity');
        return create(input);
      });
      await provisionWorkbench('wb-wait');
      expect(await getWorkbench('wb-wait')).toMatchObject({ status: 'ready', sandboxId: runtime.sandboxIdFor('wb-wait') });
      expect((await boxRows()).find((b) => b.sandboxId === sandboxId)).toMatchObject({ status: 'ended', endReason: 'yielded' });
      expect(fleet.deleted).toContain(sandboxId);
      await sweepWarmPool();
      expect(poolCreates()).toEqual([]);
    });

    it('fills again after the cooldown', async () => {
      await insertReady({ status: 'ended', endReason: 'yielded', endedAt: new Date(Date.now() - WARM_POOL.yieldCooldownMs - 1000) });
      await sweepWarmPool();
      expect(await readyBoxes()).toHaveLength(1);
    });

    it('yields every live box and reports how many', async () => {
      await insertReady();
      await insertReady({ status: 'filling' });
      await insertReady({ status: 'claimed', endedAt: new Date(), claimedBy: 'x' });
      expect(await yieldWarmPool('test')).toBe(2);
      expect((await boxRows()).map((b) => b.status).sort()).toEqual(['claimed', 'ended', 'ended']);
    });

    it.each([
      [{}, true],
      [{ memReservedMib: 160_000 }, false],
      [{ runsLive: 31 }, false],
      [{ runsLive: 30 }, true],
      [{ runsMax: 0, memBudgetMib: 0 }, true],
    ])('judges host room %j as %s', (patch, expected) => {
      const host = {
        name: 'h', apiEndpoint: 'http://h', version: null, reportedAt: new Date(), draining: false, runsLive: 4, runsMax: 40,
        memReservedMib: 16_000, memBudgetMib: 200_000, diskFreeMib: 0, maxIdleSeconds: 0, online: true, dispatchable: true,
        metrics: null, activeRuns: null, ...patch,
      };
      expect(hostHasRoomForPool(host)).toBe(expected);
    });
  });
});
