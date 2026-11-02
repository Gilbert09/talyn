import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { SANDBOX_SIZES, type SandboxSize } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { integrations, prCodeReviewRuns, prCodeReviews, pullRequests, repositories, workspaces } from '../db/schema.js';

/**
 * The size and idle timeout on the fleet create body, and the meter hooks on
 * the code-review path. A review unit is an unattended run: it boots small,
 * opens one `review_unit` interval, and closes it when the poller sees the box
 * stop. A unit that spills to PostHog Code is not metered.
 */

const { fleet, createSandbox, openInterval, closeInterval, startCodeRun, scheduleReviewEvaluation } = vi.hoisted(() => ({
  fleet: { getSandbox: vi.fn(), getEvents: vi.fn(), cancelRun: vi.fn() },
  createSandbox: vi.fn(),
  openInterval: vi.fn(),
  closeInterval: vi.fn(),
  startCodeRun: vi.fn(),
  scheduleReviewEvaluation: vi.fn(),
}));

vi.mock('../services/billing/usage/index.js', () => ({ openInterval, closeInterval }));
vi.mock('../services/selfHosted/client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/selfHosted/client.js')>('../services/selfHosted/client.js');
  return { ...actual, FleetClient: class { createSandbox = createSandbox; } };
});
vi.mock('../services/selfHosted/credentials.js', async () => {
  const actual = await vi.importActual<typeof import('../services/selfHosted/credentials.js')>('../services/selfHosted/credentials.js');
  return { ...actual, getSelfHostedClient: vi.fn(async () => fleet) };
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
vi.mock('../services/prCloudFix.js', () => ({
  resolveCloudEnvChain: vi.fn(async () => [
    { provider: 'selfhosted', envId: 'env-fleet' },
    { provider: 'posthog_code', envId: 'env-ph' },
  ]),
}));
vi.mock('../services/posthogCode/codeRun.js', () => ({ startCodeRun }));
vi.mock('../services/selfHosted/quotaProbe.js', () => ({ verifyAgentQuota: vi.fn(async () => 'spent') }));
vi.mock('../services/analytics.js', async () => {
  const actual = await vi.importActual<typeof import('../services/analytics.js')>('../services/analytics.js');
  return { ...actual, captureWorkspaceEvent: vi.fn() };
});

const { dispatchSandboxRun } = await import('../services/selfHosted/sandboxRun.js');
const { dispatchUnit } = await import('../services/codeReview/executor.js');
const { codeReviewPoller } = await import('../services/codeReview/poller.js');
const { getReview, getRun } = await import('../services/codeReview/store.js');
const { FleetCapacityError, FleetRunNotFoundError, FleetThrottleError } = await import('../services/selfHosted/client.js');
const { resetUsageHookCacheForTests } = await import('../services/billing/usageHooks.js');
type RunRow = import('../services/codeReview/store.js').RunRow;

const reconcile = (run: RunRow) =>
  (codeReviewPoller as unknown as { reconcileRun(run: RunRow): Promise<void> }).reconcileRun(run);

const LENS = { kind: 'lens' as const, lens: 'correctness', chunkIndex: 0 };
let db: Database;
let cleanup: () => Promise<void>;
let priorTokenKey: string | undefined;

beforeEach(async () => {
  priorTokenKey = process.env.TALYN_TOKEN_KEY;
  process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
  process.env.FLEET_API_TOKEN = 'fleet-token';
  process.env.FLEET_PINNED_ENDPOINT = 'https://fleet.test';
  ({ db, cleanup } = await createTestDb());
  const { encryptString } = await import('../services/tokenCrypto.js');
  vi.clearAllMocks();
  resetUsageHookCacheForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  createSandbox.mockImplementation(async (input: { id: string }) => ({ sandbox: { id: input.id, status: 'running' }, host: 'host-1' }));
  openInterval.mockResolvedValue(undefined);
  closeInterval.mockResolvedValue(undefined);

  await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.com' });
  await db.insert(workspaces).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
  await db.insert(repositories).values({ id: 'repo1', workspaceId: 'ws1', name: 'a/b', url: 'https://github.com/a/b', defaultBranch: 'main' });
  await db.insert(pullRequests).values({
    id: 'pr1', workspaceId: 'ws1', repositoryId: 'repo1', owner: 'a', repo: 'b', number: 1, state: 'open',
    lastSummary: { title: 'T', headSha: 'abc1234', headBranch: 'feat', baseBranch: 'main' },
  });
  await db.insert(prCodeReviews).values({
    id: 'rev1', workspaceId: 'ws1', repositoryId: 'repo1', pullRequestId: 'pr1', cycle: 1, preset: 'standard',
    phase: 'reviewing', lensKeys: ['correctness'], runsTotal: 1, targetHeadSha: 'abc1234',
  });
  await db.insert(integrations).values({
    id: 'int1', workspaceId: 'ws1', type: 'selfhosted', enabled: true, config: { anthropicKeyEnc: encryptString('sk-ant-api-test') },
  });
});

afterEach(async () => {
  // A unit's settle leaves a detached hold-clearing write behind; let it land before the database closes.
  await new Promise((r) => setTimeout(r, 100));
  vi.restoreAllMocks();
  await cleanup();
  if (priorTokenKey === undefined) delete process.env.TALYN_TOKEN_KEY;
  else process.env.TALYN_TOKEN_KEY = priorTokenKey;
  delete process.env.FLEET_API_TOKEN;
  delete process.env.FLEET_PINNED_ENDPOINT;
});

const spec = (size?: SandboxSize) => ({
  runId: 'talyn-run-1',
  workspaceId: 'ws1',
  repositoryId: 'repo1',
  taskType: 'code_writing',
  prompt: 'p',
  systemPrompt: 's',
  ...(size ? { size } : {}),
});

describe('the fleet create body', () => {
  it.each<SandboxSize>(['small', 'standard', 'medium', 'large', 'xlarge'])('asks for a %s box and the idle timeout', async (size) => {
    const result = await dispatchSandboxRun(spec(size));
    expect(result.ok && result.handle.size).toBe(size);
    expect(createSandbox).toHaveBeenCalledTimes(1);
    expect(createSandbox.mock.calls[0][0]).toMatchObject({
      memMib: SANDBOX_SIZES[size].memMib,
      milliVcpu: SANDBOX_SIZES[size].milliVcpu,
      idleTtlSec: 600,
      ephemeral: true,
    });
  });

  it('asks for standard when no size is given', async () => {
    const result = await dispatchSandboxRun(spec());
    expect(result.ok && result.handle.size).toBe('standard');
    expect(createSandbox.mock.calls[0][0]).toMatchObject({ memMib: 4096, milliVcpu: 4000 });
  });

  it.each<SandboxSize>(['medium', 'large', 'xlarge'])('falls back once to standard when the tenant cannot hold %s', async (size) => {
    createSandbox
      .mockRejectedValueOnce(new FleetThrottleError(`tenant_memory: ${SANDBOX_SIZES[size].memMib} MiB requested exceeds the 8192 MiB permitted`))
      .mockImplementation(async (input: { id: string }) => ({ sandbox: { id: input.id, status: 'running' } }));
    const result = await dispatchSandboxRun(spec(size));
    expect(result.ok && result.handle.size).toBe('standard');
    expect(createSandbox.mock.calls.map((c) => c[0].memMib)).toEqual([SANDBOX_SIZES[size].memMib, 4096]);
  });

  it.each<SandboxSize>(['small', 'standard'])('does not fall back from %s', async (size) => {
    createSandbox.mockRejectedValue(new FleetThrottleError('tenant_memory: exceeds the 2048 MiB permitted'));
    const result = await dispatchSandboxRun(spec(size));
    expect(result.ok).toBe(false);
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });
});

describe('the meter on the code-review path', () => {
  it('boots a small box for a unit and opens one review_unit interval', async () => {
    await dispatchUnit((await getReview('rev1'))!, LENS);
    expect(createSandbox).toHaveBeenCalledTimes(1);
    const body = createSandbox.mock.calls[0][0];
    expect(body).toMatchObject({ memMib: 4096, milliVcpu: 2000, idleTtlSec: 600 });
    expect(openInterval).toHaveBeenCalledTimes(1);
    const [unitRow] = await db.select({ id: prCodeReviewRuns.id }).from(prCodeReviewRuns);
    expect(openInterval).toHaveBeenCalledWith({
      ownerId: TEST_USER_ID,
      workspaceId: 'ws1',
      subjectKind: 'review_unit',
      subjectId: unitRow.id,
      sandboxId: body.id,
      size: 'small',
    });
  });

  it('opens nothing for a unit that spills to PostHog Code', async () => {
    createSandbox.mockRejectedValue(new FleetCapacityError('all hosts busy'));
    startCodeRun.mockResolvedValue({ ok: true, model: 'm', remoteTaskId: 't', remoteRunId: 'r' });
    await dispatchUnit((await getReview('rev1'))!, LENS);
    expect(startCodeRun).toHaveBeenCalledTimes(1);
    expect(openInterval).not.toHaveBeenCalled();
  });

  it('a meter failure never fails the dispatch', async () => {
    openInterval.mockRejectedValue(new Error('ledger down'));
    await dispatchUnit((await getReview('rev1'))!, LENS);
    const [unitRow] = await db.select({ id: prCodeReviewRuns.id }).from(prCodeReviewRuns);
    expect((await getRun(unitRow.id))!.status).toBe('running');
  });

  let seq = 0;
  async function runningUnit(over: Partial<typeof prCodeReviewRuns.$inferInsert> = {}): Promise<RunRow> {
    seq += 1;
    const id = `run-${seq}`;
    await db.insert(prCodeReviewRuns).values({
      id, reviewId: 'rev1', workspaceId: 'ws1', cycle: 1, kind: 'lens', lens: 'correctness', chunkIndex: 0,
      status: 'running', provider: 'selfhosted', model: 'claude-sonnet-5', sandboxId: `sb-${id}`, dispatchedAt: new Date(),
      ...over,
    });
    return (await getRun(id))!;
  }

  it.each<[string, Record<string, unknown>, string | null]>([
    ['stopped', { status: 'stopped', endedAt: '2026-11-01T10:00:00Z', tasks: [{ taskId: 't', status: 'completed' }] }, '2026-11-01T10:00:00.000Z'],
    ['failed', { status: 'failed', tasks: [{ taskId: 't', status: 'failed', error: 'boom' }] }, null],
    ['cancelled', { status: 'cancelled' }, null],
  ])('closes a unit whose box %s', async (_label, sandbox, endedAt) => {
    const run = await runningUnit();
    fleet.getSandbox.mockResolvedValue({ sandbox: { id: run.sandboxId, ...sandbox } });
    fleet.getEvents.mockResolvedValue({ events: [] });
    await reconcile(run);
    expect(closeInterval).toHaveBeenCalledTimes(1);
    const [id, at, reason] = closeInterval.mock.calls[0] as [string, Date, string];
    expect([id, reason]).toEqual([run.sandboxId, 'terminal']);
    if (endedAt) expect(at.toISOString()).toBe(endedAt);
  });

  it.each(['starting', 'busy'])('leaves a %s unit metered', async (status) => {
    const run = await runningUnit();
    fleet.getSandbox.mockResolvedValue({ sandbox: { id: run.sandboxId, status } });
    fleet.getEvents.mockResolvedValue({ events: [] });
    await reconcile(run);
    expect(closeInterval).not.toHaveBeenCalled();
  });

  it('closes a unit whose box vanished', async () => {
    const run = await runningUnit();
    fleet.getSandbox.mockRejectedValue(new FleetRunNotFoundError('no such sandbox'));
    await reconcile(run);
    expect(closeInterval).toHaveBeenCalledWith(run.sandboxId, expect.any(Date), 'vanished');
  });

  it('closes a fleet unit the poller gives up on', async () => {
    const run = await runningUnit({ dispatchedAt: new Date(Date.now() - 60 * 60_000) });
    await reconcile(run);
    expect(closeInterval).toHaveBeenCalledWith(run.sandboxId, expect.any(Date), 'vanished');
    expect(fleet.getSandbox).not.toHaveBeenCalled();
  });

  it('closes nothing for an overdue PostHog Code unit', async () => {
    const run = await runningUnit({
      provider: 'posthog_code', sandboxId: null, remoteTaskId: 't', remoteRunId: 'r', dispatchedAt: new Date(Date.now() - 60 * 60_000),
    });
    await reconcile(run);
    expect(closeInterval).not.toHaveBeenCalled();
  });
});
