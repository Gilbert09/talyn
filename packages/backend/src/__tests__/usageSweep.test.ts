import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
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
  workbenches,
  workspaces,
} from '../db/schema.js';
import type { FleetClient, FleetSandbox } from '../services/selfHosted/client.js';
import * as websocketModule from '../services/websocket.js';
import { insertOpenInterval } from '../services/billing/usage/intervals.js';
import {
  decideOpenInterval,
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
    expect(await sweep.run(NOW)).toEqual({ opened: 0, closed: 1, listErrors: 0 });
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

  it('reads each box through a gateway, which lists no status', async () => {
    await open(`talyn-${TASK_ID}`);
    const sweep = new UsageSweep(async () => [host([{ id: `talyn-${TASK_ID}`, status: 'stopped', endedAt: '2026-11-10T11:59:30Z' }, { id: 'talyn-wb-one', status: 'busy' }], { gateway: true })]);
    expect(await sweep.run(NOW)).toEqual({ opened: 1, closed: 1, listErrors: 0 });
    expect((await intervals())[`talyn-${TASK_ID}`].endReason).toBe('terminal');
  });

  describe('a gateway lists a box under its own id, <talyn id>--<suffix>', () => {
    const gatewayBox = (status: Box['status'] = 'busy') => host([{ id: 'talyn-wb-one--3542ee', status }], { gateway: true });

    it('matches the interval the hook opened under the Talyn id, and opens no second one', async () => {
      await open('talyn-wb-one', 'workbench', 'wb-1');
      const sweep = new UsageSweep(async () => [gatewayBox()]);
      expect(await sweep.run(NOW)).toEqual({ opened: 0, closed: 0, listErrors: 0 });
      expect(await sweep.run(new Date(NOW.getTime() + 60_000))).toEqual({ opened: 0, closed: 0, listErrors: 0 });
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
      expect(await sweep.run(NOW)).toEqual({ opened: 0, closed: 1, listErrors: 0 });
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
