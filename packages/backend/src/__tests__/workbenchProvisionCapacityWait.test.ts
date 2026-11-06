import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFleet } from './helpers/fakeFleet.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import * as changes from '../services/workbenches/changes.js';
import * as emit from '../services/workbenches/emit.js';
import * as prLink from '../services/workbenches/prLink.js';
import * as runtime from '../services/workbenches/sandboxRuntime.js';
import * as sandboxSize from '../services/workbenches/sandboxSize.js';
import * as accountSelection from '../services/selfHosted/accountSelection.js';
import * as sandboxRun from '../services/selfHosted/sandboxRun.js';
import {
  FleetCapacityError,
  FleetHttpError,
  FleetThrottleError,
  HIBERNATION_FETCH_FAILED,
  type FleetSandbox,
} from '../services/selfHosted/client.js';
import { beginWorkbenchDrain, resetWorkbenchDrainForTests } from '../services/workbenches/ownership.js';
import {
  capacityWaitDelayMs,
  createWorkbenchSandbox,
  NO_FREE_SANDBOX_MESSAGE,
  PROVISION_CAPACITY_WAIT,
  provisionClaimName,
  provisionWorkbench,
  WAITING_FOR_SANDBOX_MESSAGE,
} from '../services/workbenches/lifecycle.js';
import { getChat, getWorkbench, insertChat, insertWorkbench, listEvents, updateWorkbench } from '../services/workbenches/store.js';

const WB = 'wb-wait';
const CLAIM = provisionClaimName(WB);
const BOX = runtime.sandboxIdFor(WB);
const DEFAULT_WAIT = { ...PROVISION_CAPACITY_WAIT };

const busy = (reason: 'no_capacity' | 'unreachable' = 'no_capacity') =>
  new FleetCapacityError('host full at http://10.0.0.1', undefined, reason);

describe('a provision waits for a free sandbox', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;
  /** Status messages the provision emitted, in order. */
  let messages: Array<string | null>;

  beforeAll(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Test' });
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'o/r', url: 'https://github.com/o/r' });
  });

  afterAll(async () => { await testDb.cleanup(); });

  beforeEach(async () => {
    Object.assign(PROVISION_CAPACITY_WAIT, { maxMs: 2_000, firstDelayMs: 5, maxDelayMs: 20, checkMs: 5, queuePollMs: 5 });
    await testDb.db.delete(workbenches);
    await testDb.db.execute(sql`DELETE FROM workbench_maintenance_claims`);
    await insertWorkbench({
      id: WB, workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', name: WB, branch: 'feat', baseBranch: 'main',
      runtime: 'sandbox', agent: 'claude', status: 'provisioning', statusMessage: 'Creating the sandbox',
      sandboxState: 'creating', sandboxId: BOX,
    });
    await insertChat({ id: 'chat', workbenchId: WB, workspaceId: 'ws', title: 'Chat', agent: 'claude' });
    await testDb.db.update(workbenchChats).set({ queuedMessages: [{ id: 'm1', text: 'first prompt' }] as never });
    fleet = new FakeFleet();
    messages = [];
    vi.spyOn(sandboxRun, 'resolveSandboxCredentials').mockResolvedValue({ ok: true, creds: { claudeToken: 'test' }, githubToken: 'test' });
    vi.spyOn(accountSelection, 'resolveRunCredential')
      .mockImplementation(async (_workspaceId, agent) => agent === 'claude' ? { token: 'test' } : null);
    vi.spyOn(sandboxRun, 'resolveRepository').mockResolvedValue({ slug: 'o/r', defaultBranch: 'main' });
    vi.spyOn(sandboxRun, 'buildSandboxCreateBody').mockImplementation(async (input) => ({ ok: true, body: { id: input.id, workspaceId: input.workspaceId } }));
    vi.spyOn(runtime, 'fleetCreateTarget').mockResolvedValue({ client: fleet.asClient() });
    vi.spyOn(runtime, 'loadWorkbenchConfig').mockResolvedValue(null as never);
    vi.spyOn(sandboxSize, 'sizeForSession').mockResolvedValue('standard');
    vi.spyOn(prLink, 'linkPullRequest').mockImplementation(async (row) => row);
    vi.spyOn(changes, 'refreshDiffStat').mockImplementation(async (row) => row);
    vi.spyOn(runtime, 'runCapture').mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', stdoutBytes: Buffer.from('') } as never);
    const emitUpdated = emit.emitWorkbenchUpdated;
    vi.spyOn(emit, 'emitWorkbenchUpdated').mockImplementation(async (wb) => {
      messages.push(wb.statusMessage ?? null);
      return emitUpdated(wb);
    });
  });

  afterEach(() => {
    Object.assign(PROVISION_CAPACITY_WAIT, DEFAULT_WAIT);
    resetWorkbenchDrainForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The fleet answers each create from `script` in turn, then creates the box. */
  const fleetAnswers = (...script: Array<Error | ((attempt: number) => Promise<void> | void)>) => {
    const create = fleet.createSandbox.bind(fleet);
    let attempt = 0;
    return vi.spyOn(fleet, 'createSandbox').mockImplementation(async (input) => {
      const step = script[attempt++];
      if (step instanceof Error) throw step;
      if (step) await step(attempt);
      return create(input);
    });
  };
  /** A fleet that is always full, after running `during` on the given try. */
  const alwaysFull = (during?: { onAttempt: number; run: () => Promise<void> | void }) => {
    let attempt = 0;
    return vi.spyOn(fleet, 'createSandbox').mockImplementation(async () => {
      attempt++;
      if (during && attempt === during.onAttempt) await during.run();
      throw busy();
    });
  };
  const failureEvents = async () => (await listEvents('chat', 0, 50)).events
    .filter((e) => (e.event as { subtype?: string }).subtype === 'workbench_failed');
  const claims = async () =>
    (await testDb.db.execute(sql`SELECT name, token FROM workbench_maintenance_claims`)).rows as Array<{ name: string; token: string }>;

  it.each(['no_capacity', 'unreachable'] as const)('waits through a full fleet (%s) and ends ready', async (reason) => {
    const create = fleetAnswers(busy(reason), busy(reason));
    await provisionWorkbench(WB);
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls.map(([input]) => input.id)).toEqual([BOX, BOX, BOX]);
    expect(await getWorkbench(WB)).toMatchObject({ status: 'ready', sandboxState: 'running', sandboxId: BOX, statusMessage: null });
    expect(messages).toContain(WAITING_FOR_SANDBOX_MESSAGE);
    expect(messages.filter((m) => m === WAITING_FOR_SANDBOX_MESSAGE)).toHaveLength(1);
    expect(await failureEvents()).toEqual([]);
    const metrics = (await listEvents('chat', 0, 50)).events.map(({ event }) => event)
      .filter((event) => event.subtype === 'boot_metric');
    expect(metrics.map((event) => event.metric)).toEqual(['capacity_wait_start', 'capacity_wait_end', 'box_created']);
    expect(metrics[1].ms).toBeGreaterThanOrEqual(0);
    expect(metrics[2]).toMatchObject({ cause: 'new', totalMs: expect.any(Number) });
    expect(await claims()).toEqual([]);
  });

  it('waits through a 429 (the fleet queue cap or its rate limit) and ends ready', async () => {
    const create = fleetAnswers(new FleetThrottleError('queue_depth: this tenant has too many queued sandboxes'));
    await provisionWorkbench(WB);
    expect(create).toHaveBeenCalledTimes(2);
    expect(await getWorkbench(WB)).toMatchObject({ status: 'ready', sandboxId: BOX });
    expect(messages).toContain(WAITING_FOR_SANDBOX_MESSAGE);
    expect(await failureEvents()).toEqual([]);
  });

  it('shows the waiting message on the row while it waits', async () => {
    let seen: string | null | undefined;
    fleetAnswers(busy(), async () => { seen = (await getWorkbench(WB))?.statusMessage; });
    await provisionWorkbench(WB);
    expect(seen).toBe(WAITING_FOR_SANDBOX_MESSAGE);
    expect((await getWorkbench(WB))?.status).toBe('ready');
  });

  it('fails with a clear message after the bound', async () => {
    Object.assign(PROVISION_CAPACITY_WAIT, { maxMs: 60 });
    const create = alwaysFull();
    await provisionWorkbench(WB);
    expect(create.mock.calls.length).toBeGreaterThan(1);
    expect(await getWorkbench(WB)).toMatchObject({ status: 'error', sandboxState: 'error', statusMessage: NO_FREE_SANDBOX_MESSAGE });
    expect((await getChat('chat'))?.status).toBe('error');
    expect(await claims()).toEqual([]);
  });

  it('stops without a failure write when the backend drains during the wait', async () => {
    const create = alwaysFull({ onAttempt: 2, run: () => beginWorkbenchDrain() });
    await provisionWorkbench(WB);
    expect(create).toHaveBeenCalledTimes(2);
    expect(await getWorkbench(WB)).toMatchObject({ status: 'provisioning', statusMessage: WAITING_FOR_SANDBOX_MESSAGE });
    expect((await getChat('chat'))?.status).not.toBe('error');
    expect(await failureEvents()).toEqual([]);
    // The claim goes, so the next instance's sweep can resume the wait at once.
    expect(await claims()).toEqual([]);
  });

  it('stops without a failure write when the claim is lost during the wait', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    alwaysFull({
      onAttempt: 2,
      run: async () => {
        await testDb.db.execute(sql`UPDATE workbench_maintenance_claims SET token = 'other-instance' WHERE name = ${CLAIM}`);
        vi.advanceTimersByTime(20_000);
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
    });
    await provisionWorkbench(WB);
    expect(await getWorkbench(WB)).toMatchObject({ status: 'provisioning' });
    expect((await getChat('chat'))?.status).not.toBe('error');
    expect(await failureEvents()).toEqual([]);
    expect(await claims()).toEqual([{ name: CLAIM, token: 'other-instance' }]);
  });

  it.each([
    ['archived', { status: 'archived', archivedAt: new Date() }],
    ['given a new sandbox id', { sandboxId: runtime.sandboxIdFor(WB, 1) }],
    ['failed', { status: 'error', statusMessage: 'boom' }],
  ] as const)('stops when the row is %s during the wait', async (_name, patch) => {
    const create = alwaysFull({ onAttempt: 1, run: async () => { await updateWorkbench(WB, patch); } });
    await provisionWorkbench(WB);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await getWorkbench(WB)).toMatchObject(patch);
    expect(await failureEvents()).toEqual([]);
  });

  it('stops when the row is archived between two tries', async () => {
    const create = alwaysFull({ onAttempt: 2, run: async () => { await updateWorkbench(WB, { status: 'archived', archivedAt: new Date() }); } });
    await provisionWorkbench(WB);
    expect(create).toHaveBeenCalledTimes(2);
    expect((await getWorkbench(WB))?.status).toBe('archived');
    expect(await failureEvents()).toEqual([]);
  });

  it.each([
    ['a fleet refusal', new FleetHttpError('bad request', 400)],
    ['a plain fault', new Error('boom')],
    ['a hibernation fetch failure', new FleetCapacityError('fetch failed', undefined, 'no_capacity', HIBERNATION_FETCH_FAILED)],
  ])('fails at once on %s', async (_name, err) => {
    const create = fleetAnswers(err);
    await provisionWorkbench(WB);
    expect(create).toHaveBeenCalledTimes(1);
    const row = await getWorkbench(WB);
    expect(row?.status).toBe('error');
    expect(row?.statusMessage).not.toBe(WAITING_FOR_SANDBOX_MESSAGE);
    expect(messages).not.toContain(WAITING_FOR_SANDBOX_MESSAGE);
  });

  describe('the fleet queues the box', () => {
    const LOST = 'lost while queued: fleetd restarted before this sandbox booted, and its credentials were held only in memory.';
    const queued = { status: 'queued', phase: 'placing' } as const;
    type Record = Pick<FleetSandbox, 'status' | 'phase' | 'error'>;
    /** Each create answers from `answers` in turn: a record, or an error to throw. Past the end, an idle box. */
    const createAnswers = (...answers: Array<Record | Error>) => {
      let attempt = 0;
      return vi.spyOn(fleet, 'createSandbox').mockImplementation(async (input) => {
        fleet.created.push(input);
        const answer = answers[attempt++];
        if (answer instanceof Error) throw answer;
        return { sandbox: { id: input.id, ...(answer ?? { status: 'idle', phase: 'ready' }) } as FleetSandbox, host: 'host-1' };
      });
    };
    /** Each poll runs `before` (when given) and answers from `polls` in turn. Past the end, the last answer. */
    const pollAnswers = (polls: Array<Record | Error>, before?: (poll: number) => Promise<void> | void) => {
      let poll = 0;
      return vi.spyOn(fleet, 'getSandbox').mockImplementation(async (id) => {
        const n = poll++;
        if (before) await before(n + 1);
        const answer = polls[Math.min(n, polls.length - 1)];
        if (answer instanceof Error) throw answer;
        return { sandbox: { id, ...answer } as FleetSandbox, terminal: false };
      });
    };
    const waitingMessages = () => messages.filter((m) => m === WAITING_FOR_SANDBOX_MESSAGE);

    it.each([
      ['a session', {}],
      ['a thread', { kind: 'thread', repositoryId: null }],
    ] as const)('asks the fleet to queue the box for %s', async (_name, patch) => {
      await updateWorkbench(WB, patch as never);
      await provisionWorkbench(WB);
      expect(fleet.created).toHaveLength(1);
      expect(fleet.created[0]).toMatchObject({ id: BOX, queueWhenFull: true });
      expect((await getWorkbench(WB))?.status).toBe('ready');
    });

    it.each([
      ['a move', {}],
      ['a resize', { strictSize: true }],
    ])('does not ask the fleet to queue the box for %s', async (_name, opts) => {
      // The move path calls createWorkbenchSandbox with no queueWhenFull.
      const made = await createWorkbenchSandbox((await getWorkbench(WB))!, runtime.sandboxIdFor(WB, 1), opts);
      expect(made.ok).toBe(true);
      expect(fleet.created).toHaveLength(1);
      expect(fleet.created[0]).not.toHaveProperty('queueWhenFull');
    });

    it.each([
      ['idle at once', [{ status: 'idle', phase: 'ready' }]],
      ['starting, then idle', [queued, { status: 'starting', phase: 'placing' }, { status: 'idle', phase: 'ready' }]],
      ['busy', [{ status: 'busy', phase: 'agent' }]],
      ['after a poll the fleet could not answer', [new FleetThrottleError('slow down'), { status: 'idle', phase: 'ready' }]],
      ['after an unreachable poll', [busy('unreachable'), { status: 'idle', phase: 'ready' }]],
    ] as const)('waits for a queued box that boots (%s) and ends ready', async (_name, polls) => {
      const create = createAnswers(queued);
      const poll = pollAnswers([...polls]);
      await provisionWorkbench(WB);
      expect(create).toHaveBeenCalledTimes(1);
      expect(poll.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(poll.mock.calls.every(([id]) => id === BOX)).toBe(true);
      expect(await getWorkbench(WB)).toMatchObject({ status: 'ready', sandboxState: 'running', sandboxId: BOX, statusMessage: null });
      expect(waitingMessages()).toHaveLength(1);
      expect(fleet.deleted).toEqual([]);
      expect(await failureEvents()).toEqual([]);
      expect(await claims()).toEqual([]);
    });

    it('clones only after the queued box has booted', async () => {
      let booted = false;
      createAnswers(queued);
      pollAnswers([queued, queued, { status: 'idle', phase: 'ready' }], (n) => { if (n === 3) booted = true; });
      const clone = vi.mocked(runtime.runCapture).mockImplementation(async () => {
        expect(booted).toBe(true);
        return { exitCode: 0, stdout: '', stderr: '', stdoutBytes: Buffer.from('') } as never;
      });
      await provisionWorkbench(WB);
      expect(clone).toHaveBeenCalled();
      expect((await getWorkbench(WB))?.status).toBe('ready');
    });

    it('shows the waiting message on the row while the box is queued', async () => {
      let seen: string | null | undefined;
      createAnswers(queued);
      pollAnswers([queued, { status: 'idle', phase: 'ready' }], async (n) => {
        if (n === 1) seen = (await getWorkbench(WB))?.statusMessage;
      });
      await provisionWorkbench(WB);
      expect(seen).toBe(WAITING_FOR_SANDBOX_MESSAGE);
    });

    it('a 503 and then a queued box show the waiting message once and end ready', async () => {
      const create = createAnswers(busy(), queued);
      pollAnswers([{ status: 'idle', phase: 'ready' }]);
      await provisionWorkbench(WB);
      expect(create.mock.calls.map(([input]) => input.id)).toEqual([BOX, BOX]);
      expect((await getWorkbench(WB))?.status).toBe('ready');
      expect(waitingMessages()).toHaveLength(1);
    });

    it('a 503 and then a queued box share one bound', async () => {
      // A clock that the fakes move on. The bound is 2 s.
      let offset = 0;
      const realNow = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
      const create = createAnswers(busy());
      create.mockImplementationOnce(async () => { throw busy(); });
      create.mockImplementationOnce(async (input) => {
        offset += 1_500;
        return { sandbox: { id: input.id, ...queued } as FleetSandbox, host: 'host-1' };
      });
      // A separate clock for the queue would have 1.5 s left after this poll, and poll again.
      const poll = pollAnswers([queued], () => { offset += 1_000; });
      await provisionWorkbench(WB);
      expect(create).toHaveBeenCalledTimes(2);
      expect(poll).toHaveBeenCalledTimes(1);
      expect(await getWorkbench(WB)).toMatchObject({ status: 'error', statusMessage: NO_FREE_SANDBOX_MESSAGE });
      expect(fleet.deleted).toEqual([BOX]);
    });

    it.each([
      ['found by a poll', [queued], [{ status: 'failed', phase: 'queued', error: LOST }]],
      ['answered by the create', [{ status: 'failed', phase: 'queued', error: LOST }], []],
      ['found by the queue pump', [queued], [{ status: 'failed', phase: 'queued', error: 'queued run did not survive a supervisor restart' }]],
    ] as const)('creates the box again on a new id when the fleet lost it (%s)', async (_name, creates, polls) => {
      const create = createAnswers(...creates);
      if (polls.length) pollAnswers([...polls]);
      const next = runtime.sandboxIdFor(WB, 1);
      await provisionWorkbench(WB);
      expect(create.mock.calls.map(([input]) => input.id)).toEqual([BOX, next]);
      expect(create.mock.calls[1][0]).toMatchObject({ queueWhenFull: true });
      expect(await getWorkbench(WB)).toMatchObject({ status: 'ready', sandboxState: 'running', sandboxId: next, statusMessage: null });
      expect(await failureEvents()).toEqual([]);
      expect(await claims()).toEqual([]);
    });

    it('a lost box that is queued again on its new id still waits', async () => {
      const next = runtime.sandboxIdFor(WB, 1);
      createAnswers(queued, queued);
      const poll = pollAnswers([{ status: 'failed', phase: 'queued', error: LOST }, queued, { status: 'idle', phase: 'ready' }]);
      await provisionWorkbench(WB);
      expect(poll.mock.calls.map(([id]) => id)).toEqual([BOX, next, next]);
      expect(await getWorkbench(WB)).toMatchObject({ status: 'ready', sandboxId: next });
      // The move to the new id emits the row again, with the same message: it is shown once.
      expect(messages.filter((m, i) => m === WAITING_FOR_SANDBOX_MESSAGE && messages[i - 1] !== m)).toHaveLength(1);
    });

    it.each([
      ['a poll', [queued], [{ status: 'failed', phase: 'queued', error: 'waited 30m0s for capacity without being admitted (limit 30m0s)' }]],
      ['the create', [{ status: 'failed', phase: 'queued', error: 'waited 30m0s for capacity without being admitted (limit 30m0s)' }], []],
    ] as const)('fails with the no-free-sandbox message when the fleet queue times out (%s)', async (_name, creates, polls) => {
      const create = createAnswers(...creates);
      if (polls.length) pollAnswers([...polls]);
      await provisionWorkbench(WB);
      expect(create).toHaveBeenCalledTimes(1);
      expect(await getWorkbench(WB)).toMatchObject({ status: 'error', sandboxState: 'error', statusMessage: NO_FREE_SANDBOX_MESSAGE });
      expect((await getChat('chat'))?.status).toBe('error');
      expect(await claims()).toEqual([]);
    });

    it('fails with the no-free-sandbox message and deletes the queued box when the bound is reached', async () => {
      Object.assign(PROVISION_CAPACITY_WAIT, { maxMs: 60 });
      createAnswers(queued);
      const poll = pollAnswers([queued]);
      await provisionWorkbench(WB);
      expect(poll.mock.calls.length).toBeGreaterThan(1);
      expect(await getWorkbench(WB)).toMatchObject({ status: 'error', sandboxState: 'error', statusMessage: NO_FREE_SANDBOX_MESSAGE });
      expect(fleet.deleted).toEqual([BOX]);
      expect(await claims()).toEqual([]);
    });

    it.each([
      ['fails while it boots', { status: 'failed', phase: 'booting', error: 'kernel panic' }, 'kernel panic'],
      ['fails in the queue for another reason', { status: 'failed', phase: 'queued', error: 'queue closed' }, 'queue closed'],
      ['is stopped', { status: 'stopped', phase: 'queued' }, 'stopped'],
    ] as const)('fails with the fleet error when the queued box %s', async (_name, record, text) => {
      createAnswers(queued);
      pollAnswers([record]);
      await provisionWorkbench(WB);
      const row = await getWorkbench(WB);
      expect(row?.status).toBe('error');
      expect(row?.statusMessage).toContain(text);
      expect(row?.statusMessage).not.toBe(NO_FREE_SANDBOX_MESSAGE);
    });

    it('stops without a failure write and keeps the queued box when the backend drains', async () => {
      createAnswers(queued);
      const poll = pollAnswers([queued], (n) => { if (n === 2) beginWorkbenchDrain(); });
      await provisionWorkbench(WB);
      expect(poll).toHaveBeenCalledTimes(2);
      expect(await getWorkbench(WB)).toMatchObject({ status: 'provisioning', sandboxId: BOX, statusMessage: WAITING_FOR_SANDBOX_MESSAGE });
      expect((await getChat('chat'))?.status).not.toBe('error');
      expect(await failureEvents()).toEqual([]);
      expect(fleet.deleted).toEqual([]);
      expect(await claims()).toEqual([]);
    });

    it('a resumed provision finds the same queued box and waits again', async () => {
      createAnswers(queued, queued);
      pollAnswers([queued, queued, { status: 'idle', phase: 'ready' }], (n) => { if (n === 1) beginWorkbenchDrain(); });
      await provisionWorkbench(WB);
      expect((await getWorkbench(WB))?.status).toBe('provisioning');
      resetWorkbenchDrainForTests();
      await provisionWorkbench(WB);
      expect(fleet.created.map((input) => input.id)).toEqual([BOX, BOX]);
      expect(await getWorkbench(WB)).toMatchObject({ status: 'ready', sandboxId: BOX });
      expect(fleet.deleted).toEqual([]);
    });

    it.each([
      ['archived', { status: 'archived', archivedAt: new Date() }],
      ['given a new sandbox id', { sandboxId: runtime.sandboxIdFor(WB, 1) }],
      ['failed', { status: 'error', statusMessage: 'boom' }],
    ] as const)('deletes the queued box and writes no failure when the row is %s during the wait', async (_name, patch) => {
      createAnswers(queued);
      const poll = pollAnswers([queued]);
      const create = vi.mocked(fleet.createSandbox);
      // The row moves on during the first sleep, before the first poll.
      create.mockImplementationOnce(async (input) => {
        fleet.created.push(input);
        setTimeout(() => { void updateWorkbench(WB, patch); }, 0);
        return { sandbox: { id: input.id, ...queued } as FleetSandbox, host: 'host-1' };
      });
      Object.assign(PROVISION_CAPACITY_WAIT, { queuePollMs: 50 });
      await provisionWorkbench(WB);
      expect(poll).not.toHaveBeenCalled();
      expect(fleet.deleted).toEqual([BOX]);
      expect(await getWorkbench(WB)).toMatchObject(patch);
      expect(await failureEvents()).toEqual([]);
      expect(await claims()).toEqual([]);
    });

    it('deletes the queued box when the row is archived between two polls', async () => {
      createAnswers(queued);
      const poll = pollAnswers([queued], async (n) => {
        if (n === 2) await updateWorkbench(WB, { status: 'archived', archivedAt: new Date() });
      });
      await provisionWorkbench(WB);
      expect(poll).toHaveBeenCalledTimes(2);
      expect(fleet.deleted).toEqual([BOX]);
      expect((await getWorkbench(WB))?.status).toBe('archived');
      expect(await failureEvents()).toEqual([]);
    });

    it('keeps the queued box when the claim is lost but the row still names it', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      createAnswers(queued);
      pollAnswers([queued], async (n) => {
        if (n !== 1) return;
        await testDb.db.execute(sql`UPDATE workbench_maintenance_claims SET token = 'other-instance' WHERE name = ${CLAIM}`);
        vi.advanceTimersByTime(20_000);
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      await provisionWorkbench(WB);
      expect(await getWorkbench(WB)).toMatchObject({ status: 'provisioning', sandboxId: BOX });
      expect(fleet.deleted).toEqual([]);
      expect(await failureEvents()).toEqual([]);
      expect(await claims()).toEqual([{ name: CLAIM, token: 'other-instance' }]);
    });
  });

  describe('capacityWaitDelayMs', () => {
    beforeEach(() => { Object.assign(PROVISION_CAPACITY_WAIT, DEFAULT_WAIT); });

    it.each([
      [0, undefined, 10_000],
      [1, undefined, 20_000],
      [2, undefined, 40_000],
      [3, undefined, 60_000],
      [10, undefined, 60_000],
      [100, undefined, 60_000],
      [0, 30_000, 30_000],
      [0, 5_000, 10_000],
      [0, 600_000, 60_000],
    ])('attempt %i with Retry-After %s waits about %i ms', (attempt, retryAfter, expected) => {
      expect(capacityWaitDelayMs(attempt, retryAfter, () => 0.5)).toBe(expected);
    });

    it.each([[0, 0.8], [0.999999, 1.2]])('jitter at random %f stays within 20 percent', (random, factor) => {
      expect(capacityWaitDelayMs(0, undefined, () => random)).toBeCloseTo(10_000 * factor, -1);
    });
  });
});
