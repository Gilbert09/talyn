import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { TaskResult, TaskStatus } from '@talyn/shared';

/**
 * The fleet poller's half of CI park: a box dispatched non-ephemeral
 * (`metadata.ciPark`) goes idle when its task ends, and the poller parks it on
 * the await-CI sentinel or finishes it and deletes the box. An ephemeral box
 * is left alone, as before.
 */

const { openInterval, closeInterval, mockClient } = vi.hoisted(() => ({
  openInterval: vi.fn(),
  closeInterval: vi.fn(),
  mockClient: {
    getSandbox: vi.fn(),
    getEvents: vi.fn(),
    setSandboxCredentials: vi.fn(),
    suspendSandbox: vi.fn(),
    deleteSandbox: vi.fn(),
    followEvents: vi.fn(),
  },
}));

vi.mock('../services/billing/usage/index.js', () => ({ openInterval, closeInterval }));
vi.mock('../services/selfHosted/credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/selfHosted/credentials.js')>()),
  getSelfHostedClient: vi.fn(async () => mockClient),
}));
vi.mock('../services/selfHosted/hotSwap.js', () => ({
  findHotSwap: vi.fn(async () => null),
  forgetHotSwapRun: vi.fn(),
  recordHotSwap: vi.fn(),
}));
vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: () => undefined,
}));

const schema = await import('../db/schema.js');
const { createTestDb, seedUser } = await import('./helpers/testDb.js');
const { selfHostedPoller } = await import('../services/selfHosted/poller.js');
const { drainTaskMetadata } = await import('../services/taskMetadataMutex.js');
const { resetUsageHookCacheForTests } = await import('../services/billing/usageHooks.js');
const { MAX_CI_PARKS, RESUME_FAILED_SUMMARY, resetCiParkForTests } = await import('../services/ciPark.js');
type CloudTaskRow = import('../services/cloudProviders/types.js').CloudTaskRow;

const WS = 'ws-park';
const OWNER = 'owner-park';
const RUN = 'talyn-task-park';
const TASK = 'task-park';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const FIRST = `${RUN}-t1`;
const SECOND = `${RUN}-t2`;

let seq = 0;
const marker = (taskId: string) => ({
  seq: ++seq,
  at: '',
  event: { type: 'task_started', taskId, raw: { taskId, taskType: 'pr_response' } },
});
const said = (text: string) => ({
  seq: ++seq,
  at: '',
  event: { type: 'assistant', raw: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } } },
});

describe('CI park in the fleet poller', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    seq = 0;
    resetUsageHookCacheForTests();
    resetCiParkForTests();
    openInterval.mockReset().mockResolvedValue(undefined);
    closeInterval.mockReset().mockResolvedValue(undefined);
    for (const fn of Object.values(mockClient)) fn.mockReset();
    mockClient.suspendSandbox.mockResolvedValue(undefined);
    mockClient.deleteSandbox.mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: OWNER });
    await testDb.db.insert(schema.workspaces).values({ id: WS, ownerId: OWNER, name: 'Park' });
    await testDb.db.insert(schema.repositories).values({ id: 'repo-park', workspaceId: WS, name: 'acme/widgets', url: 'https://github.com/acme/widgets' });
    await testDb.db.insert(schema.pullRequests).values({
      id: 'pr-park', workspaceId: WS, repositoryId: 'repo-park', owner: 'acme', repo: 'widgets', number: 7,
      state: 'open', lastPolledAt: new Date(), lastSummary: { headSha: SHA },
    });
  });

  afterEach(async () => {
    selfHostedPoller.stopStreaming(TASK);
    await drainTaskMetadata(TASK);
    await new Promise((r) => setTimeout(r, 20));
    vi.restoreAllMocks();
    await testDb.cleanup();
  });

  function metadata(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ciPark: true,
      cloudTask: { provider: 'selfhosted', status: 'running', remoteTaskId: RUN, extra: { sandboxSize: 'small' } },
      ...extra,
    };
  }

  async function seed(meta: Record<string, unknown>, status: TaskStatus = 'in_progress') {
    await testDb.db.insert(schema.tasks).values({
      id: TASK, workspaceId: WS, type: 'pr_response', status, title: 'Fix', description: 'd',
      repositoryId: 'repo-park', pullRequestId: 'pr-park', metadata: meta,
    });
  }

  const rowFor = (meta: Record<string, unknown>): CloudTaskRow => ({
    id: TASK, workspaceId: WS, title: 'Fix', repositoryId: 'repo-park', metadata: meta,
    transcriptFinal: false, watched: false, status: 'in_progress', completedAt: null, updatedAt: new Date(),
  });

  function box(tasks: Array<{ taskId: string; status: string }>, fields: Record<string, unknown> = {}) {
    mockClient.getSandbox.mockResolvedValue({
      sandbox: { id: RUN, workspaceId: WS, status: 'idle', ephemeral: false, tasks, ...fields },
      terminal: false,
    });
  }

  function events(list: unknown[]) {
    mockClient.getEvents.mockResolvedValue({ events: list, cursor: seq, terminal: false });
  }

  async function task() {
    await drainTaskMetadata(TASK);
    const [row] = await testDb.db
      .select({ status: schema.tasks.status, result: schema.tasks.result, metadata: schema.tasks.metadata })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, TASK));
    return { status: row.status, result: row.result as TaskResult | null, metadata: row.metadata as Record<string, unknown> };
  }

  it('parks on the sentinel: one suspend, the interval closed as suspended, the task waiting_ci', async () => {
    const meta = metadata();
    await seed(meta);
    box([{ taskId: FIRST, status: 'completed' }]);
    events([marker(FIRST), said(`Pushed the fix.\nTALYN_AWAIT_CI: ${SHA}`)]);

    await selfHostedPoller.reconcileTask(rowFor(meta));

    const t = await task();
    expect(t.status).toBe('waiting_ci');
    expect(t.metadata.awaitCi).toMatchObject({ headSha: SHA, fleetTaskId: FIRST, parks: [expect.any(String)] });
    expect(mockClient.suspendSandbox).toHaveBeenCalledTimes(1);
    expect(mockClient.suspendSandbox).toHaveBeenCalledWith(RUN);
    expect(mockClient.deleteSandbox).not.toHaveBeenCalled();
    expect(closeInterval).toHaveBeenCalledTimes(1);
    expect(closeInterval.mock.calls[0][0]).toBe(RUN);
    expect(closeInterval.mock.calls[0][2]).toBe('suspended');
  });

  it('uses the PR head when the sentinel gives no readable sha', async () => {
    const meta = metadata();
    await seed(meta);
    box([{ taskId: FIRST, status: 'completed' }]);
    events([marker(FIRST), said('Pushed.\nTALYN_AWAIT_CI: HEAD')]);

    await selfHostedPoller.reconcileTask(rowFor(meta));

    expect((await task()).metadata.awaitCi).toMatchObject({ headSha: SHA });
  });

  it.each<[string, () => void, TaskStatus]>([
    ['no sentinel', () => events([marker(FIRST), said('All green, the PR is mergeable.')]), 'completed'],
    ['the needs-human sentinel', () => events([marker(FIRST), said('TALYN_NEEDS_HUMAN: an approval')]), 'needs_human'],
    ['a sentinel in prose only', () => events([marker(FIRST), said(`I would write TALYN_AWAIT_CI: ${SHA}\nbut I am done.`)]), 'completed'],
  ])('finishes and deletes the box on %s', async (_label, arrange, expected) => {
    const meta = metadata();
    await seed(meta);
    box([{ taskId: FIRST, status: 'completed' }]);
    arrange();

    await selfHostedPoller.reconcileTask(rowFor(meta));

    expect((await task()).status).toBe(expected);
    expect(mockClient.suspendSandbox).not.toHaveBeenCalled();
    expect(mockClient.deleteSandbox).toHaveBeenCalledWith(RUN);
    expect(closeInterval.mock.calls.map((c) => c[2])).toContain('deleted');
  });

  it('finishes a failed turn even when its text asks to wait', async () => {
    const meta = metadata();
    await seed(meta);
    box([{ taskId: FIRST, status: 'failed' }]);
    events([marker(FIRST), said(`TALYN_AWAIT_CI: ${SHA}`)]);

    await selfHostedPoller.reconcileTask(rowFor(meta));

    expect((await task()).status).toBe('failed');
    expect(mockClient.deleteSandbox).toHaveBeenCalledWith(RUN);
  });

  it(`finishes on park number ${MAX_CI_PARKS + 1}`, async () => {
    const meta = metadata({
      awaitCi: {
        headSha: 'old', wakeToken: 'w', fleetTaskId: FIRST, parkedAt: '', deadlineAt: '',
        parks: Array.from({ length: MAX_CI_PARKS }, () => new Date().toISOString()),
      },
      cloudTask: { provider: 'selfhosted', status: 'running', remoteTaskId: RUN, extra: { fleetTaskId: SECOND } },
    });
    await seed(meta);
    box([{ taskId: FIRST, status: 'completed' }, { taskId: SECOND, status: 'completed' }]);
    events([marker(FIRST), said(`TALYN_AWAIT_CI: ${SHA}`), marker(SECOND), said(`again\nTALYN_AWAIT_CI: ${SHA}`)]);

    await selfHostedPoller.reconcileTask(rowFor(meta));

    expect((await task()).status).toBe('completed');
    expect(mockClient.suspendSandbox).not.toHaveBeenCalled();
    expect(mockClient.deleteSandbox).toHaveBeenCalledWith(RUN);
  });

  it('does not re-read the previous turn: a resumed turn that says nothing is finished, not parked', async () => {
    const meta = metadata({
      awaitCi: { headSha: SHA, wakeToken: 'w', fleetTaskId: FIRST, parkedAt: '', deadlineAt: '', parks: [new Date().toISOString()] },
      cloudTask: { provider: 'selfhosted', status: 'running', remoteTaskId: RUN, extra: { fleetTaskId: SECOND } },
    });
    await seed(meta);
    box([{ taskId: FIRST, status: 'completed' }, { taskId: SECOND, status: 'completed' }]);
    events([marker(FIRST), said(`Pushed.\nTALYN_AWAIT_CI: ${SHA}`), marker(SECOND)]);

    await selfHostedPoller.reconcileTask(rowFor(meta));

    expect((await task()).status).toBe('completed');
    expect(mockClient.suspendSandbox).not.toHaveBeenCalled();
  });

  it('parks again on a resumed turn that published again', async () => {
    const meta = metadata({
      awaitCi: { headSha: 'aaaaaaa', wakeToken: 'w', fleetTaskId: FIRST, parkedAt: '', deadlineAt: '', parks: [new Date().toISOString()] },
      cloudTask: { provider: 'selfhosted', status: 'running', remoteTaskId: RUN, extra: { fleetTaskId: SECOND } },
    });
    await seed(meta);
    box([{ taskId: FIRST, status: 'completed' }, { taskId: SECOND, status: 'completed' }]);
    events([marker(FIRST), said('TALYN_AWAIT_CI: aaaaaaa'), marker(SECOND), said(`Fixed lint.\nTALYN_AWAIT_CI: ${SHA}`)]);

    await selfHostedPoller.reconcileTask(rowFor(meta));

    const t = await task();
    expect(t.status).toBe('waiting_ci');
    expect(t.metadata.awaitCi).toMatchObject({ headSha: SHA, fleetTaskId: SECOND });
    expect((t.metadata.awaitCi as { parks: string[] }).parks).toHaveLength(2);
    expect((t.metadata.awaitCi as { wakeToken: string }).wakeToken).not.toBe('w');
  });

  it('leaves a wake in flight alone: the latest task is still the parked one', async () => {
    const meta = metadata({
      awaitCi: { headSha: SHA, wakeToken: 'w', fleetTaskId: FIRST, parkedAt: '', deadlineAt: '', parks: ['x'], wakingAt: new Date().toISOString() },
    });
    await seed(meta);
    box([{ taskId: FIRST, status: 'completed' }], { status: 'suspended' });
    events([marker(FIRST), said(`TALYN_AWAIT_CI: ${SHA}`)]);

    await selfHostedPoller.reconcileTask(rowFor(meta));

    expect((await task()).status).toBe('in_progress');
    expect(mockClient.suspendSandbox).not.toHaveBeenCalled();
    expect(mockClient.deleteSandbox).not.toHaveBeenCalled();
  });

  it('finishes a wake that died part-way', async () => {
    const meta = metadata({
      awaitCi: {
        headSha: SHA, wakeToken: 'w', fleetTaskId: FIRST, parkedAt: '', deadlineAt: '', parks: ['x'],
        wakingAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      },
    });
    await seed(meta);
    box([{ taskId: FIRST, status: 'completed' }]);
    events([marker(FIRST), said(`TALYN_AWAIT_CI: ${SHA}`)]);

    await selfHostedPoller.reconcileTask(rowFor(meta));

    const t = await task();
    expect(t.status).toBe('completed');
    expect(t.result?.summary).toBe(RESUME_FAILED_SUMMARY);
    expect(mockClient.deleteSandbox).toHaveBeenCalledWith(RUN);
  });

  it.each([
    ['closed', 'closed'],
    ['merged', 'merged'],
  ])('does not park when the PR is %s', async (_label, state) => {
    await testDb.db.update(schema.pullRequests).set({ state }).where(eq(schema.pullRequests.id, 'pr-park'));
    const meta = metadata();
    await seed(meta);
    box([{ taskId: FIRST, status: 'completed' }]);
    events([marker(FIRST), said(`TALYN_AWAIT_CI: ${SHA}`)]);

    await selfHostedPoller.reconcileTask(rowFor(meta));

    expect((await task()).status).toBe('completed');
    expect(mockClient.suspendSandbox).not.toHaveBeenCalled();
  });

  it('parks even when the suspend is refused: the idle timeout suspends the box', async () => {
    const meta = metadata();
    await seed(meta);
    mockClient.suspendSandbox.mockRejectedValue(new Error('suspend_failed'));
    box([{ taskId: FIRST, status: 'completed' }]);
    events([marker(FIRST), said(`TALYN_AWAIT_CI: ${SHA}`)]);

    await selfHostedPoller.reconcileTask(rowFor(meta));

    expect((await task()).status).toBe('waiting_ci');
    // The meter sweep closes it when the fleet reports the box suspended.
    expect(closeInterval).not.toHaveBeenCalled();
  });

  it.each([
    ['an ephemeral box', { ciPark: undefined }, { ephemeral: true }],
    ['a task with no ci-park stamp', { ciPark: undefined }, { ephemeral: false }],
  ])('leaves %s alone, as before', async (_label, extraMeta, fields) => {
    const meta = { ...metadata(), ...extraMeta };
    await seed(meta);
    box([{ taskId: FIRST, status: 'completed' }], fields);
    events([marker(FIRST), said(`TALYN_AWAIT_CI: ${SHA}`)]);

    await selfHostedPoller.reconcileTask(rowFor(meta));

    expect((await task()).status).toBe('in_progress');
    expect(mockClient.suspendSandbox).not.toHaveBeenCalled();
    expect(mockClient.deleteSandbox).not.toHaveBeenCalled();
  });

  it('leaves a running turn alone', async () => {
    const meta = metadata();
    await seed(meta);
    box([{ taskId: FIRST, status: 'running' }], { status: 'busy' });
    events([marker(FIRST)]);

    await selfHostedPoller.reconcileTask(rowFor(meta));

    expect((await task()).status).toBe('in_progress');
    expect(mockClient.suspendSandbox).not.toHaveBeenCalled();
  });
});
