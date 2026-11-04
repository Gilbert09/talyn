import { sql } from 'drizzle-orm';
import { FleetRunNotFoundError } from '../services/selfHosted/client.js';
import { SANDBOX_LOST_FAILED_MESSAGE } from '../services/workbenches/recovery.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFleet } from './helpers/fakeFleet.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import * as changes from '../services/workbenches/changes.js';
import * as prLink from '../services/workbenches/prLink.js';
import * as runtime from '../services/workbenches/sandboxRuntime.js';
import * as sandboxSize from '../services/workbenches/sandboxSize.js';
import * as sandboxRun from '../services/selfHosted/sandboxRun.js';
import * as scripts from '../services/workbenches/scripts.js';
import * as setupRecipe from '../services/workbenches/setupLayers.js';
import { beginWorkbenchDrain, resetWorkbenchDrainForTests } from '../services/workbenches/ownership.js';
import {
  PROVISION_SETUP_WATCH,
  processArchive,
  provisionClaimName,
  provisionWorkbench,
  retryWorkbench,
  sweepStrandedProvisions,
} from '../services/workbenches/lifecycle.js';
import { getChat, getWorkbench, insertChat, insertWorkbench, listEvents, updateWorkbench } from '../services/workbenches/store.js';

const WB = 'wb-claim';
const CLAIM = provisionClaimName(WB);
const OLD_BOX = runtime.sandboxIdFor(WB);
const NEW_BOX = runtime.sandboxIdFor(WB, 1);

type Reply = { exitCode: number; stdout?: string; stderr?: string };

describe('one provision per session across instances', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;
  let clones: number;
  /** What the clone script answers. Runs inside the clone, so a test can change the world mid-provision. */
  let onClone: () => Promise<Reply> | Reply;

  beforeAll(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Test' });
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'o/r', url: 'https://github.com/o/r' });
  });

  afterAll(async () => { await testDb.cleanup(); });

  const session = (id: string, extra: Partial<typeof workbenches.$inferInsert> = {}) => insertWorkbench({
    id, workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', name: id, branch: 'feat', baseBranch: 'main',
    runtime: 'sandbox', agent: 'claude', status: 'provisioning', statusMessage: 'Creating the sandbox',
    sandboxState: 'creating', ...extra,
  });

  beforeEach(async () => {
    await testDb.db.delete(workbenches);
    await testDb.db.execute(sql`DELETE FROM workbench_maintenance_claims`);
    await session(WB);
    await insertChat({ id: 'chat', workbenchId: WB, workspaceId: 'ws', title: 'Chat', agent: 'claude' });
    fleet = new FakeFleet();
    clones = 0;
    onClone = () => ({ exitCode: 0 });
    vi.spyOn(sandboxRun, 'resolveSandboxCredentials').mockResolvedValue({ ok: true, creds: { claudeToken: 'test' }, githubToken: 'test' });
    vi.spyOn(sandboxRun, 'resolveRepository').mockResolvedValue({ slug: 'o/r', defaultBranch: 'main' });
    vi.spyOn(sandboxRun, 'buildSandboxCreateBody').mockImplementation(async (input) => ({ ok: true, body: { id: input.id, workspaceId: input.workspaceId } }));
    vi.spyOn(runtime, 'fleetCreateTarget').mockResolvedValue({ client: fleet.asClient() });
    vi.spyOn(runtime, 'loadWorkbenchConfig').mockResolvedValue(null as never);
    vi.spyOn(sandboxSize, 'sizeForSession').mockResolvedValue('standard');
    vi.spyOn(prLink, 'linkPullRequest').mockImplementation(async (row) => row);
    vi.spyOn(changes, 'refreshDiffStat').mockImplementation(async (row) => row);
    vi.spyOn(runtime, 'runCapture').mockImplementation(async (_row, script) => {
      const reply = script.includes('git clone --filter=blob:none') ? (clones++, await onClone()) : { exitCode: 0 };
      return { exitCode: reply.exitCode, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', stdoutBytes: Buffer.from(reply.stdout ?? '') } as never;
    });
  });

  afterEach(() => {
    resetWorkbenchDrainForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const claims = async () =>
    (await testDb.db.execute(sql`SELECT name, token FROM workbench_maintenance_claims`)).rows as Array<{ name: string; token: string }>;
  const holdClaim = (minutes: number) => testDb.db.execute(sql`INSERT INTO workbench_maintenance_claims (name, token, expires_at)
    VALUES (${CLAIM}, 'other-instance', now() + make_interval(mins => ${minutes}))`);
  const failureEvents = async () => (await listEvents('chat', 0, 50)).events
    .filter((e) => (e.event as { subtype?: string }).subtype === 'workbench_failed');

  it('provisions a session and lets the claim go', async () => {
    await provisionWorkbench(WB);
    expect(await getWorkbench(WB)).toMatchObject({ status: 'ready', sandboxState: 'running', sandboxId: OLD_BOX, fleetHost: 'host-1' });
    expect(clones).toBe(1);
    expect(await claims()).toEqual([]);
  });

  it('runs the pipeline once for two concurrent calls, and holds the claim while it runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inClone = new Promise<void>((resolve) => { entered = resolve; });
    onClone = async () => { entered(); await gate; return { exitCode: 0 }; };
    const first = provisionWorkbench(WB);
    await inClone;
    expect((await claims()).map((c) => c.name)).toEqual([CLAIM]);
    await provisionWorkbench(WB);
    release();
    await first;
    expect(clones).toBe(1);
    expect(fleet.created).toHaveLength(1);
    expect((await getWorkbench(WB))?.status).toBe('ready');
  });

  it('does nothing while another instance holds the claim', async () => {
    await holdClaim(2);
    const before = await getWorkbench(WB);
    await provisionWorkbench(WB);
    expect(fleet.created).toHaveLength(0);
    expect(runtime.runCapture).not.toHaveBeenCalled();
    expect(await getWorkbench(WB)).toEqual(before);
    expect(await claims()).toEqual([{ name: CLAIM, token: 'other-instance' }]);
  });

  it('takes over a claim that expired', async () => {
    await holdClaim(-1);
    await provisionWorkbench(WB);
    expect((await getWorkbench(WB))?.status).toBe('ready');
    expect(await claims()).toEqual([]);
  });

  it.each([
    ['ready', { status: 'ready', sandboxId: 'box', sandboxState: 'running', statusMessage: null }],
    ['failed', { status: 'error', sandboxId: 'box', sandboxState: 'error', statusMessage: 'boom' }],
    ['archived', { status: 'archived', sandboxId: 'box', sandboxState: 'deleted', archivedAt: new Date() }],
  ] as const)('a late call on a %s session does nothing', async (_name, patch) => {
    await updateWorkbench(WB, patch);
    const before = await getWorkbench(WB);
    await provisionWorkbench(WB);
    expect(fleet.created).toHaveLength(0);
    expect(runtime.runCapture).not.toHaveBeenCalled();
    expect(await getWorkbench(WB)).toEqual(before);
  });

  it('a box found lost while provisioning ends in error with a message that asks for a Retry', async () => {
    onClone = () => { throw new FleetRunNotFoundError('gone'); };
    await provisionWorkbench(WB);
    const row = await getWorkbench(WB);
    expect(row).toMatchObject({ status: 'error', sandboxState: 'error', statusMessage: SANDBOX_LOST_FAILED_MESSAGE });
    expect(row?.statusMessage).not.toContain('is starting');
  });

  it('a stale run after a Retry cannot fail the new generation', async () => {
    await testDb.db.update(workbenchChats).set({ queuedMessages: [{ id: 'm1', text: 'first prompt' }] as never });
    onClone = async () => {
      await updateWorkbench(WB, { sandboxId: NEW_BOX, sandboxState: 'creating', statusMessage: 'Creating the sandbox' });
      return { exitCode: 128, stderr: 'fatal: a half-made .git' };
    };
    await provisionWorkbench(WB);
    expect(await getWorkbench(WB)).toMatchObject({ status: 'provisioning', sandboxId: NEW_BOX, sandboxState: 'creating' });
    expect((await getChat('chat'))?.status).not.toBe('error');
    expect(await failureEvents()).toEqual([]);
  });

  it('a stale run cannot write back the sandbox id a Retry replaced', async () => {
    await updateWorkbench(WB, { sandboxId: OLD_BOX });
    const create = fleet.createSandbox.bind(fleet);
    vi.spyOn(fleet, 'createSandbox').mockImplementation(async (input) => {
      await updateWorkbench(WB, { sandboxId: NEW_BOX, sandboxState: 'creating', fleetHost: null });
      return create(input);
    });
    await provisionWorkbench(WB);
    expect(fleet.created.map((c) => c.id)).toEqual([OLD_BOX]);
    expect(await getWorkbench(WB)).toMatchObject({ status: 'provisioning', sandboxId: NEW_BOX, sandboxState: 'creating', fleetHost: null });
    expect(clones).toBe(0);
  });

  it('an archive during the provision is not marked ready', async () => {
    onClone = async () => {
      await updateWorkbench(WB, { status: 'archived', archivedAt: new Date() });
      return { exitCode: 0 };
    };
    await provisionWorkbench(WB);
    expect((await getWorkbench(WB))?.status).toBe('archived');
  });

  it('a run whose claim lapsed stops without failing the session', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await testDb.db.update(workbenchChats).set({ queuedMessages: [{ id: 'm1', text: 'first prompt' }] as never });
    onClone = async () => {
      // Another instance took the claim over; this run's next renewal fails.
      await testDb.db.execute(sql`UPDATE workbench_maintenance_claims SET token = 'other-instance' WHERE name = ${CLAIM}`);
      vi.advanceTimersByTime(20_000);
      // Real time for the renewal's query to answer: only the interval is faked.
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { exitCode: 1, stderr: 'fatal: index.lock exists' };
    };
    await provisionWorkbench(WB);
    expect(await getWorkbench(WB)).toMatchObject({ status: 'provisioning' });
    expect((await getChat('chat'))?.status).not.toBe('error');
    expect(await failureEvents()).toEqual([]);
    expect(await claims()).toEqual([{ name: CLAIM, token: 'other-instance' }]);
  });

  /** The provision keeps the box's start times and size on the row too; these tests are about the other keys. */
  const withoutBoxStart = (settings: object | undefined) => {
    const { boxStart: _boxStart, boxStarts: _boxStarts, boxSize: _boxSize, ...rest } = (settings ?? {}) as Record<string, unknown>;
    return rest;
  };

  it('keeps settings written after the run read the row', async () => {
    await updateWorkbench(WB, { settings: { fleetSandboxId: 'stale-fleet-id' } });
    const create = fleet.createSandbox.bind(fleet);
    vi.spyOn(fleet, 'createSandbox').mockImplementation(async (input) => {
      await updateWorkbench(WB, { settings: { fleetSandboxId: 'stale-fleet-id', keptSandboxIds: ['older-box'], internetAccess: false } });
      return create(input);
    });
    await provisionWorkbench(WB);
    const row = await getWorkbench(WB);
    expect(row?.status).toBe('ready');
    expect(withoutBoxStart(row?.settings)).toEqual({ keptSandboxIds: ['older-box'], internetAccess: false });
    expect(row?.settings).toHaveProperty('boxStart.sandboxId', row?.sandboxId);
  });

  it.each([
    ['finishes a resize that asked for this size', { resizeTo: 'standard', resizeReason: 'r' }, { sandboxSize: 'standard' }],
    ['keeps a resize that asked for another size', { resizeTo: 'large', resizeReason: 'r' }, { resizeTo: 'large', resizeReason: 'r' }],
  ])('%s', async (_name, settings, expected) => {
    vi.spyOn(sandboxSize, 'sessionSandboxSize').mockReturnValue('standard');
    await updateWorkbench(WB, { settings });
    await provisionWorkbench(WB);
    expect(withoutBoxStart((await getWorkbench(WB))?.settings)).toEqual(expected);
  });

  it('records the fleet sandbox id when the fleet names its own', async () => {
    vi.spyOn(fleet, 'createSandbox').mockResolvedValue({ sandbox: { id: 'fleet-own-id', status: 'idle' }, host: 'host-1' } as never);
    await provisionWorkbench(WB);
    expect(withoutBoxStart((await getWorkbench(WB))?.settings)).toEqual({ fleetSandboxId: 'fleet-own-id' });
  });

  describe('the resume sweep', () => {
    it('resumes a stranded provision and skips one another instance holds', async () => {
      await session('wb-held');
      await testDb.db.execute(sql`INSERT INTO workbench_maintenance_claims (name, token, expires_at)
        VALUES (${provisionClaimName('wb-held')}, 'other-instance', now() + interval '2 minutes')`);
      await sweepStrandedProvisions();
      await vi.waitFor(async () => expect((await getWorkbench(WB))?.status).toBe('ready'));
      await vi.waitFor(async () => expect(await claims()).toEqual([{ name: provisionClaimName('wb-held'), token: 'other-instance' }]));
      expect(await getWorkbench('wb-held')).toMatchObject({ status: 'provisioning', sandboxId: null, sandboxState: 'creating' });
      expect(fleet.created.map((c) => c.id)).toEqual([OLD_BOX]);
    });

    it('leaves ready, archived and local sessions alone', async () => {
      await updateWorkbench(WB, { status: 'ready', sandboxId: 'box', sandboxState: 'running' });
      await session('wb-archived', { archivedAt: new Date() });
      await session('wb-local', { runtime: 'local' });
      expect(await sweepStrandedProvisions()).toBe(0);
    });

    it('stops at drain', async () => {
      beginWorkbenchDrain();
      expect(await sweepStrandedProvisions()).toBe(0);
      expect(fleet.created).toHaveLength(0);
    });
  });

  describe('archive against a provision on another instance', () => {
    it('waits while another instance holds the provision claim', async () => {
      await updateWorkbench(WB, {
        status: 'archived', archivedAt: new Date(), archivePendingAt: new Date(Date.now() - 300_000),
        sandboxId: OLD_BOX, sandboxState: 'running',
      });
      await holdClaim(2);
      const fleetClient = vi.spyOn(runtime, 'fleetClientFor');
      await processArchive(WB);
      expect(fleetClient).not.toHaveBeenCalled();
      expect(await getWorkbench(WB)).toMatchObject({ archiveLeaseUntil: null, sandboxState: 'running' });
    });
  });

  describe('a Retry of a session stuck while it starts', () => {
    const SETUP_CONFIG = { setup: { command: 'docker compose up -d' }, run: [], runMode: 'concurrent', filesToCopy: [], source: 'talyn', errors: [] };
    const watch = { ...PROVISION_SETUP_WATCH };
    /** Resolves when a provision reaches its setup script. */
    let inSetup: Promise<void>;
    let setupRuns: number;

    beforeEach(() => {
      PROVISION_SETUP_WATCH.checkMs = 10;
      PROVISION_SETUP_WATCH.ownershipCheckMs = 30;
      setupRuns = 0;
      vi.spyOn(runtime, 'loadWorkbenchConfig').mockResolvedValue(SETUP_CONFIG as never);
      vi.spyOn(runtime, 'fleetClientFor').mockResolvedValue(fleet.asClient());
      let entered!: () => void;
      inSetup = new Promise<void>((resolve) => { entered = resolve; });
      // The first setup run hangs, as on a box whose disk failed. A later run exits 0.
      vi.spyOn(scripts, 'startScript').mockImplementation(async () => {
        setupRuns += 1;
        entered();
        return { done: setupRuns === 1 ? new Promise<number | null>(() => undefined) : Promise.resolve(0) };
      });
    });

    afterEach(() => {
      Object.assign(PROVISION_SETUP_WATCH, watch);
    });

    it('moves a stuck session to the next sandbox id and deletes the old box', async () => {
      await updateWorkbench(WB, { sandboxId: OLD_BOX, sandboxState: 'running', fleetHost: 'host-1', statusMessage: 'Running the setup script' });
      await holdClaim(2);
      const row = await retryWorkbench(WB);
      expect(row).toMatchObject({ status: 'provisioning', sandboxId: NEW_BOX, sandboxState: 'creating', fleetHost: null, statusMessage: 'Creating the sandbox' });
      expect(fleet.deleted).toEqual([OLD_BOX]);
      expect(await getWorkbench(WB)).toMatchObject({ status: 'provisioning', sandboxId: NEW_BOX });
    });

    it('deletes the first box id when the stuck run has not recorded one yet', async () => {
      await holdClaim(2);
      const row = await retryWorkbench(WB);
      expect(fleet.deleted).toEqual([OLD_BOX]);
      expect(row.sandboxId).toBe(NEW_BOX);
    });

    it('keeps a stuck recovery of a lost box a recovery', async () => {
      await updateWorkbench(WB, { sandboxId: OLD_BOX, sandboxState: 'lost', memoryRestorePending: 'lost' });
      await holdClaim(2);
      const row = await retryWorkbench(WB);
      expect(row).toMatchObject({ sandboxId: NEW_BOX, sandboxState: 'lost', memoryRestorePending: 'lost' });
    });

    it('goes on when the sick host cannot delete the old box', async () => {
      await updateWorkbench(WB, { sandboxId: OLD_BOX, sandboxState: 'running' });
      await holdClaim(2);
      vi.spyOn(fleet, 'deleteSandbox').mockRejectedValue(new Error('fleet host timed out'));
      expect((await retryWorkbench(WB)).sandboxId).toBe(NEW_BOX);
    });

    it('still stops a failed session whose old box the fleet could not delete', async () => {
      await updateWorkbench(WB, { status: 'error', sandboxId: OLD_BOX, sandboxState: 'error', statusMessage: 'boom' });
      vi.spyOn(fleet, 'deleteSandbox').mockRejectedValue(new Error('fleet host timed out'));
      await expect(retryWorkbench(WB)).rejects.toThrow('fleet host timed out');
      expect(await getWorkbench(WB)).toMatchObject({ status: 'error', sandboxId: OLD_BOX });
    });

    it.each([
      ['a ready session', 409, 'not_failed', { status: 'ready', sandboxId: OLD_BOX, sandboxState: 'running', statusMessage: null }],
      ['a moving session', 409, 'not_failed', { status: 'moving', sandboxId: OLD_BOX, sandboxState: 'running' }],
      ['an archived session', 409, 'not_ready', { status: 'archived', sandboxId: OLD_BOX, sandboxState: 'deleted', archivedAt: new Date() }],
      ['an archived session still provisioning', 409, 'not_ready', { sandboxId: OLD_BOX, archivedAt: new Date() }],
      ['a local session', 409, 'local_runtime', { runtime: 'local' }],
    ] as const)('refuses %s and changes nothing', async (_name, status, code, patch) => {
      await updateWorkbench(WB, patch as never);
      const before = await getWorkbench(WB);
      await expect(retryWorkbench(WB)).rejects.toMatchObject({ status, code });
      expect(fleet.deleted).toEqual([]);
      expect(await getWorkbench(WB)).toEqual(before);
    });

    it('a provision hung in its setup script stops when a Retry moves the row, and the new provision runs to ready', async () => {
      const first = provisionWorkbench(WB);
      await inSetup;
      expect(await getWorkbench(WB)).toMatchObject({ status: 'provisioning', sandboxId: OLD_BOX, statusMessage: 'Running the setup script' });

      await retryWorkbench(WB);
      expect(fleet.deleted).toEqual([OLD_BOX]);
      // The hung run ends on its own, and lets the claim go.
      await first;
      expect(await claims()).toEqual([]);
      expect(await getWorkbench(WB)).toMatchObject({ status: 'provisioning', sandboxId: NEW_BOX });

      await sweepStrandedProvisions();
      await vi.waitFor(async () => expect(await getWorkbench(WB)).toMatchObject({ status: 'ready', sandboxId: NEW_BOX, statusMessage: null }));
      expect(fleet.created.map((c) => c.id)).toEqual([OLD_BOX, NEW_BOX]);
      expect(setupRuns).toBe(2);
      expect(await failureEvents()).toEqual([]);
      await vi.waitFor(async () => expect(await claims()).toEqual([]));
    });

    it('a hung setup run stops on drain and writes no failure', async () => {
      await testDb.db.update(workbenchChats).set({ queuedMessages: [{ id: 'm1', text: 'first prompt' }] as never });
      const first = provisionWorkbench(WB);
      await inSetup;
      beginWorkbenchDrain();
      await first;
      expect(await getWorkbench(WB)).toMatchObject({ status: 'provisioning', sandboxId: OLD_BOX, statusMessage: 'Running the setup script' });
      expect((await getChat('chat'))?.status).not.toBe('error');
      expect(await failureEvents()).toEqual([]);
      expect(await claims()).toEqual([]);
    });

    it('a hung setup run stops when its claim is lost, and writes no failure', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const first = provisionWorkbench(WB);
      await inSetup;
      await testDb.db.execute(sql`UPDATE workbench_maintenance_claims SET token = 'other-instance' WHERE name = ${CLAIM}`);
      vi.advanceTimersByTime(20_000);
      await first;
      expect(await getWorkbench(WB)).toMatchObject({ status: 'provisioning', sandboxId: OLD_BOX });
      expect(await failureEvents()).toEqual([]);
      expect(await claims()).toEqual([{ name: CLAIM, token: 'other-instance' }]);
    });

    it('a setup script that exits still makes the session ready', async () => {
      vi.spyOn(scripts, 'startScript').mockResolvedValue({ done: Promise.resolve(3) });
      await provisionWorkbench(WB);
      expect(await getWorkbench(WB)).toMatchObject({
        status: 'ready',
        statusMessage: 'The setup script exited with 3. Its output is in the Scripts panel.',
      });
    });

    it('reads the learned-step results of the box once its setup ends', async () => {
      vi.spyOn(scripts, 'startScript').mockResolvedValue({ done: Promise.resolve(0) });
      const record = vi.spyOn(setupRecipe, 'recordBoxSetupResults').mockResolvedValue();
      await provisionWorkbench(WB);
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0]).toMatchObject({ id: WB, sandboxId: OLD_BOX });
    });
  });
});
