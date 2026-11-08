import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import {
  memoryReviewCadenceOf,
  memoryReviewPeriodStart,
  memoryReviewPrompt,
  nextMemoryReviewPeriodStart,
  type MemoryReviewCadence,
} from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { memoryReviewRuns, workspaceMemories, workspaces } from '../db/schema.js';

/**
 * Memory review: the period arithmetic, the sweep that starts a review thread
 * once per period, and the routes behind Settings → Memory.
 */

const createWorkbench = vi.fn();
const fleetAgentStatus = vi.fn();
const requestArchiveAfterTurn = vi.fn();

vi.mock('../services/workbenches/create.js', async (original) => ({
  ...(await original<typeof import('../services/workbenches/create.js')>()),
  createWorkbench: (...args: unknown[]) => createWorkbench(...args),
}));
vi.mock('../services/selfHosted/credentials.js', async (original) => ({
  ...(await original<typeof import('../services/selfHosted/credentials.js')>()),
  fleetAgentStatus: (...args: unknown[]) => fleetAgentStatus(...args),
}));
vi.mock('../services/workbenches/autoArchive.js', async (original) => ({
  ...(await original<typeof import('../services/workbenches/autoArchive.js')>()),
  requestArchiveAfterTurn: (...args: unknown[]) => requestArchiveAfterTurn(...args),
}));

const { workbenchRoutes } = await import('../routes/workbenches.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { insertChat, insertWorkbench } = await import('../services/workbenches/store.js');
const { runMemoryReviewSweep, startMemoryReview, sweepMemoryReviewWorkspace } = await import(
  '../services/workbenches/memoryReview.js'
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const at = (iso: string) => new Date(iso);

describe('memory review periods', () => {
  it.each<[MemoryReviewCadence, string, string | null, string | null]>([
    ['daily', '2026-11-08T17:30:00Z', '2026-11-08T00:00:00.000Z', '2026-11-09T00:00:00.000Z'],
    ['daily', '2026-12-31T23:59:59Z', '2026-12-31T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
    // 2026-11-08 is a Sunday: its ISO week started on Monday 2026-11-02.
    ['weekly', '2026-11-08T17:30:00Z', '2026-11-02T00:00:00.000Z', '2026-11-09T00:00:00.000Z'],
    ['weekly', '2026-11-09T00:00:00Z', '2026-11-09T00:00:00.000Z', '2026-11-16T00:00:00.000Z'],
    ['weekly', '2027-01-01T12:00:00Z', '2026-12-28T00:00:00.000Z', '2027-01-04T00:00:00.000Z'],
    ['monthly', '2026-11-08T17:30:00Z', '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'],
    ['monthly', '2026-12-15T00:00:00Z', '2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
    ['off', '2026-11-08T17:30:00Z', null, null],
  ])('%s at %s starts its period at %s', (cadence, now, start, next) => {
    expect(memoryReviewPeriodStart(cadence, at(now))?.toISOString() ?? null).toBe(start);
    expect(nextMemoryReviewPeriodStart(cadence, at(now))?.toISOString() ?? null).toBe(next);
  });

  it.each([
    [undefined, 'off'],
    [null, 'off'],
    [{}, 'off'],
    [{ memoryReview: 'weekly' }, 'weekly'],
    [{ memoryReview: 'hourly' }, 'off'],
    [{ memoryReview: true }, 'off'],
  ])('reads the cadence of %j as %s', (settings, cadence) => {
    expect(memoryReviewCadenceOf(settings as Loose)).toBe(cadence);
  });

  it('tells the review to keep scopes and not to start sessions', () => {
    const prompt = memoryReviewPrompt();
    expect(prompt).toContain('talyn_memory_list');
    expect(prompt).toContain('repository_id');
    expect(prompt).toContain('thread_id');
    expect(prompt).toContain('Do not start sessions');
  });
});

describe('memory review sweep and routes', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;
  let threads = 0;

  const WEEK1 = at('2026-11-04T10:00:00Z');
  const WEEK1_LATER = at('2026-11-06T10:00:00Z');
  const WEEK2 = at('2026-11-11T10:00:00Z');

  async function call(method: string, url: string, body?: unknown, user = 'owner-a') {
    const resp = await fetch(`${base}${url}`, {
      method,
      headers: { 'x-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: resp.status, body: (await resp.json()) as { success: boolean; data?: Loose; error?: string; code?: string } };
  }

  async function setSettings(settings: Record<string, unknown>, workspaceId = 'ws-a') {
    await testDb.db.update(workspaces).set({ settings: settings as Loose }).where(eq(workspaces.id, workspaceId));
  }

  async function addMemory(name: string, opts: { updatedAt?: Date; source?: Loose; workspaceId?: string } = {}) {
    const when = opts.updatedAt ?? at('2026-10-01T00:00:00Z');
    await testDb.db.insert(workspaceMemories).values({
      id: `m-${name}`,
      workspaceId: opts.workspaceId ?? 'ws-a',
      ownerId: 'owner-a',
      scope: 'workspace',
      type: 'project',
      name,
      description: `About ${name}`,
      body: `The ${name} note.`,
      bytes: 10,
      source: opts.source ?? { kind: 'user' },
      createdAt: when,
      updatedAt: when,
    });
  }

  const runRows = () => testDb.db.select().from(memoryReviewRuns).orderBy(memoryReviewRuns.createdAt);
  const settingsOf = async (workspaceId = 'ws-a') =>
    (await testDb.db.select({ s: workspaces.settings }).from(workspaces).where(eq(workspaces.id, workspaceId)))[0].s as Loose;

  beforeEach(async () => {
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    vi.stubEnv('MEMORY_REVIEW_ENABLED', 'true');
    resetFeatureFlagsForTests();
    threads = 0;
    fleetAgentStatus.mockResolvedValue({ connectedAgents: ['claude'], reauthAgents: [] });
    requestArchiveAfterTurn.mockResolvedValue('archived');
    createWorkbench.mockImplementation(async (body: Loose) => {
      const id = `thread-${++threads}`;
      await insertWorkbench({
        id, workspaceId: body.workspaceId, kind: 'thread', repositoryId: null, repoFullName: '', name: id,
        branch: '', baseBranch: '', runtime: 'sandbox', agent: body.agent, status: 'ready', source: body.source,
      } as Loose);
      return { id };
    });
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A', settings: { memoryReview: 'weekly' } as Loose },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const id = req.headers['x-user'] as string;
      req.user = { id, email: `${id}@example.test`, isAdmin: false };
      next();
    });
    app.use('/workbenches', wrapAsyncRoutes(workbenchRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await testDb.cleanup();
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
    vi.clearAllMocks();
  });

  describe('sweep', () => {
    it('starts one review thread for a due period', async () => {
      await addMemory('build');
      await addMemory('deploy');
      const result = await sweepMemoryReviewWorkspace('ws-a', await settingsOf(), WEEK1);
      expect(result).toMatchObject({ started: { status: 'started', trigger: 'schedule', workbenchId: 'thread-1' } });
      expect(createWorkbench).toHaveBeenCalledTimes(1);
      const [body, owner] = createWorkbench.mock.calls[0];
      expect(body).toMatchObject({
        workspaceId: 'ws-a', kind: 'thread', runtime: 'sandbox', agent: 'claude',
        namingText: 'Memory review', prompt: memoryReviewPrompt(),
        source: { kind: 'memory_review' },
      });
      expect(body.source.runId).toBe((await runRows())[0].id);
      expect(owner).toMatchObject({ id: 'owner-a' });
      const [row] = await runRows();
      expect(row.periodStart.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    });

    it('runs once per period', async () => {
      await addMemory('build');
      await addMemory('deploy');
      await sweepMemoryReviewWorkspace('ws-a', await settingsOf(), WEEK1);
      await addMemory('later', { updatedAt: at('2026-11-05T00:00:00Z') });
      expect(await sweepMemoryReviewWorkspace('ws-a', await settingsOf(), WEEK1_LATER)).toEqual({ skipped: 'already_ran' });
      expect(createWorkbench).toHaveBeenCalledTimes(1);
    });

    it('starts only one thread when two sweeps race for a period', async () => {
      await addMemory('build');
      await addMemory('deploy');
      const settings = await settingsOf();
      const results = await Promise.all([
        sweepMemoryReviewWorkspace('ws-a', settings, WEEK1),
        sweepMemoryReviewWorkspace('ws-a', settings, WEEK1),
      ]);
      expect(results.filter((r) => 'started' in r)).toHaveLength(1);
      expect(createWorkbench).toHaveBeenCalledTimes(1);
      expect(await runRows()).toHaveLength(1);
    });

    it.each([
      ['the cadence is off', { memoryReview: 'off' }, 'cadence_off'],
      ['the cadence is unset', {}, 'cadence_off'],
      ['session memory is off', { memoryReview: 'weekly', sessionMemory: false }, 'memory_off'],
    ])('skips when %s', async (_label, settings, skipped) => {
      await addMemory('build');
      await addMemory('deploy');
      expect(await sweepMemoryReviewWorkspace('ws-a', settings as Loose, WEEK1)).toEqual({ skipped });
      expect(createWorkbench).not.toHaveBeenCalled();
      expect(await runRows()).toHaveLength(0);
    });

    it('skips when the flag is off for the owner', async () => {
      vi.stubEnv('MEMORY_REVIEW_ENABLED', 'false');
      resetFeatureFlagsForTests();
      await addMemory('build');
      await addMemory('deploy');
      expect(await sweepMemoryReviewWorkspace('ws-a', await settingsOf(), WEEK1)).toEqual({ skipped: 'flag_off' });
      expect(createWorkbench).not.toHaveBeenCalled();
    });

    it.each([
      ['no entries', [] as string[]],
      ['one entry', ['build']],
    ])('skips with %s', async (_label, names) => {
      for (const name of names) await addMemory(name);
      expect(await sweepMemoryReviewWorkspace('ws-a', await settingsOf(), WEEK1)).toEqual({ skipped: 'too_few_entries' });
    });

    it('does not count forgotten entries', async () => {
      await addMemory('build');
      await addMemory('deploy');
      await testDb.db.update(workspaceMemories).set({ forgottenAt: new Date() }).where(eq(workspaceMemories.id, 'm-deploy'));
      expect(await sweepMemoryReviewWorkspace('ws-a', await settingsOf(), WEEK1)).toEqual({ skipped: 'too_few_entries' });
    });

    it('skips the next period when nothing changed since the last review', async () => {
      await addMemory('build');
      await addMemory('deploy');
      await sweepMemoryReviewWorkspace('ws-a', await settingsOf(), WEEK1);
      expect(await sweepMemoryReviewWorkspace('ws-a', await settingsOf(), WEEK2)).toEqual({ skipped: 'unchanged' });
    });

    it('does not count the changes that the review thread made', async () => {
      await addMemory('build');
      await addMemory('deploy');
      const first = await startMemoryReview('ws-a', { trigger: 'schedule', periodStart: at('2026-11-02T00:00:00Z') });
      await addMemory('merged', { updatedAt: new Date(Date.now() + 1000), source: { kind: 'session', workbenchId: first!.workbenchId } });
      expect(await sweepMemoryReviewWorkspace('ws-a', await settingsOf(), WEEK2)).toEqual({ skipped: 'unchanged' });
    });

    it('starts the next review after a change and archives the previous thread', async () => {
      await addMemory('build');
      await addMemory('deploy');
      const first = await startMemoryReview('ws-a', { trigger: 'schedule', periodStart: at('2026-11-02T00:00:00Z') });
      await addMemory('new fact', { updatedAt: new Date(Date.now() + 1000), source: { kind: 'session', workbenchId: 'other' } });
      const result = await sweepMemoryReviewWorkspace('ws-a', await settingsOf(), WEEK2);
      expect(result).toMatchObject({ started: { workbenchId: 'thread-2' } });
      expect(requestArchiveAfterTurn).toHaveBeenCalledWith(first!.workbenchId);
    });

    it.each([
      ['a turn runs', { status: 'running' }],
      ['a message waits for the box', { queuedMessages: [{ id: 'q', text: 'hi', queuedAt: '2026-11-04T00:00:00Z' }] }],
    ])('skips while the previous review works: %s', async (_label, chat) => {
      await addMemory('build');
      await addMemory('deploy');
      const first = await startMemoryReview('ws-a', { trigger: 'schedule', periodStart: at('2026-11-02T00:00:00Z') });
      await insertChat({
        id: 'chat-1', workbenchId: first!.workbenchId!, workspaceId: 'ws-a', title: 'Memory review',
        agent: 'claude', model: null, ...chat,
      } as Loose);
      await addMemory('new fact', { updatedAt: new Date(Date.now() + 1000) });
      expect(await sweepMemoryReviewWorkspace('ws-a', await settingsOf(), WEEK2)).toEqual({ skipped: 'running' });
    });

    it('keeps the reason when the thread cannot start', async () => {
      fleetAgentStatus.mockResolvedValue({ connectedAgents: [], reauthAgents: [] });
      await addMemory('build');
      await addMemory('deploy');
      const result = await sweepMemoryReviewWorkspace('ws-a', await settingsOf(), WEEK1);
      expect(result).toMatchObject({ started: { status: 'failed', workbenchId: null } });
      expect((result as Loose).started.error).toMatch(/no Claude or Codex subscription/);
      expect(createWorkbench).not.toHaveBeenCalled();
    });

    it('falls back to a connected agent when the workspace model needs another', async () => {
      await setSettings({ memoryReview: 'weekly', fleetModel: 'gpt-6-astra' });
      await addMemory('build');
      await addMemory('deploy');
      await sweepMemoryReviewWorkspace('ws-a', await settingsOf(), WEEK1);
      expect(createWorkbench.mock.calls[0][0].agent).toBe('claude');
    });

    it('uses the agent of the workspace model when it is connected', async () => {
      fleetAgentStatus.mockResolvedValue({ connectedAgents: ['claude', 'codex'], reauthAgents: [] });
      await setSettings({ memoryReview: 'weekly', fleetModel: 'gpt-6-astra' });
      await addMemory('build');
      await addMemory('deploy');
      await sweepMemoryReviewWorkspace('ws-a', await settingsOf(), WEEK1);
      expect(createWorkbench.mock.calls[0][0]).toMatchObject({ agent: 'codex', model: 'gpt-6-astra' });
    });

    it('sweeps only the workspaces that set a cadence', async () => {
      await addMemory('build');
      await addMemory('deploy');
      await addMemory('b1', { workspaceId: 'ws-b' });
      await addMemory('b2', { workspaceId: 'ws-b' });
      const outcome = await runMemoryReviewSweep(WEEK1);
      expect(outcome).toEqual({ started: 1, skipped: 0 });
      expect(createWorkbench.mock.calls.map((c) => c[0].workspaceId)).toEqual(['ws-a']);
    });
  });

  describe('routes', () => {
    it('answers the cadence and the recent runs', async () => {
      await addMemory('build');
      await addMemory('deploy');
      await startMemoryReview('ws-a', { trigger: 'schedule', periodStart: at('2026-11-02T00:00:00Z') });
      const res = await call('GET', '/workbenches/memory/reviews?workspaceId=ws-a');
      expect(res.status).toBe(200);
      expect(res.body.data.cadence).toBe('weekly');
      expect(res.body.data.runs).toHaveLength(1);
      expect(res.body.data.runs[0]).toMatchObject({ status: 'started', workbenchId: 'thread-1', trigger: 'schedule' });
    });

    it('refuses when the flag is off', async () => {
      vi.stubEnv('MEMORY_REVIEW_ENABLED', 'false');
      resetFeatureFlagsForTests();
      const res = await call('GET', '/workbenches/memory/reviews?workspaceId=ws-a');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('flag_off');
      expect((await call('POST', '/workbenches/memory/reviews', { workspaceId: 'ws-a' })).status).toBe(403);
    });

    it("refuses another owner's workspace", async () => {
      const res = await call('GET', '/workbenches/memory/reviews?workspaceId=ws-a', undefined, 'owner-b');
      expect(res.status).toBeGreaterThanOrEqual(403);
      expect((await call('POST', '/workbenches/memory/reviews', { workspaceId: 'ws-a' }, 'owner-b')).status).toBeGreaterThanOrEqual(403);
      expect(createWorkbench).not.toHaveBeenCalled();
    });

    it('starts a review now', async () => {
      await setSettings({});
      await addMemory('build');
      await addMemory('deploy');
      const res = await call('POST', '/workbenches/memory/reviews', { workspaceId: 'ws-a' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ trigger: 'manual', status: 'started', workbenchId: 'thread-1' });
    });

    it('refuses a review now with fewer than two entries', async () => {
      await addMemory('build');
      const res = await call('POST', '/workbenches/memory/reviews', { workspaceId: 'ws-a' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('memory_review_too_few');
    });

    it('refuses a review now when session memory is off', async () => {
      await setSettings({ sessionMemory: false });
      await addMemory('build');
      await addMemory('deploy');
      const res = await call('POST', '/workbenches/memory/reviews', { workspaceId: 'ws-a' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('memory_off');
    });

    it('refuses a review now while one runs', async () => {
      await addMemory('build');
      await addMemory('deploy');
      const first = await call('POST', '/workbenches/memory/reviews', { workspaceId: 'ws-a' });
      await insertChat({
        id: 'chat-1', workbenchId: first.body.data.workbenchId, workspaceId: 'ws-a', title: 'Memory review',
        agent: 'claude', model: null, status: 'running',
      } as Loose);
      const second = await call('POST', '/workbenches/memory/reviews', { workspaceId: 'ws-a' });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('memory_review_running');
    });
  });
});
