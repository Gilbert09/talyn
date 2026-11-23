import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment, SandboxSize, Task, TaskStatus } from '@talyn/shared';

/**
 * The meter hooks on the task path: dispatch opens an interval at the box's
 * size, and the poller closes it when the fleet says the box stopped, was
 * suspended or is gone. Unattended runs get the small box.
 */

const { openInterval, closeInterval, dispatchSandboxRun, sizeForSession, mockClient } = vi.hoisted(() => ({
  openInterval: vi.fn(),
  closeInterval: vi.fn(),
  dispatchSandboxRun: vi.fn(),
  sizeForSession: vi.fn(),
  mockClient: { getSandbox: vi.fn(), getEvents: vi.fn(), setSandboxCredentials: vi.fn() },
}));

vi.mock('../services/billing/usage/index.js', () => ({ openInterval, closeInterval }));
vi.mock('../services/selfHosted/sandboxRun.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/selfHosted/sandboxRun.js')>()),
  dispatchSandboxRun,
}));
vi.mock('../services/workbenches/sandboxSize.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/workbenches/sandboxSize.js')>()),
  sizeForSession,
}));
vi.mock('../services/selfHosted/credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/selfHosted/credentials.js')>()),
  getSelfHostedClient: vi.fn(async () => mockClient),
}));
vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: () => undefined,
}));

const schema = await import('../db/schema.js');
const { createTestDb, seedUser } = await import('./helpers/testDb.js');
const { dispatchTaskToFleet, isUnattendedTask, taskSandboxSize } = await import('../services/selfHosted/executor.js');
const { selfHostedPoller } = await import('../services/selfHosted/poller.js');
const { FleetRunNotFoundError } = await import('../services/selfHosted/client.js');
const { drainTaskMetadata } = await import('../services/taskMetadataMutex.js');
const { _resetTaskWatch } = await import('../services/cloudProviders/taskWatch.js');
const { resetUsageHookCacheForTests } = await import('../services/billing/usageHooks.js');
type CloudTaskRow = import('../services/cloudProviders/types.js').CloudTaskRow;

const WS = 'ws-meter';
const OWNER = 'owner-meter';
const ENV = { id: 'env-fleet', name: 'Talyn Fleet', type: 'selfhosted', status: 'connected', config: { type: 'selfhosted' } } as unknown as Environment;

function task(id: string, metadata: Record<string, unknown>): Task {
  return {
    id,
    workspaceId: WS,
    type: 'pr_response',
    status: 'queued',
    priority: 'medium',
    title: 'Fix CI',
    description: 'd',
    prompt: 'fix it',
    repositoryId: 'repo-meter',
    metadata,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Task;
}

function handle(size: SandboxSize, sandboxId = 'talyn-task-1') {
  return {
    ok: true,
    handle: {
      sandbox: { id: sandboxId, status: 'starting' },
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      endpoint: 'https://fleet.test',
      host: 'host-0',
      repoSlug: 'a/b',
      baseBranch: 'main',
      quotaSwap: null,
      size,
    },
  };
}

describe('task sandbox size', () => {
  it.each<[string, Record<string, unknown>, SandboxSize]>([
    ['a loop', { source: 'loop' }, 'small'],
    ['the merge queue', { source: 'merge_queue' }, 'small'],
    ['auto-keep', { source: 'auto_keep' }, 'small'],
    ['a workflow', { source: 'workflow' }, 'small'],
    ['a review fix', { source: 'code_review' }, 'small'],
    ['an unattended flag', { source: 'user', unattended: true }, 'small'],
    ['a person, at the repository size', { source: 'user' }, 'large'],
    ['no source, at the repository size', {}, 'large'],
    ['a chosen size over an unattended source', { source: 'loop', sandboxSize: 'medium' }, 'medium'],
    ['a chosen size over the repository', { source: 'user', sandboxSize: 'standard' }, 'standard'],
    ['an unknown chosen size, ignored', { source: 'loop', sandboxSize: 'huge' }, 'small'],
  ])('%s gets %s', async (_label, metadata, expected) => {
    sizeForSession.mockResolvedValue('large');
    expect(await taskSandboxSize(task('t', metadata))).toBe(expected);
  });

  it.each<[Record<string, unknown>, boolean]>([
    [{ source: 'user' }, false],
    [{}, false],
    [{ unattended: 'yes' }, false],
    [{ unattended: true }, true],
    [{ source: 'merge_queue' }, true],
  ])('isUnattendedTask(%j) is %s', (metadata, expected) => {
    expect(isUnattendedTask({ metadata } as never)).toBe(expected);
  });
});

describe('the meter on the fleet task path', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    resetUsageHookCacheForTests();
    _resetTaskWatch();
    openInterval.mockReset().mockResolvedValue(undefined);
    closeInterval.mockReset().mockResolvedValue(undefined);
    dispatchSandboxRun.mockReset();
    sizeForSession.mockReset().mockResolvedValue('standard');
    mockClient.getSandbox.mockReset();
    mockClient.getEvents.mockReset().mockResolvedValue({ events: [], cursor: 0, terminal: false });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: OWNER });
    await testDb.db.insert(schema.workspaces).values({ id: WS, ownerId: OWNER, name: 'Meter' });
    await testDb.db.insert(schema.repositories).values({ id: 'repo-meter', workspaceId: WS, name: 'a/b', url: 'https://github.com/a/b' });
    await testDb.db.insert(schema.environments).values({
      id: ENV.id, ownerId: OWNER, name: 'Talyn Fleet', type: 'selfhosted', status: 'connected', config: { type: 'selfhosted' },
    });
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 30));
    vi.restoreAllMocks();
    await testDb.cleanup();
  });

  async function seedTask(id: string, values: Partial<typeof schema.tasks.$inferInsert> = {}): Promise<void> {
    await testDb.db.insert(schema.tasks).values({
      id,
      workspaceId: WS,
      type: 'pr_response',
      status: 'queued',
      title: 'Fix CI',
      description: 'd',
      repositoryId: 'repo-meter',
      ...values,
    });
  }

  describe('dispatch', () => {
    it.each<[string, Record<string, unknown>, SandboxSize]>([
      ['a merge-queue fix', { source: 'merge_queue' }, 'small'],
      ['a loop firing', { source: 'loop' }, 'small'],
      ['a workflow action', { source: 'workflow' }, 'small'],
      ['an auto-keep fix', { source: 'auto_keep' }, 'small'],
      ['a review fix', { source: 'code_review' }, 'small'],
      ['a person, at the repository size', { source: 'user' }, 'standard'],
      ['a quota-failover re-dispatch keeps the size', { source: 'loop', runAttempt: 1, quotaFailover: { tried: ['claude'] } }, 'small'],
    ])('%s boots a %s box and opens one task interval at that size', async (_label, metadata, size) => {
      await seedTask('task-1', { metadata });
      dispatchSandboxRun.mockResolvedValue(handle(size));
      const result = await dispatchTaskToFleet(task('task-1', metadata), ENV);
      await drainTaskMetadata('task-1');
      expect(result).toEqual({ ok: true });
      expect(dispatchSandboxRun.mock.calls[0][0]).toMatchObject({ size });
      expect(openInterval).toHaveBeenCalledTimes(1);
      expect(openInterval).toHaveBeenCalledWith({
        ownerId: OWNER,
        workspaceId: WS,
        subjectKind: 'task',
        subjectId: 'task-1',
        sandboxId: 'talyn-task-1',
        size,
      });
      const [row] = await testDb.db.select({ metadata: schema.tasks.metadata }).from(schema.tasks);
      expect((row.metadata as { cloudTask: { extra: Record<string, unknown> } }).cloudTask.extra.sandboxSize).toBe(size);
    });

    it.each<[string, Record<string, unknown>, boolean]>([
      ['a run with no ci-park stamp', { source: 'user' }, false],
      ['a stamp that is not strictly true', { source: 'user', ciPark: 'yes' }, false],
      ['a run stamped for ci-park', { source: 'user', ciPark: true }, true],
    ])('%s: keeps its box and gets the CI WAITING rule only when stamped', async (_label, metadata, parked) => {
      await seedTask('task-1', { metadata });
      dispatchSandboxRun.mockResolvedValue(handle('standard'));
      await dispatchTaskToFleet(task('task-1', metadata), ENV);
      await drainTaskMetadata('task-1');
      const spec = dispatchSandboxRun.mock.calls[0][0] as { ephemeral?: boolean; prompt: string };
      if (parked) {
        expect(spec.ephemeral).toBe(false);
        expect(spec.prompt.startsWith('fix it')).toBe(true);
        expect(spec.prompt).toContain('TALYN_AWAIT_CI:');
      } else {
        // Byte-identical to the dispatch before ci-park existed.
        expect('ephemeral' in spec).toBe(false);
        expect(spec.prompt).toBe('fix it');
      }
    });

    it('records the size the fleet actually gave after a fallback', async () => {
      await seedTask('task-1', { metadata: { source: 'user' } });
      sizeForSession.mockResolvedValue('large');
      dispatchSandboxRun.mockResolvedValue(handle('standard'));
      await dispatchTaskToFleet(task('task-1', { source: 'user' }), ENV);
      await drainTaskMetadata('task-1');
      expect(dispatchSandboxRun.mock.calls[0][0]).toMatchObject({ size: 'large' });
      expect(openInterval.mock.calls[0][0]).toMatchObject({ size: 'standard' });
    });

    it.each<[string, () => void]>([
      ['the ledger throws', () => openInterval.mockRejectedValue(new Error('ledger down'))],
      ['the ledger hangs up', () => openInterval.mockImplementation(async () => { throw new TypeError('fetch failed'); })],
    ])('a meter failure never fails the dispatch: %s', async (_label, arrange) => {
      arrange();
      await seedTask('task-1', { metadata: { source: 'loop' } });
      dispatchSandboxRun.mockResolvedValue(handle('small'));
      const result = await dispatchTaskToFleet(task('task-1', { source: 'loop' }), ENV);
      await drainTaskMetadata('task-1');
      expect(result).toEqual({ ok: true });
      const [row] = await testDb.db.select({ status: schema.tasks.status }).from(schema.tasks);
      expect(row.status).toBe('in_progress');
    });

    it.each([
      ['a refusal', { ok: false, error: 'no credential' }],
      ['a full fleet', { ok: false, error: 'busy', capacity: true }],
    ])('opens nothing after %s: no box was booted', async (_label, answer) => {
      await seedTask('task-1', { metadata: { source: 'user' } });
      dispatchSandboxRun.mockResolvedValue(answer);
      await dispatchTaskToFleet(task('task-1', { source: 'user' }), ENV);
      expect(openInterval).not.toHaveBeenCalled();
    });
  });

  describe('the poller', () => {
    const RUN = 'talyn-task-2';
    const meta = (status = 'running', extra: Record<string, unknown> = { sandboxSize: 'small' }) => ({
      source: 'loop',
      cloudTask: { provider: 'selfhosted', status, remoteTaskId: RUN, extra },
    });
    const rowFor = (status: TaskStatus = 'in_progress', metadata: Record<string, unknown> = meta()): CloudTaskRow => ({
      id: 'task-2',
      workspaceId: WS,
      title: 'Fix CI',
      repositoryId: null,
      metadata,
      transcriptFinal: false,
      watched: false,
      status,
      completedAt: null,
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
    const sandbox = (fields: Record<string, unknown>) => ({ sandbox: { id: RUN, workspaceId: WS, ...fields }, terminal: false });

    beforeEach(async () => {
      await seedTask('task-2', { status: 'in_progress', metadata: meta() });
    });

    afterEach(async () => {
      selfHostedPoller.stopStreaming('task-2');
      await drainTaskMetadata('task-2');
    });

    it.each(['starting', 'idle', 'busy'])('leaves a %s box alone: dispatch opened it', async (status) => {
      mockClient.getSandbox.mockResolvedValue(sandbox({ status }));
      await selfHostedPoller.reconcileTask(rowFor());
      expect(openInterval).not.toHaveBeenCalled();
      expect(closeInterval).not.toHaveBeenCalled();
    });

    it.each<[string, Record<string, unknown>, string | null]>([
      ['stopped with an end time', { status: 'stopped', endedAt: '2026-11-01T10:05:00Z', tasks: [{ taskId: 'x', status: 'completed' }] }, '2026-11-01T10:05:00.000Z'],
      ['failed with a zero end time', { status: 'failed', endedAt: '0001-01-01T00:00:00Z' }, null],
      ['cancelled with no end time', { status: 'cancelled' }, null],
    ])('closes a box that %s as terminal', async (_label, fields, endedAt) => {
      const before = Date.now();
      mockClient.getSandbox.mockResolvedValue(sandbox(fields));
      await selfHostedPoller.reconcileTask(rowFor());
      expect(closeInterval).toHaveBeenCalledTimes(1);
      const [id, at, reason] = closeInterval.mock.calls[0] as [string, Date, string];
      expect([id, reason]).toEqual([RUN, 'terminal']);
      if (endedAt) expect(at.toISOString()).toBe(endedAt);
      else expect(at.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('closes a suspended box at its suspend time, once, and reopens it at its size when it wakes', async () => {
      mockClient.getSandbox.mockResolvedValue(sandbox({ status: 'suspended', suspendedAt: '2026-11-01T10:10:00Z' }));
      await selfHostedPoller.reconcileTask(rowFor());
      await selfHostedPoller.reconcileTask(rowFor());
      expect(closeInterval).toHaveBeenCalledTimes(1);
      expect(closeInterval.mock.calls[0]).toEqual([RUN, new Date('2026-11-01T10:10:00Z'), 'suspended']);

      mockClient.getSandbox.mockResolvedValue(sandbox({ status: 'busy' }));
      await selfHostedPoller.reconcileTask(rowFor());
      await selfHostedPoller.reconcileTask(rowFor());
      expect(openInterval).toHaveBeenCalledTimes(1);
      expect(openInterval.mock.calls[0][0]).toMatchObject({ subjectKind: 'task', subjectId: 'task-2', sandboxId: RUN, size: 'small' });
    });

    it('reopens at the size the fleet reports when dispatch recorded none', async () => {
      const metadata = meta('running', {});
      mockClient.getSandbox.mockResolvedValue(sandbox({ status: 'suspended' }));
      await selfHostedPoller.reconcileTask(rowFor('in_progress', metadata));
      mockClient.getSandbox.mockResolvedValue(sandbox({ status: 'idle', memMib: 8192, milliVcpu: 4000 }));
      await selfHostedPoller.reconcileTask(rowFor('in_progress', metadata));
      expect(openInterval.mock.calls[0][0]).toMatchObject({ size: 'medium' });
    });

    it('closes a vanished box', async () => {
      mockClient.getSandbox.mockRejectedValue(new FleetRunNotFoundError('no such sandbox'));
      await selfHostedPoller.reconcileTask(rowFor());
      expect(closeInterval).toHaveBeenCalledWith(RUN, expect.any(Date), 'vanished');
    });

    it('closes the box of a task that ended without the poller seeing it stop, once', async () => {
      await selfHostedPoller.reconcileTask(rowFor('cancelled'));
      await selfHostedPoller.reconcileTask(rowFor('cancelled'));
      expect(mockClient.getSandbox).not.toHaveBeenCalled();
      expect(closeInterval).toHaveBeenCalledTimes(1);
      expect(closeInterval.mock.calls[0][0]).toBe(RUN);
      expect(closeInterval.mock.calls[0][2]).toBe('terminal');
    });

    it('does not close again for a finished task whose box the poller saw stop', async () => {
      await selfHostedPoller.reconcileTask(rowFor('completed', meta('completed')));
      expect(closeInterval).not.toHaveBeenCalled();
    });

    it('closes the derived box of a task whose dispatch never recorded it', async () => {
      await testDb.db.delete(schema.tasks);
      await seedTask('task-3', { status: 'in_progress', metadata: { source: 'loop', runAttempt: 2, cloudTask: { provider: 'selfhosted' } } });
      await selfHostedPoller.reconcileTask({
        ...rowFor(),
        id: 'task-3',
        metadata: { source: 'loop', runAttempt: 2, cloudTask: { provider: 'selfhosted' } },
      });
      await drainTaskMetadata('task-3');
      expect(closeInterval).toHaveBeenCalledWith('talyn-task-3-r2', expect.any(Date), 'vanished');
    });

    it('a meter failure never fails the poll', async () => {
      closeInterval.mockRejectedValue(new Error('ledger down'));
      mockClient.getSandbox.mockResolvedValue(sandbox({ status: 'stopped', tasks: [{ taskId: 'x', status: 'completed' }] }));
      await expect(selfHostedPoller.reconcileTask(rowFor())).resolves.toBeUndefined();
      await drainTaskMetadata('task-2');
      const [row] = await testDb.db.select({ status: schema.tasks.status }).from(schema.tasks);
      expect(row.status).toBe('completed');
    });
  });
});
