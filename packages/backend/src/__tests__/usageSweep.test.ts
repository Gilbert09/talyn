import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  prCodeReviewRuns,
  prCodeReviews,
  pullRequests,
  repositories,
  tasks,
  usageIntervals,
  usagePeriods,
  workbenchResourceSamples,
  workbenches,
  workspaces,
} from '../db/schema.js';
import type { SandboxSize } from '@talyn/shared';
import type { FleetClient, FleetSandbox } from '../services/selfHosted/client.js';
import * as websocketModule from '../services/websocket.js';
import { insertOpenInterval, markIntervalClosed } from '../services/billing/usage/intervals.js';
import { chargeOwnerAt } from '../services/billing/usage/charge.js';
import {
  decideOpenInterval,
  decideResize,
  DOWNSIZE_AFTER_TICKS,
  MISSING_TICKS_TO_CLOSE,
  sizeForBox,
  subjectForSandboxId,
  UsageSweep,
  type TenantClient,
} from '../services/billing/usage/sweep.js';
import { UsageMeter } from '../services/billing/usage/meter.js';

const OWNER = 'owner-a';
const NOW = new Date('2026-11-10T12:00:00.000Z');
const TASK_ID = '0b5c3a52-6a61-4b55-9d3c-2f9f0e0d6a11';

type Box = Partial<FleetSandbox> & { id: string; status: FleetSandbox['status']; suspendedAt?: string };

/** A host that lists `boxes`; `fail` makes its list throw. */
function host(boxes: Box[], opts: { gateway?: boolean; fail?: boolean } = {}): TenantClient {
  const client = {
    listSandboxes: async () => {
      if (opts.fail) throw new Error('host down');
      return { sandboxes: boxes };
    },
    listGatewaySandboxes: async () => {
      if (opts.fail) throw new Error('gateway down');
      return { sandboxes: boxes.map((b) => ({ id: b.id, host: 'h1' })) };
    },
    getSandbox: async (id: string) => {
      const sandbox = boxes.find((b) => b.id === id);
      if (!sandbox) throw new Error('not found');
      return { sandbox, terminal: false };
    },
  } as unknown as FleetClient;
  return { client, gateway: opts.gateway ?? false };
}

describe('usage sweep: pure parts', () => {
  it.each<[string, Box | undefined, number, { close: boolean; reason?: string; at?: string }]>([
    ['busy', { id: 'b', status: 'busy' }, 0, { close: false }],
    ['idle (awake, billed)', { id: 'b', status: 'idle' }, 0, { close: false }],
    ['starting', { id: 'b', status: 'starting' }, 0, { close: false }],
    ['suspended at its own time', { id: 'b', status: 'suspended', suspendedAt: '2026-11-10T11:58:00Z' }, 0, { close: true, reason: 'suspended', at: '2026-11-10T11:58:00.000Z' }],
    ['suspended with no time', { id: 'b', status: 'suspended' }, 0, { close: true, reason: 'suspended', at: NOW.toISOString() }],
    ['stopped at its end', { id: 'b', status: 'stopped', endedAt: '2026-11-10T11:59:00Z' }, 0, { close: true, reason: 'terminal', at: '2026-11-10T11:59:00.000Z' }],
    ['failed', { id: 'b', status: 'failed' }, 0, { close: true, reason: 'terminal', at: NOW.toISOString() }],
    ['cancelled', { id: 'b', status: 'cancelled' }, 0, { close: true, reason: 'terminal', at: NOW.toISOString() }],
    ['queued (not running)', { id: 'b', status: 'queued' }, 0, { close: true, reason: 'sweep', at: NOW.toISOString() }],
    ['missing once', undefined, 1, { close: false }],
    ['missing twice', undefined, MISSING_TICKS_TO_CLOSE, { close: true, reason: 'sweep', at: NOW.toISOString() }],
  ])('%s', (_label, box, missing, expected) => {
    const decision = decideOpenInterval(box, missing, NOW);
    expect(decision.close).toBe(expected.close);
    if (decision.close) {
      expect(decision.reason).toBe(expected.reason);
      expect(decision.at.toISOString()).toBe(expected.at);
    }
  });

  it.each([
    ['talyn-wb-0123456789abcdef01234567', { kind: 'workbench', key: 'talyn-wb-0123456789abcdef01234567' }],
    ['talyn-wb-0123456789abcdef01234567-r2', { kind: 'workbench', key: 'talyn-wb-0123456789abcdef01234567-r2' }],
    ['talyn-rev-run-1', { kind: 'review_unit', key: 'run-1' }],
    ['talyn-rev-run-1-r1', { kind: 'review_unit', key: 'run-1' }],
    [`talyn-${TASK_ID}`, { kind: 'task', key: TASK_ID }],
    [`talyn-${TASK_ID}-r3`, { kind: 'task', key: TASK_ID }],
    ['selftest-123', null],
  ])('subjectForSandboxId(%s)', (id, expected) => {
    expect(subjectForSandboxId(id)).toEqual(expected);
  });

  it.each([
    [{ memMib: 4096, vcpuCount: 2 }, 'task', 'small'],
    [{ memMib: 4096, vcpuCount: 4 }, 'task', 'standard'],
    [{ memMib: 12288, vcpuCount: 6 }, 'workbench', 'large'],
    [{}, 'task', 'standard'],
    [{}, 'review_unit', 'small'],
  ] as const)('sizeForBox(%o, %s) = %s', (box, kind, size) => {
    expect(sizeForBox(box, kind)).toBe(size);
  });
});

describe('usage sweep: decideResize', () => {
  it.each([
    ['heavier moves at once', 'standard', 'large', undefined, { resize: 'large' }],
    ['heavier moves at once even mid-streak', 'medium', 'large', { ticks: 4, size: 'standard' }, { resize: 'large' }],
    ['equal clears the streak', 'large', 'large', { ticks: 4, size: 'standard' }, { lighter: null }],
    ['equal with no streak', 'small', 'small', undefined, { lighter: null }],
    ['first lighter tick starts a streak', 'large', 'standard', undefined, { lighter: { ticks: 1, size: 'standard' } }],
    ['a lighter tick adds to the streak', 'large', 'standard', { ticks: 2, size: 'standard' }, { lighter: { ticks: 3, size: 'standard' } }],
    ['the streak keeps its heaviest size', 'large', 'standard', { ticks: 2, size: 'medium' }, { lighter: { ticks: 3, size: 'medium' } }],
    ['a heavier lighter size replaces a lighter one', 'xlarge', 'large', { ticks: 1, size: 'standard' }, { lighter: { ticks: 2, size: 'large' } }],
    ['the last tick of the streak moves down', 'large', 'standard', { ticks: DOWNSIZE_AFTER_TICKS - 1, size: 'standard' }, { resize: 'standard' }],
    ['the last tick moves to the heaviest size seen', 'large', 'standard', { ticks: DOWNSIZE_AFTER_TICKS - 1, size: 'medium' }, { resize: 'medium' }],
  ] as const)('%s', (_label, current, measured, lighter, expected) => {
    expect(decideResize(current, measured, lighter)).toEqual(expected);
  });

  it('waits five ticks before a move down', () => {
    expect(DOWNSIZE_AFTER_TICKS).toBe(5);
  });
});

describe('usage sweep against the fleet', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    await seedUser(db, { id: OWNER });
    await db.insert(workspaces).values({ id: 'ws', ownerId: OWNER, name: 'W' });
    await db.insert(tasks).values({ id: TASK_ID, workspaceId: 'ws', type: 'code_writing', title: 't', description: '' });
    await db.insert(workbenches).values({
      id: 'wb-1', workspaceId: 'ws', repoFullName: 'acme/app', name: 'wb', branch: 'b', baseBranch: 'main',
      runtime: 'sandbox', agent: 'claude', sandboxId: 'talyn-wb-one', sandboxState: 'suspended', status: 'ready',
    });
    vi.spyOn(websocketModule, 'emitUsageAlert').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  const open = (sandboxId: string, kind: 'task' | 'workbench' = 'task', subjectId = TASK_ID) =>
    insertOpenInterval({ ownerId: OWNER, workspaceId: 'ws', subjectKind: kind, subjectId, sandboxId, size: 'standard', startedAt: new Date(NOW.getTime() - 600_000) });
  const intervals = async () => Object.fromEntries((await db.select().from(usageIntervals)).map((r) => [r.sandboxId, r]));

  it('closes a box the fleet suspended at its suspend time and marks the session', async () => {
    await open('talyn-wb-one', 'workbench', 'wb-1');
    await db.update(workbenches).set({ sandboxState: 'running' });
    const sweep = new UsageSweep(async () => [host([{ id: 'talyn-wb-one', status: 'suspended', suspendedAt: '2026-11-10T11:55:00Z' }])]);
    expect(await sweep.run(NOW)).toEqual({ opened: 0, closed: 1, resized: 0, listErrors: 0 });
    const row = (await intervals())['talyn-wb-one'];
    expect(row.endReason).toBe('suspended');
    expect(row.endedAt?.toISOString()).toBe('2026-11-10T11:55:00.000Z');
    const [wb] = await db.select({ state: workbenches.sandboxState }).from(workbenches);
    expect(wb.state).toBe('suspended');
  });

  it('opens an interval for a running box with none, and maps it to its owner', async () => {
    const sweep = new UsageSweep(async () => [host([
      { id: 'talyn-wb-one', status: 'idle', memMib: 12288, vcpuCount: 6 },
      { id: `talyn-${TASK_ID}`, status: 'busy', memMib: 4096, vcpuCount: 2 },
      { id: 'talyn-unknown-task', status: 'busy' },
      { id: 'selftest-1', status: 'busy' },
    ])]);
    expect(await sweep.run(NOW)).toMatchObject({ opened: 2, closed: 0 });
    const rows = await intervals();
    expect(rows['talyn-wb-one']).toMatchObject({ ownerId: OWNER, subjectKind: 'workbench', subjectId: 'wb-1', size: 'large' });
    expect(rows['talyn-wb-one'].startedAt.toISOString()).toBe(NOW.toISOString());
    expect(rows[`talyn-${TASK_ID}`]).toMatchObject({ subjectKind: 'task', subjectId: TASK_ID, size: 'small' });
    const [wb] = await db.select({ state: workbenches.sandboxState }).from(workbenches);
    expect(wb.state).toBe('running');
    // A second run changes nothing.
    expect(await sweep.run(NOW)).toMatchObject({ opened: 0, closed: 0 });
  });

  it('maps a review unit box through its run row', async () => {
    await db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'acme/app', url: 'https://github.com/acme/app' });
    await db.insert(pullRequests).values({ id: 'pr', workspaceId: 'ws', repositoryId: 'repo', owner: 'acme', repo: 'app', number: 1, state: 'open' });
    await db.insert(prCodeReviews).values({
      id: 'rev-1', workspaceId: 'ws', repositoryId: 'repo', pullRequestId: 'pr', cycle: 1, preset: 'standard', runsTotal: 1, targetHeadSha: 'a'.repeat(40),
    });
    await db.insert(prCodeReviewRuns).values({ id: 'run-1', reviewId: 'rev-1', workspaceId: 'ws', cycle: 1, kind: 'lens' });
    const sweep = new UsageSweep(async () => [host([{ id: 'talyn-rev-run-1-r1', status: 'busy' }])]);
    expect((await sweep.run(NOW)).opened).toBe(1);
    expect((await intervals())['talyn-rev-run-1-r1']).toMatchObject({ subjectKind: 'review_unit', subjectId: 'run-1', size: 'small' });
  });

  it('closes a box missing from every list only after two clean ticks', async () => {
    await open(`talyn-${TASK_ID}`);
    const sweep = new UsageSweep(async () => [host([])]);
    expect((await sweep.run(NOW)).closed).toBe(0);
    expect((await sweep.run(new Date(NOW.getTime() + 60_000))).closed).toBe(1);
    expect((await intervals())[`talyn-${TASK_ID}`].endReason).toBe('sweep');
  });

  it('never counts a box missing on a tick where a host list failed', async () => {
    await open(`talyn-${TASK_ID}`);
    const sweep = new UsageSweep(async () => [host([]), host([], { fail: true })]);
    for (let i = 0; i < 4; i++) expect((await sweep.run(NOW)).closed).toBe(0);
    expect((await intervals())[`talyn-${TASK_ID}`].endedAt).toBeNull();
  });

  it('a box seen again resets its missing count', async () => {
    await open(`talyn-${TASK_ID}`);
    let present = false;
    const sweep = new UsageSweep(async () => [host(present ? [{ id: `talyn-${TASK_ID}`, status: 'busy' }] : [])]);
    await sweep.run(NOW);
    present = true;
    await sweep.run(NOW);
    present = false;
    expect((await sweep.run(NOW)).closed).toBe(0);
  });

  describe('resource samples for the Sandbox panel chart', () => {
    const samples = () => db.select().from(workbenchResourceSamples);

    it('stores one sample per running session box, and none for tasks or boxes without figures', async () => {
      await db.insert(workbenches).values({
        id: 'wb-2', workspaceId: 'ws', repoFullName: 'acme/app', name: 'wb2', branch: 'c', baseBranch: 'main',
        runtime: 'sandbox', agent: 'claude', sandboxId: 'talyn-wb-two', sandboxState: 'running', status: 'ready',
      });
      await open('talyn-wb-two', 'workbench', 'wb-2');
      const sweep = new UsageSweep(async () => [host([
        // Opened this tick: still sampled.
        { id: 'talyn-wb-one', status: 'busy', memUsedMib: 900, cpuSeconds: 42.5, memMib: 4096, milliVcpu: 2000 },
        // Already open, no figures: no sample.
        { id: 'talyn-wb-two', status: 'idle', memMib: 4096 },
        { id: `talyn-${TASK_ID}`, status: 'busy', memUsedMib: 500, cpuSeconds: 1 },
      ])]);
      await sweep.run(NOW);
      expect(await samples()).toEqual([
        { workbenchId: 'wb-1', sandboxId: 'talyn-wb-one', sampledAt: NOW, memUsedMib: 900, memLimitMib: 4096, cpuSeconds: 42.5, vcpus: 2 },
      ]);
    });

    it.each([
      ['suspended', { status: 'suspended' as const, suspendedAt: '2026-11-10T11:59:00Z' }],
      ['queued', { status: 'queued' as const }],
      ['stopped', { status: 'stopped' as const }],
    ])('stores no sample for a %s box', async (_label, box) => {
      await open('talyn-wb-one', 'workbench', 'wb-1');
      await new UsageSweep(async () => [host([{ id: 'talyn-wb-one', memUsedMib: 900, cpuSeconds: 3, ...box }])]).run(NOW);
      expect(await samples()).toEqual([]);
    });

    it('adds a row each tick and deletes rows older than two hours', async () => {
      await open('talyn-wb-one', 'workbench', 'wb-1');
      await db.insert(workbenchResourceSamples).values([
        { workbenchId: 'wb-1', sandboxId: 'talyn-wb-one', sampledAt: new Date(NOW.getTime() - 3 * 3600_000), memUsedMib: 1 },
        { workbenchId: 'wb-1', sandboxId: 'talyn-wb-one', sampledAt: new Date(NOW.getTime() - 3600_000), memUsedMib: 2 },
      ]);
      const sweep = new UsageSweep(async () => [host([{ id: 'talyn-wb-one', status: 'busy', memUsedMib: 3, cpuSeconds: 5 }])]);
      await sweep.run(NOW);
      await sweep.run(new Date(NOW.getTime() + 60_000));
      expect((await samples()).map((r) => r.memUsedMib).sort()).toEqual([2, 3, 3]);
    });

    it('samples a session box read through a gateway', async () => {
      await open('talyn-wb-one', 'workbench', 'wb-1');
      await new UsageSweep(async () => [host([{ id: 'talyn-wb-one', status: 'idle', memUsedMib: 700 }], { gateway: true })]).run(NOW);
      expect(await samples()).toMatchObject([{ workbenchId: 'wb-1', memUsedMib: 700, cpuSeconds: null }]);
    });
  });

  it('reads each box through a gateway, which lists no status', async () => {
    await open(`talyn-${TASK_ID}`);
    const sweep = new UsageSweep(async () => [host([{ id: `talyn-${TASK_ID}`, status: 'stopped', endedAt: '2026-11-10T11:59:30Z' }, { id: 'talyn-wb-one', status: 'busy' }], { gateway: true })]);
    expect(await sweep.run(NOW)).toEqual({ opened: 1, closed: 1, resized: 0, listErrors: 0 });
    expect((await intervals())[`talyn-${TASK_ID}`].endReason).toBe('terminal');
  });

  describe('a gateway lists a box under its own id, <talyn id>--<suffix>', () => {
    const gatewayBox = (status: Box['status'] = 'busy') => host([{ id: 'talyn-wb-one--3542ee', status }], { gateway: true });

    it('matches the interval the hook opened under the Talyn id, and opens no second one', async () => {
      await open('talyn-wb-one', 'workbench', 'wb-1');
      const sweep = new UsageSweep(async () => [gatewayBox()]);
      expect(await sweep.run(NOW)).toEqual({ opened: 0, closed: 0, resized: 0, listErrors: 0 });
      expect(await sweep.run(new Date(NOW.getTime() + 60_000))).toEqual({ opened: 0, closed: 0, resized: 0, listErrors: 0 });
      expect(Object.keys(await intervals())).toEqual(['talyn-wb-one']);
    });

    it('closes the Talyn-id interval when the suffixed box suspends', async () => {
      await open('talyn-wb-one', 'workbench', 'wb-1');
      const sweep = new UsageSweep(async () => [gatewayBox('suspended')]);
      expect((await sweep.run(NOW)).closed).toBe(1);
      expect((await intervals())['talyn-wb-one'].endReason).toBe('suspended');
    });

    it('opens a missing interval under the Talyn id', async () => {
      const sweep = new UsageSweep(async () => [gatewayBox()]);
      expect((await sweep.run(NOW)).opened).toBe(1);
      expect((await intervals())['talyn-wb-one']).toMatchObject({ subjectKind: 'workbench', subjectId: 'wb-1', endedAt: null });
    });

    it('closes a duplicate already open for the same box at its own start, and keeps the older one', async () => {
      await open('talyn-wb-one', 'workbench', 'wb-1');
      const laterStart = new Date(NOW.getTime() - 60_000);
      await insertOpenInterval({ ownerId: OWNER, workspaceId: 'ws', subjectKind: 'workbench', subjectId: 'wb-1', sandboxId: 'talyn-wb-one--3542ee', size: 'standard', startedAt: laterStart });
      const sweep = new UsageSweep(async () => [gatewayBox()]);
      expect(await sweep.run(NOW)).toEqual({ opened: 0, closed: 1, resized: 0, listErrors: 0 });
      const rows = await intervals();
      expect(rows['talyn-wb-one'].endedAt).toBeNull();
      expect(rows['talyn-wb-one--3542ee'].endedAt?.toISOString()).toBe(laterStart.toISOString());
    });

    it('closes an interval kept under a suffixed id once its box is missing for two ticks', async () => {
      await open('talyn-wb-one--3542ee', 'workbench', 'wb-1');
      const sweep = new UsageSweep(async () => [host([], { gateway: true })]);
      expect((await sweep.run(NOW)).closed).toBe(0);
      expect((await sweep.run(new Date(NOW.getTime() + 60_000))).closed).toBe(1);
    });
  });

  describe('bills the memory a running box uses', () => {
    const SB = `talyn-${TASK_ID}`;
    const LARGE = { memMib: 12288, vcpuCount: 6 };
    const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
    const rows = () => db.select().from(usageIntervals).orderBy(asc(usageIntervals.startedAt));
    const openSized = async (size: SandboxSize, startedAt = at(-600), billedThrough?: Date) => {
      await insertOpenInterval({ ownerId: OWNER, workspaceId: 'ws', subjectKind: 'task', subjectId: TASK_ID, sandboxId: SB, size, startedAt });
      if (billedThrough) await db.update(usageIntervals).set({ billedThrough });
    };
    /** A sweep whose one box reports `memUsedMib` (undefined = not reported) on each run. */
    const sweepOf = (box: () => Partial<FleetSandbox>) => new UsageSweep(async () => [host([{ id: SB, status: 'busy', ...LARGE, ...box() }])]);

    it('moves up at once, closing at the last charge and opening the heavier size there', async () => {
      await openSized('standard', at(-600), at(-60));
      const result = await sweepOf(() => ({ memUsedMib: 9000 })).run(NOW);
      expect(result).toEqual({ opened: 0, closed: 0, resized: 1, listErrors: 0 });
      const [old, next] = await rows();
      expect(old).toMatchObject({ size: 'standard', endReason: 'resize', endedAt: at(-60) });
      expect(next).toMatchObject({ size: 'large', weight: '2.00', endedAt: null, startedAt: at(-60), billedThrough: at(-60) });
    });

    it('does not close an interval a hook opened after the sweep read the old one', async () => {
      await openSized('standard', at(-600), at(-60));
      // A payer change lands while the sweep lists the fleet.
      const sweep = new UsageSweep(async () => {
        await markIntervalClosed(SB, at(-10), 'payer_change');
        await insertOpenInterval({ ownerId: OWNER, workspaceId: 'ws', subjectKind: 'task', subjectId: TASK_ID, sandboxId: SB, size: 'standard', startedAt: at(-10) });
        return [host([{ id: SB, status: 'busy', ...LARGE, memUsedMib: 9000 }])];
      });
      expect((await sweep.run(NOW)).resized).toBe(0);
      const all = await rows();
      expect(all).toHaveLength(2);
      expect(all[0]).toMatchObject({ endReason: 'payer_change' });
      expect(all[1]).toMatchObject({ size: 'standard', endedAt: null, startedAt: at(-10) });
    });

    it.each([
      ['a stale cursor reprices one minute only', at(-600), at(-60)],
      ['a cursor inside the last minute is the split', at(-30), at(-30)],
      ['a cursor exactly one minute back', at(-60), at(-60)],
      ['a cursor at now', NOW, NOW],
    ])('splits at max(billedThrough, now - 60 s): %s', async (_label, billedThrough, splitAt) => {
      await openSized('standard', at(-900), billedThrough);
      expect((await sweepOf(() => ({ memUsedMib: 9000 })).run(NOW)).resized).toBe(1);
      const [old, next] = await rows();
      expect(old.endedAt).toEqual(splitAt);
      expect(next.startedAt).toEqual(splitAt);
      expect(next.billedThrough).toEqual(splitAt);
    });

    it('moves down only after five lighter ticks in a row', async () => {
      await openSized('large');
      const sweep = sweepOf(() => ({ memUsedMib: 1536 }));
      for (let i = 0; i < DOWNSIZE_AFTER_TICKS - 1; i++) {
        expect((await sweep.run(at(i * 60))).resized).toBe(0);
      }
      expect((await rows()).map((r) => r.size)).toEqual(['large']);
      const last = at((DOWNSIZE_AFTER_TICKS - 1) * 60);
      expect((await sweep.run(last)).resized).toBe(1);
      const [old, next] = await rows();
      expect(old).toMatchObject({ size: 'large', endReason: 'resize' });
      expect(next).toMatchObject({ size: 'standard', endedAt: null, startedAt: new Date(last.getTime() - 60_000) });
      // The next lighter tick does nothing: the interval already bills standard.
      expect((await sweep.run(at(DOWNSIZE_AFTER_TICKS * 60))).resized).toBe(0);
    });

    it.each([
      ['an equal tick', 10_000],
      ['a heavier-than-booted reading (still the booted size)', 20_000],
      ['an unknown reading', undefined],
    ])('%s resets the lighter count', async (_label, breakMem) => {
      await openSized('large');
      const mem: (number | undefined)[] = [1536, 1536, 1536, 1536, breakMem, 1536, 1536, 1536, 1536];
      let i = 0;
      const sweep = sweepOf(() => ({ memUsedMib: mem[i] }));
      for (; i < mem.length; i++) expect((await sweep.run(at(i * 60))).resized).toBe(0);
      mem.push(1536);
      expect((await sweep.run(at(i * 60))).resized).toBe(1);
      expect((await rows()).map((r) => r.size)).toEqual(['large', 'standard']);
    });

    it('moves down to the heaviest size the lighter ticks measured', async () => {
      await openSized('large');
      const mem = [1536, 6000, 1536, 1536, 1536];
      let i = 0;
      const sweep = sweepOf(() => ({ memUsedMib: mem[i] }));
      for (; i < mem.length - 1; i++) expect((await sweep.run(at(i * 60))).resized).toBe(0);
      expect((await sweep.run(at(i * 60))).resized).toBe(1);
      expect((await rows()).map((r) => r.size)).toEqual(['large', 'medium']);
    });

    it.each([
      ['no memory figure', { memUsedMib: undefined }],
      ['a zero memory figure', { memUsedMib: 0 }],
      ['no booted resources', { memMib: undefined, vcpuCount: undefined, memUsedMib: 1536 }],
    ])('never splits with %s', async (_label, box) => {
      await openSized('large');
      const sweep = sweepOf(() => box);
      for (let i = 0; i < DOWNSIZE_AFTER_TICKS * 2; i++) expect((await sweep.run(at(i * 60))).resized).toBe(0);
      expect((await rows()).map((r) => r.size)).toEqual(['large']);
    });

    it('never bills above the booted size', async () => {
      await openSized('medium');
      const sweep = new UsageSweep(async () => [host([{ id: SB, status: 'busy', memMib: 8192, vcpuCount: 4, memUsedMib: 15_000 }])]);
      for (let i = 0; i < 3; i++) expect((await sweep.run(at(i * 60))).resized).toBe(0);
      expect((await rows()).map((r) => r.size)).toEqual(['medium']);
    });

    it('caps a move up at the booted size', async () => {
      await openSized('standard');
      const sweep = new UsageSweep(async () => [host([{ id: SB, status: 'busy', memMib: 8192, vcpuCount: 4, memUsedMib: 15_000 }])]);
      expect((await sweep.run(NOW)).resized).toBe(1);
      expect((await rows()).map((r) => r.size)).toEqual(['standard', 'medium']);
    });

    it.each([1536, 4096, 8000, 16_000])('a small box stays small at %s MiB', async (memUsedMib) => {
      await openSized('small');
      const sweep = new UsageSweep(async () => [host([{ id: SB, status: 'busy', memMib: 4096, vcpuCount: 2, memUsedMib }])]);
      for (let i = 0; i < DOWNSIZE_AFTER_TICKS + 1; i++) expect((await sweep.run(at(i * 60))).resized).toBe(0);
      expect((await rows()).map((r) => r.size)).toEqual(['small']);
    });

    it('does not resize a box that is closing this tick', async () => {
      await openSized('standard');
      const sweep = new UsageSweep(async () => [host([{ id: SB, status: 'suspended', ...LARGE, memUsedMib: 9000 }])]);
      expect(await sweep.run(NOW)).toMatchObject({ closed: 1, resized: 0 });
      expect((await rows()).map((r) => [r.size, r.endReason])).toEqual([['standard', 'suspended']]);
    });

    it('keeps the owner, payer, workspace and subject on the new interval', async () => {
      await seedUser(db, { id: 'payer-b' });
      await insertOpenInterval({
        ownerId: 'payer-b', workspaceId: 'ws', subjectKind: 'workbench', subjectId: 'wb-1', sandboxId: 'talyn-wb-one',
        size: 'standard', startedAt: at(-600), payerUserId: 'payer-b',
      });
      const sweep = new UsageSweep(async () => [host([{ id: 'talyn-wb-one', status: 'idle', ...LARGE, memUsedMib: 9000 }])]);
      expect((await sweep.run(NOW)).resized).toBe(1);
      const [, next] = await rows();
      expect(next).toMatchObject({
        ownerId: 'payer-b', payerUserId: 'payer-b', workspaceId: 'ws', subjectKind: 'workbench', subjectId: 'wb-1',
        sandboxId: 'talyn-wb-one', size: 'large', endedAt: null,
      });
    });

    it('resizes the interval a gateway lists under a suffixed id', async () => {
      await openSized('standard');
      const sweep = new UsageSweep(async () => [host([{ id: `${SB}--3542ee`, status: 'busy', ...LARGE, memUsedMib: 9000 }], { gateway: true })]);
      expect((await sweep.run(NOW)).resized).toBe(1);
      expect((await rows()).map((r) => [r.sandboxId, r.size])).toEqual([[SB, 'standard'], [SB, 'large']]);
    });

    it.each([
      ['light', 1500, 'standard'],
      ['heavy', 9000, 'large'],
      ['unknown', undefined, 'large'],
    ])('opens a new interval at the measured size (%s)', async (_label, memUsedMib, size) => {
      const sweep = new UsageSweep(async () => [host([{ id: SB, status: 'busy', ...LARGE, memUsedMib }])]);
      expect((await sweep.run(NOW)).opened).toBe(1);
      expect((await rows()).map((r) => r.size)).toEqual([size]);
    });

    it('charges add up across a split: one minute at large, then one at standard', async () => {
      await openSized('large', at(-60));
      await chargeOwnerAt(OWNER, NOW);
      const sweep = sweepOf(() => ({ memUsedMib: 1536 }));
      for (let i = 0; i < DOWNSIZE_AFTER_TICKS; i++) await sweep.run(at(60));
      await chargeOwnerAt(OWNER, at(60));
      const [old, next] = await rows();
      expect(old).toMatchObject({ size: 'large', billedWsec: 120, endedAt: NOW, billedThrough: NOW });
      expect(next).toMatchObject({ size: 'standard', billedWsec: 60, startedAt: NOW, billedThrough: at(60) });
      const [period] = await db.select().from(usagePeriods).where(eq(usagePeriods.ownerId, OWNER));
      expect(period.usedWsec).toBe(180);
    });

    it('charges add up across a move up', async () => {
      await openSized('standard', at(-60));
      await chargeOwnerAt(OWNER, NOW);
      await sweepOf(() => ({ memUsedMib: 9000 })).run(at(60));
      await chargeOwnerAt(OWNER, at(60));
      const [period] = await db.select().from(usagePeriods).where(eq(usagePeriods.ownerId, OWNER));
      expect(period.usedWsec).toBe(60 + 120);
    });
  });

  it('the meter sweeps, then charges every owner with a box running', async () => {
    await open(`talyn-${TASK_ID}`);
    const meter = new UsageMeter(async () => [host([{ id: `talyn-${TASK_ID}`, status: 'busy' }, { id: 'talyn-wb-one', status: 'idle' }])]);
    const result = await meter.run(NOW);
    expect(result).toMatchObject({ owners: 1, opened: 1, closed: 0, failedOwners: 0 });
    const [period] = await db.select().from(usagePeriods).where(eq(usagePeriods.ownerId, OWNER));
    expect(period.usedWsec).toBe(600);
  });

  it('the meter tick reports on the debug bus and survives a failed sweep', async () => {
    await open(`talyn-${TASK_ID}`);
    const meter = new UsageMeter(async () => {
      throw new Error('registry down');
    });
    const result = await meter.tick(NOW);
    expect(result).toMatchObject({ owners: 1, failedOwners: 0 });
  });
});
