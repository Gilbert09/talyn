import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { asc, eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  integrations,
  prCodeReviewEvents,
  prCodeReviewRuns,
  prCodeReviews,
  pullRequests,
  repositories,
  workspaces,
} from '../db/schema.js';

/**
 * A review unit waits for fleet room the way a session's box does.
 *
 * The bug this covers: a full fleet (503) left the unit `claimed` with
 * `capacity_deferred`, nothing ever dispatched it again, and after five minutes
 * the reconciler failed it with "No runner became free in time". Now the
 * dispatch waits at the fleet (queueWhenFull, 503/429 backoff on the same id,
 * a queued box polled), the reconciler resumes a wait whose process died, and
 * only the 30-minute bound fails the unit.
 *
 * The real executor, store, reconciler and wait run against pglite. Only the
 * fleet's HTTP client, GitHub and the cloud chain are faked.
 */

const { createSandbox, getSandbox, deleteSandbox, cancelSandbox, scheduleReviewEvaluation, startCodeRun, chain } = vi.hoisted(() => ({
  chain: vi.fn(),
  cancelSandbox: vi.fn(),
  createSandbox: vi.fn(),
  getSandbox: vi.fn(),
  deleteSandbox: vi.fn(),
  scheduleReviewEvaluation: vi.fn(),
  startCodeRun: vi.fn(),
}));

vi.mock('../services/selfHosted/client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/selfHosted/client.js')>(
    '../services/selfHosted/client.js'
  );
  return {
    ...actual,
    FleetClient: class {
      createSandbox = createSandbox;
      getSandbox = getSandbox;
      deleteSandbox = deleteSandbox;
    },
  };
});
vi.mock('../services/selfHosted/credentials.js', async () => {
  const actual = await vi.importActual<typeof import('../services/selfHosted/credentials.js')>(
    '../services/selfHosted/credentials.js'
  );
  return { ...actual, getSelfHostedClient: vi.fn(async () => ({ getSandbox, deleteSandbox, cancelSandbox })) };
});
vi.mock('../services/github.js', () => ({
  githubService: {
    getVerifiedAccessToken: vi.fn(async () => 'gho_token'),
    getAllPRFiles: vi.fn(async () => [
      { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+x' },
    ]),
  },
}));
vi.mock('../services/codeReview/evaluator.js', () => ({ scheduleReviewEvaluation }));
vi.mock('../services/prCloudFix.js', () => ({ resolveCloudEnvChain: chain }));
vi.mock('../services/posthogCode/codeRun.js', () => ({ startCodeRun }));

const { dispatchUnit, nextUnitSandboxId, CAPACITY_GAVE_UP_MESSAGE } = await import('../services/codeReview/executor.js');
const { codeReviewReconciler, isResumableWait } = await import('../services/codeReview/reconciler.js');
const { getReview, getRun, UNIT_HEARTBEAT_GRACE_MS } = await import('../services/codeReview/store.js');
const { FLEET_CAPACITY_WAIT } = await import('../services/selfHosted/capacityWait.js');
const { FleetCapacityError, FleetThrottleError } = await import('../services/selfHosted/client.js');
const { publicReviewById } = await import('../services/codeReview/public.js');
const { cancelReviewCycle } = await import('../services/codeReview/cycle.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const warmPool = await import('../services/workbenches/warmPool.js');
type RunRow = import('../services/codeReview/store.js').RunRow;

const LENS = { kind: 'lens' as const, lens: 'correctness', chunkIndex: 0 };
const DEFAULT_WAIT = { ...FLEET_CAPACITY_WAIT };
const busy = () => new FleetCapacityError('all hosts busy');

let db: Database;
let cleanup: () => Promise<void>;
let priorTokenKey: string | undefined;

const reapOrphans = () =>
  (codeReviewReconciler as unknown as { reapOrphans(): Promise<void> }).reapOrphans();

const unitRow = async (lens = 'correctness') =>
  (await db.select().from(prCodeReviewRuns).where(eq(prCodeReviewRuns.lens, lens)))[0]!;

const events = async () =>
  db
    .select({ code: prCodeReviewEvents.code, message: prCodeReviewEvents.message })
    .from(prCodeReviewEvents)
    .orderBy(asc(prCodeReviewEvents.id));

const createdIds = () => createSandbox.mock.calls.map(([body]) => (body as { id: string }).id);

/** The fleet answers each create from `script` in turn, then boots the box. */
function fleetAnswers(...script: Array<Error | 'queued' | 'lost'>): void {
  let attempt = 0;
  createSandbox.mockImplementation(async (body: { id: string }) => {
    const step = script[attempt++];
    if (step instanceof Error) throw step;
    if (step === 'queued') return { sandbox: { id: body.id, status: 'queued' }, host: 'host-1' };
    if (step === 'lost') {
      return {
        sandbox: { id: body.id, status: 'failed', phase: 'queued', error: 'lost while queued: fleetd restarted' },
        host: 'host-1',
      };
    }
    return { sandbox: { id: body.id, status: 'busy' }, host: 'host-1' };
  });
}

/** A unit row as a wait left it: `claimed`, no dispatch, `capacity_deferred`. */
async function waitingUnit(over: Partial<typeof prCodeReviewRuns.$inferInsert> = {}): Promise<RunRow> {
  const id = over.id ?? 'unit-1';
  await db.insert(prCodeReviewRuns).values({
    id,
    reviewId: 'rev1',
    workspaceId: 'ws1',
    cycle: 1,
    kind: 'lens',
    lens: 'correctness',
    chunkIndex: 0,
    status: 'claimed',
    failureCode: 'capacity_deferred',
    sandboxId: `talyn-rev-${id}`,
    // Inside the (shortened) bound.
    capacityWaitSince: new Date(Date.now() - 100),
    // No heartbeat for longer than the grace: its process died.
    updatedAt: new Date(Date.now() - UNIT_HEARTBEAT_GRACE_MS - 60_000),
    ...over,
  });
  return (await getRun(id))!;
}

beforeEach(async () => {
  Object.assign(FLEET_CAPACITY_WAIT, { maxMs: 2_000, firstDelayMs: 5, maxDelayMs: 20, checkMs: 5, queuePollMs: 5 });
  priorTokenKey = process.env.TALYN_TOKEN_KEY;
  process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
  process.env.FLEET_API_TOKEN = 'fleet-token';
  process.env.FLEET_PINNED_ENDPOINT = 'https://fleet.test';
  ({ db, cleanup } = await createTestDb());
  vi.clearAllMocks();
  chain.mockResolvedValue([{ provider: 'selfhosted', envId: 'env-fleet' }]);
  vi.spyOn(warmPool, 'yieldWarmPool').mockResolvedValue(0);
  fleetAnswers();
  getSandbox.mockImplementation(async (id: string) => ({ sandbox: { id, status: 'busy' } }));
  deleteSandbox.mockResolvedValue(undefined);
  const { encryptString } = await import('../services/tokenCrypto.js');

  await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.com' });
  await db.insert(workspaces).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws' });
  await db.insert(repositories).values({
    id: 'repo1',
    workspaceId: 'ws1',
    name: 'a/b',
    url: 'https://github.com/a/b',
    defaultBranch: 'main',
  });
  await db.insert(pullRequests).values({
    id: 'pr1',
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    owner: 'a',
    repo: 'b',
    number: 1,
    state: 'open',
    lastSummary: { title: 'T', headSha: 'abc1234', headBranch: 'feat', baseBranch: 'main' },
  });
  await db.insert(prCodeReviews).values({
    id: 'rev1',
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    pullRequestId: 'pr1',
    cycle: 1,
    preset: 'standard',
    phase: 'reviewing',
    lensKeys: ['correctness', 'security', 'reliability'],
    runsTotal: 3,
    targetHeadSha: 'abc1234',
  });
  await db.insert(integrations).values({
    id: 'int1',
    workspaceId: 'ws1',
    type: 'selfhosted',
    enabled: true,
    config: { anthropicKeyEnc: encryptString('sk-ant-api-test') },
  });
});

afterEach(async () => {
  await cleanup();
  Object.assign(FLEET_CAPACITY_WAIT, DEFAULT_WAIT);
  vi.restoreAllMocks();
  if (priorTokenKey === undefined) delete process.env.TALYN_TOKEN_KEY;
  else process.env.TALYN_TOKEN_KEY = priorTokenKey;
  delete process.env.FLEET_API_TOKEN;
  delete process.env.FLEET_PINNED_ENDPOINT;
});

/** Wait for the unit's detached wait to end, and the review to be evaluated again. */
const waitEnded = () =>
  vi.waitFor(() => expect(scheduleReviewEvaluation).toHaveBeenCalledWith('rev1', 'executor:capacity_wait_ended'), {
    timeout: 10_000,
  });

describe('a unit dispatch that finds the fleet full', () => {
  it.each([
    ['503s', [busy(), busy()]],
    ['a 429 (tenant queue cap)', [new FleetThrottleError('queue_depth')]],
    ['an unreachable fleet', [new FleetCapacityError('down', undefined, 'unreachable')]],
  ])('waits through %s on the same idempotent id, then runs', async (_label, refusals) => {
    fleetAnswers(...refusals);
    const review = (await getReview('rev1'))!;

    await dispatchUnit(review, LENS);

    // The pass returned while the unit waits.
    const waiting = await unitRow();
    expect(waiting).toMatchObject({
      status: 'claimed',
      failureCode: 'capacity_deferred',
      dispatchedAt: null,
      sandboxId: `talyn-rev-${waiting.id}`,
      capacityWaitSince: expect.any(Date),
    });
    await waitEnded();
    const ran = await unitRow();
    expect(ran).toMatchObject({
      status: 'running',
      provider: 'selfhosted',
      failureCode: null,
      sandboxId: `talyn-rev-${ran.id}`,
      dispatchedAt: expect.any(Date),
    });
    expect(createdIds()).toEqual(Array(refusals.length + 1).fill(`talyn-rev-${ran.id}`));
    expect(createSandbox.mock.calls.every(([body]) => (body as { queueWhenFull?: boolean }).queueWhenFull)).toBe(true);
    expect((await events()).map((e) => e.code)).toEqual(['capacity_deferred']);
    expect(warmPool.yieldWarmPool).toHaveBeenCalledTimes(1);
  });

  it('polls a box the fleet queued, and records the dispatch only once it leaves the queue', async () => {
    fleetAnswers('queued');
    let polls = 0;
    getSandbox.mockImplementation(async (id: string) => ({
      sandbox: { id, status: ++polls < 3 ? 'queued' : 'busy' },
    }));

    await dispatchUnit((await getReview('rev1'))!, LENS);

    expect(await unitRow()).toMatchObject({ status: 'claimed', dispatchedAt: null, failureCode: 'capacity_deferred' });
    await waitEnded();
    expect(await unitRow()).toMatchObject({ status: 'running', dispatchedAt: expect.any(Date) });
    expect(createSandbox).toHaveBeenCalledTimes(1);
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it('moves to the next id when the fleet lost the queued box, and runs there', async () => {
    fleetAnswers('queued');
    getSandbox
      .mockResolvedValueOnce({ sandbox: { status: 'failed', phase: 'queued', error: 'lost while queued: restart' } })
      .mockImplementation(async (id: string) => ({ sandbox: { id, status: 'busy' } }));

    await dispatchUnit((await getReview('rev1'))!, LENS);
    await waitEnded();

    const ran = await unitRow();
    expect(createdIds()).toEqual([`talyn-rev-${ran.id}`, `talyn-rev-${ran.id}-r2`]);
    expect(ran).toMatchObject({ status: 'running', sandboxId: `talyn-rev-${ran.id}-r2` });
  });

  it('fails the unit after the bound, and says why', async () => {
    createSandbox.mockRejectedValue(busy());

    await dispatchUnit((await getReview('rev1'))!, LENS);
    await waitEnded();

    expect(await unitRow()).toMatchObject({ status: 'failed', failureCode: 'capacity_deferred', dispatchedAt: null });
    expect(await events()).toEqual([
      { code: 'capacity_deferred', message: 'Waiting for a runner.' },
      { code: 'capacity_gave_up', message: CAPACITY_GAVE_UP_MESSAGE },
    ]);
  });

  it('stops waiting when the review is cancelled, and lets the queued box go', async () => {
    fleetAnswers('queued');
    getSandbox.mockImplementation(async (id: string) => ({ sandbox: { id, status: 'queued' } }));

    await dispatchUnit((await getReview('rev1'))!, LENS);
    const unit = await unitRow();
    await db.update(prCodeReviewRuns).set({ status: 'cancelled' }).where(eq(prCodeReviewRuns.id, unit.id));
    await waitEnded();

    expect(await unitRow()).toMatchObject({ status: 'cancelled', dispatchedAt: null });
    expect(deleteSandbox).toHaveBeenCalledWith(`talyn-rev-${unit.id}`);
    expect((await events()).map((e) => e.code)).toEqual(['capacity_deferred']);
  });

  it('dispatches a unit with room at once, with no wait and no waiting state', async () => {
    await dispatchUnit((await getReview('rev1'))!, LENS);
    expect(await unitRow()).toMatchObject({ status: 'running', failureCode: null, capacityWaitSince: null });
    expect(await events()).toEqual([]);
    expect(scheduleReviewEvaluation).not.toHaveBeenCalled();
  });

  it('has no per-workspace cap: every unit of a wide review dispatches together', async () => {
    const lenses = ['correctness', 'security', 'reliability', 'tests', 'operability'];
    const review = (await getReview('rev1'))!;
    await Promise.all(lenses.map((lens) => dispatchUnit(review, { kind: 'lens', lens, chunkIndex: 0 })));
    expect(createSandbox).toHaveBeenCalledTimes(lenses.length);
    const rows = await db.select().from(prCodeReviewRuns);
    expect(rows.map((r) => r.status)).toEqual(Array(lenses.length).fill('running'));
  });

  it('shows the banner from when the wait began, while the unit waits', async () => {
    createSandbox.mockRejectedValue(busy());
    Object.assign(FLEET_CAPACITY_WAIT, { maxMs: 400 });
    await dispatchUnit((await getReview('rev1'))!, LENS);
    const unit = await unitRow();
    const shown = await publicReviewById('rev1');
    expect(shown?.deferredSince).toBe(unit.capacityWaitSince!.toISOString());
    await waitEnded();
    expect((await publicReviewById('rev1'))?.deferredSince).toBeNull();
  });
});

describe('the reconciler and a unit that waits for a runner', () => {
  it('leaves a live wait alone: its heartbeat is fresh', async () => {
    await waitingUnit({ updatedAt: new Date() });
    await reapOrphans();
    expect(await unitRow()).toMatchObject({ status: 'claimed', failureCode: 'capacity_deferred' });
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it('resumes a wait whose process died, on the same sandbox id, and runs it', async () => {
    const run = await waitingUnit();
    fleetAnswers('queued');

    await reapOrphans();
    await waitEnded();

    expect(createdIds()).toEqual([run.sandboxId]);
    expect(await getRun(run.id)).toMatchObject({ status: 'running', sandboxId: run.sandboxId, failureCode: null });
    // The wait said so once, when it began. A resume adds nothing.
    expect(await events()).toEqual([]);
  });

  it('resumes a wait with no box yet on the unit’s own id', async () => {
    const run = await waitingUnit({ sandboxId: null });
    await reapOrphans();
    expect(createdIds()).toEqual([`talyn-rev-${run.id}`]);
    expect(await getRun(run.id)).toMatchObject({ status: 'running' });
  });

  it('keeps one bound across a resume: a wait near its end gives up soon after', async () => {
    Object.assign(FLEET_CAPACITY_WAIT, { maxMs: 60_000 });
    const run = await waitingUnit({ capacityWaitSince: new Date(Date.now() - 60_000 + 200) });
    createSandbox.mockRejectedValue(busy());

    await reapOrphans();
    await waitEnded();

    expect(await getRun(run.id)).toMatchObject({ status: 'failed', failureCode: 'capacity_deferred' });
    expect((await events()).map((e) => e.code)).toEqual(['capacity_gave_up']);
  });

  it.each([
    ['past the 30-minute bound', { capacityWaitSince: new Date(Date.now() - 31 * 60_000) }, true],
    ['from before the wait recorded its start', { capacityWaitSince: null }, true],
    ['past the bound, with no box', { capacityWaitSince: new Date(Date.now() - 31 * 60_000), sandboxId: null }, false],
  ])('fails a wait %s, says why, and lets its box go', async (_label, over, hasBox) => {
    Object.assign(FLEET_CAPACITY_WAIT, DEFAULT_WAIT);
    const run = await waitingUnit(over);

    await reapOrphans();

    expect(await getRun(run.id)).toMatchObject({ status: 'failed', failureCode: 'capacity_deferred' });
    expect(await events()).toEqual([{ code: 'capacity_gave_up', message: CAPACITY_GAVE_UP_MESSAGE }]);
    if (hasBox) expect(deleteSandbox).toHaveBeenCalledWith(run.sandboxId);
    else expect(deleteSandbox).not.toHaveBeenCalled();
    expect(createSandbox).not.toHaveBeenCalled();
    expect(scheduleReviewEvaluation).toHaveBeenCalledWith('rev1', 'reconcile:orphan');
  });

  it.each([
    ['claimed', null],
    ['dispatching', null],
  ])('fails a %s unit that never got a sandbox as lost', async (status, failureCode) => {
    const run = await waitingUnit({ status, failureCode, sandboxId: null, capacityWaitSince: null });
    await reapOrphans();
    expect(await getRun(run.id)).toMatchObject({ status: 'failed', failureCode: 'dispatch_lost' });
    expect((await events()).map((e) => e.code)).toEqual(['dispatch_lost']);
  });

  it.each([
    ['cancelled', { phase: 'cancelled' }],
    ['on a new cycle', { cycle: 2 }],
  ])('cancels a lost wait whose review was %s, and lets its box go', async (_label, patch) => {
    await db.update(prCodeReviews).set(patch).where(eq(prCodeReviews.id, 'rev1'));
    const run = await waitingUnit();
    await reapOrphans();
    expect(await getRun(run.id)).toMatchObject({ status: 'cancelled' });
    expect(deleteSandbox).toHaveBeenCalledWith(run.sandboxId);
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it.each([
    ['a wait inside its bound', { capacityWaitSince: new Date(Date.now() - 60_000) }, true],
    ['a wait past its bound', { capacityWaitSince: new Date(Date.now() - 31 * 60_000) }, false],
    ['a wait with no start', { capacityWaitSince: null }, false],
    ['a lost dispatch', { failureCode: null }, false],
    ['a dispatching unit', { status: 'dispatching' }, false],
  ])('isResumableWait: %s → %s', (_label, over, expected) => {
    Object.assign(FLEET_CAPACITY_WAIT, DEFAULT_WAIT);
    const run = {
      status: 'claimed',
      failureCode: 'capacity_deferred',
      capacityWaitSince: new Date(),
      ...over,
    } as RunRow;
    expect(isResumableWait(run)).toBe(expected);
  });
});

describe('a resumed wait and the units it must not lose', () => {
  afterEach(() => {
    delete process.env.POSTHOG_CODE_RETIRED;
    resetFeatureFlagsForTests();
  });

  it.each([
    ['a first dispatch', null, 'capacity_deferred'],
    ['a unit that moved off Codex', 'codex', 'usage_limit'],
  ])('never spills %s to PostHog Code, and fails with its own reason after the bound', async (_label, from, code) => {
    // Spilling is allowed for a fresh unit here, and the fleet is full.
    process.env.POSTHOG_CODE_RETIRED = 'false';
    resetFeatureFlagsForTests();
    chain.mockResolvedValue([
      { provider: 'selfhosted', envId: 'env-fleet' },
      { provider: 'posthog_code', envId: 'env-ph' },
    ]);
    startCodeRun.mockResolvedValue({ ok: true, model: 'm', remoteTaskId: 't', remoteRunId: 'r' });
    createSandbox.mockRejectedValue(busy());
    Object.assign(FLEET_CAPACITY_WAIT, { maxMs: 60_000 });
    const run = await waitingUnit({
      failedOverFrom: from,
      sandboxId: from ? 'talyn-rev-unit-1-r1' : 'talyn-rev-unit-1',
      capacityWaitSince: new Date(Date.now() - 60_000 + 300),
    });

    await reapOrphans();
    await waitEnded();

    expect(startCodeRun).not.toHaveBeenCalled();
    expect(createdIds().every((id) => id === run.sandboxId)).toBe(true);
    expect(await getRun(run.id)).toMatchObject({ status: 'failed', failureCode: code, failedOverFrom: from });
  });

  it('lets the box go when a resumed wait finds no agent connected any more', async () => {
    chain.mockResolvedValue([]);
    const run = await waitingUnit();

    await reapOrphans();

    expect(await getRun(run.id)).toMatchObject({ status: 'failed', failureCode: 'no_provider' });
    expect(deleteSandbox).toHaveBeenCalledWith(run.sandboxId);
    expect(createSandbox).not.toHaveBeenCalled();
  });
});

describe('cancelling a review with a unit that waits for a runner', () => {
  it.each([
    ['a queued box', 'talyn-rev-unit-1', true],
    ['no box yet', null, false],
  ])('deletes %s and cancels the unit', async (_label, sandboxId, deletes) => {
    await waitingUnit({ sandboxId, updatedAt: new Date() });
    await cancelReviewCycle((await getReview('rev1'))!);
    expect((await unitRow()).status).toBe('cancelled');
    if (deletes) expect(deleteSandbox).toHaveBeenCalledWith(sandboxId);
    else expect(deleteSandbox).not.toHaveBeenCalled();
    expect(cancelSandbox).not.toHaveBeenCalled();
  });

  it('still cancels (not deletes) a running unit', async () => {
    await waitingUnit({
      status: 'running',
      provider: 'selfhosted',
      dispatchedAt: new Date(),
      failureCode: null,
      updatedAt: new Date(),
    });
    await cancelReviewCycle((await getReview('rev1'))!);
    expect(cancelSandbox).toHaveBeenCalledWith('talyn-rev-unit-1');
    expect(deleteSandbox).not.toHaveBeenCalled();
  });
});

describe('nextUnitSandboxId', () => {
  it.each([
    ['talyn-rev-u1', 'talyn-rev-u1-r2'],
    ['talyn-rev-u1-r2', 'talyn-rev-u1-r4'],
    // A moved unit starts at -r1 and stays on odd generations.
    ['talyn-rev-u1-r1', 'talyn-rev-u1-r3'],
    ['talyn-rev-u1-r3', 'talyn-rev-u1-r5'],
  ])('%s → %s', (from, to) => {
    expect(nextUnitSandboxId(from)).toBe(to);
  });
});
