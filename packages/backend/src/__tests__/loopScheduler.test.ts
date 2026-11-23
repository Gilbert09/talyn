import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { eq } from 'drizzle-orm';
import { validateLoop, type LoopInput, type NormalizedLoop } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  loopRuns as runsTable,
  loops as loopsTable,
  repositories as repositoriesTable,
  spaces as spacesTable,
  tasks as tasksTable,
  teamMembers as teamMembersTable,
  teams as teamsTable,
  workbenchChats as chatsTable,
  workbenches as workbenchesTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import { createLoop, getLoopRun } from '../services/loops/store.js';
import { loopScheduler } from '../services/loops/scheduler.js';
import { ConcurrentBoxLimitError, SizeRequiresProError, UsageExhaustedError } from '../services/billing/entitlements.js';
import * as taskCreate from '../services/taskCreate.js';
import * as fleetAccess from '../services/cloudProviders/fleetAccess.js';
import * as registry from '../services/cloudProviders/registry.js';
import * as loopsAccess from '../services/loopsAccess.js';
import * as fleetCredentials from '../services/selfHosted/credentials.js';
import * as analytics from '../services/analytics.js';
import * as workbenchCreate from '../services/workbenches/create.js';
import { WorkbenchError } from '../services/workbenches/errors.js';

/**
 * The scheduler end to end, against a real Postgres.
 *
 * What is pinned here is everything that cannot be checked another way: the
 * insert-is-the-claim idempotency that stops two replicas double-firing, the
 * catch-up rule, the overlap setting, the plan-limit deferral that has no
 * request behind it to 402, the refusal to fail a pinned provider over to
 * another vendor, and that every firing starts a session, never a cloud task.
 */

const WORKSPACE = 'ws-1';
const REPO_ID = 'repo-1';
const MODEL = 'claude-sonnet-5-5';

function loopInput(over: Partial<LoopInput> = {}): NormalizedLoop {
  return validateLoop({
    name: 'Morning triage',
    prompt: 'Fix yesterday’s failing checks.',
    cron: '0 9 * * *',
    timezone: 'UTC',
    provider: 'selfhosted',
    model: MODEL,
    target: 'session',
    repositoryId: REPO_ID,
    repoFullName: 'acme/widget',
    ...over,
  });
}

/** A loop whose next occurrence is already due. */
async function dueLoop(db: Database, over: Partial<LoopInput> = {}, dueAt = new Date(Date.now() - 60_000)) {
  const loop = await createLoop(WORKSPACE, loopInput(over));
  await db.update(loopsTable).set({ nextRunAt: dueAt }).where(eq(loopsTable.id, loop.id));
  return loop;
}

async function runsFor(db: Database, loopId: string) {
  return db.select().from(runsTable).where(eq(runsTable.loopId, loopId));
}

describe('loop scheduler', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let createSession: MockInstance<typeof workbenchCreate.createWorkbench>;
  let createTask: MockInstance<typeof taskCreate.createCloudTask>;
  let sessionSeq = 0;

  /** Move the first chat of the run's session, as the agent would. */
  async function setChat(runChatId: string | null, set: { status?: string; turnCount?: number }) {
    await db.update(chatsTable).set(set).where(eq(chatsTable.id, runChatId!));
  }

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await db.insert(workspacesTable).values({
      id: WORKSPACE,
      ownerId: TEST_USER_ID,
      name: 'Test',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: REPO_ID,
      workspaceId: WORKSPACE,
      name: 'acme/widget',
      url: 'https://github.com/acme/widget',
      defaultBranch: 'main',
    });

    delete process.env.LOOPS_ENABLED;
    sessionSeq = 0;
    vi.spyOn(loopsAccess, 'workspaceMayUseLoops').mockResolvedValue(true);
    vi.spyOn(registry, 'getCloudProvider').mockReturnValue({ type: 'selfhosted' } as never);
    vi.spyOn(fleetAccess, 'workspaceMayUseFleet').mockResolvedValue(true);
    vi.spyOn(fleetCredentials, 'fleetAgentStatus').mockResolvedValue({
      connectedAgents: ['claude', 'codex'],
      reauthAgents: [],
    });
    createTask = vi.spyOn(taskCreate, 'createCloudTask').mockRejectedValue(new Error('a loop must never create a task'));
    createSession = vi.spyOn(workbenchCreate, 'createWorkbench').mockImplementation(async (input) => {
      sessionSeq += 1;
      const id = `session-${sessionSeq}`;
      const chatId = `chat-${sessionSeq}`;
      await db.insert(workbenchesTable).values({
        id,
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId!,
        repoFullName: 'acme/widget',
        name: `morning-triage-${sessionSeq}`,
        branch: `morning-triage-${sessionSeq}`,
        baseBranch: 'main',
        runtime: 'sandbox',
        agent: input.agent,
        model: input.model,
        sandboxState: 'creating',
        status: 'provisioning',
        settings: { autoCreatePr: true },
        source: input.source,
      });
      await db.insert(chatsTable).values({
        id: chatId,
        workbenchId: id,
        workspaceId: input.workspaceId,
        title: 'Morning triage',
        agent: input.agent,
        model: input.model,
        queuedMessages: [],
      });
      return { id, workspaceId: input.workspaceId, chats: [{ id: chatId }] } as never;
    });
  });

  afterEach(async () => {
    // The invariant of the whole feature: no path through the scheduler
    // creates a cloud task.
    expect(createTask).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    await cleanup();
  });

  describe('claiming', () => {
    it('fires a due loop once and advances the schedule past it', async () => {
      const loop = await dueLoop(db);
      const fired = await loopScheduler.tick();

      expect(fired).toBe(1);
      expect(createSession).toHaveBeenCalledTimes(1);

      const runs = await runsFor(db, loop.id);
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('queued');
      expect(runs[0].workbenchId).toBeTruthy();
      expect(runs[0].taskId).toBeNull();

      const [row] = await db.select().from(loopsTable).where(eq(loopsTable.id, loop.id));
      expect(row.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('links the session back to the firing that started it', async () => {
      const loop = await dueLoop(db);
      await loopScheduler.tick();
      const [run] = await runsFor(db, loop.id);
      // `source` is how somebody reading a surprising 3am session gets back
      // to the schedule that asked for it.
      expect(createSession.mock.calls[0][0].source).toEqual({ kind: 'loop', loopId: loop.id, runId: run.id });
    });

    it('does not fire a loop whose occurrence has not arrived', async () => {
      await dueLoop(db, {}, new Date(Date.now() + 3_600_000));
      expect(await loopScheduler.tick()).toBe(0);
      expect(createSession).not.toHaveBeenCalled();
    });

    it('does not fire a disabled loop', async () => {
      const loop = await dueLoop(db);
      await db
        .update(loopsTable)
        .set({ enabled: false, nextRunAt: new Date(Date.now() - 60_000) })
        .where(eq(loopsTable.id, loop.id));
      expect(await loopScheduler.tick()).toBe(0);
      expect(createSession).not.toHaveBeenCalled();
    });

    it('a second tick on the same occurrence creates no second session', async () => {
      // The core of the concurrency design. Two replicas racing the same due
      // loop both derive the same (loop_id, scheduled_for), so the second
      // insert conflicts — this simulates that by rewinding next_run_at, which
      // is exactly the state a crashed mid-fire leaves behind.
      const at = new Date(Date.now() - 60_000);
      const loop = await dueLoop(db, {}, at);
      await loopScheduler.tick();
      await db.update(loopsTable).set({ nextRunAt: at }).where(eq(loopsTable.id, loop.id));
      await loopScheduler.tick();

      expect(createSession).toHaveBeenCalledTimes(1);
      expect(await runsFor(db, loop.id)).toHaveLength(1);
    });

    it('recovers a claim that was never dispatched', async () => {
      // The crash window: the row exists, the session does not. The due-scan
      // re-enters (next_run_at is still in the past) and finishes the job
      // rather than leaving the firing silently lost.
      const at = new Date(Date.now() - 60_000);
      const loop = await dueLoop(db, {}, at);
      await db.insert(runsTable).values({
        id: 'orphan-1',
        loopId: loop.id,
        workspaceId: WORKSPACE,
        scheduledFor: at,
        repoFullName: 'acme/widget',
        provider: 'selfhosted',
        model: MODEL,
        target: 'session',
        status: 'queued',
      });

      await loopScheduler.tick();

      expect(createSession).toHaveBeenCalledTimes(1);
      const [run] = await runsFor(db, loop.id);
      expect(run.id).toBe('orphan-1');
      expect(run.workbenchId).toBeTruthy();
    });
  });

  describe('sessions', () => {
    it.each([
      ['claude-sonnet-5-5', 'claude'],
      ['claude-sonnet-5', 'claude'],
      ['gpt-6.1-sol', 'codex'],
      ['gpt-6.1-terra', 'codex'],
    ] as const)('starts a %s session on the %s agent and settles after its first turn', async (model, agent) => {
      const loop = await dueLoop(db, { model });

      await loopScheduler.tick();

      let [run] = await runsFor(db, loop.id);
      expect(run.taskId).toBeNull();
      expect(run.workbenchId).toBe('session-1');
      expect(await getLoopRun(run.id)).toMatchObject({
        target: 'session',
        sessionId: 'session-1',
        session: { id: 'session-1', status: 'provisioning' },
      });
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: WORKSPACE,
          repositoryId: REPO_ID,
          runtime: 'sandbox',
          agent,
          prompt: 'Fix yesterday’s failing checks.',
          namingText: 'Morning triage',
          autoCreatePr: true,
          source: { kind: 'loop', loopId: loop.id, runId: run.id },
        }),
        expect.objectContaining({ id: TEST_USER_ID })
      );

      await setChat(run.workbenchChatId, { status: 'running', turnCount: 1 });
      await loopScheduler.tick();
      [run] = await runsFor(db, loop.id);
      expect(run.status).toBe('running');

      await setChat(run.workbenchChatId, { status: 'idle' });
      await loopScheduler.tick();
      [run] = await runsFor(db, loop.id);
      expect(run.status).toBe('succeeded');
    });

    it('starts a session for a stored loop that still says target=task', async () => {
      // A loop row written before automations stopped creating cloud tasks.
      // The migration rewrites these, but dispatch must not depend on it.
      const loop = await dueLoop(db);
      await db.update(loopsTable).set({ target: 'task' }).where(eq(loopsTable.id, loop.id));

      await loopScheduler.tick();

      expect(createSession).toHaveBeenCalledTimes(1);
      const [run] = await runsFor(db, loop.id);
      expect(run.workbenchId).toBe('session-1');
      expect(run.taskId).toBeNull();
      expect({ target: run.target, status: run.status, failureCode: run.failureCode }).toEqual({
        target: 'session',
        status: 'queued',
        failureCode: null,
      });
    });

    it('refuses a stored PostHog Code loop without creating a task or a session', async () => {
      const loop = await dueLoop(db);
      await db
        .update(loopsTable)
        .set({ provider: 'posthog_code', model: 'claude-opus-5', target: 'task' })
        .where(eq(loopsTable.id, loop.id));

      await loopScheduler.tick();

      expect(createSession).not.toHaveBeenCalled();
      const [run] = await runsFor(db, loop.id);
      expect(run.status).toBe('failed');
      expect(run.failureCode).toBe('environment_missing');
      expect(run.error).toBe(
        'A schedule starts a session on Talyn Fleet. Edit the schedule and choose a Talyn Fleet agent.'
      );
      const [row] = await db.select().from(loopsTable).where(eq(loopsTable.id, loop.id));
      expect(row.enabled).toBe(false);
      expect(row.disabledReason).toBe('environment_missing');
    });

    it.each([
      ['flag_off', 'sessions_not_allowed'],
      ['fleet_not_allowed', 'fleet_not_allowed'],
      ['fleet_disabled', 'fleet_not_allowed'],
      ['fleet_not_deployed', 'fleet_not_allowed'],
      ['agent_not_connected', 'agent_not_connected'],
      ['agent_reauth_required', 'agent_not_connected'],
      ['something_else', 'dispatch_failed'],
    ])('maps a %s session refusal to %s', async (errorCode, failureCode) => {
      createSession.mockRejectedValueOnce(new WorkbenchError('No session for you.', 400, errorCode));
      const loop = await dueLoop(db);

      await loopScheduler.tick();

      const [run] = await runsFor(db, loop.id);
      expect(run.status).toBe('failed');
      expect(run.failureCode).toBe(failureCode);
      expect(run.error).toBe('No session for you.');
    });

    it('fails the run when the session comes back without a chat', async () => {
      createSession.mockResolvedValueOnce({ id: 'no-chat', workspaceId: WORKSPACE, chats: [] } as never);
      const loop = await dueLoop(db);

      await loopScheduler.tick();

      const [run] = await runsFor(db, loop.id);
      expect(run.status).toBe('failed');
      expect(run.failureCode).toBe('dispatch_failed');
      expect(run.workbenchId).toBeNull();
    });
  });

  describe('internet access', () => {
    it.each([
      [undefined, false],
      [false, false],
      [true, true],
    ])('internetAccess=%s reaches the session as %s', async (internetAccess, expected) => {
      await dueLoop(db, internetAccess === undefined ? {} : { internetAccess });
      await loopScheduler.tick();
      expect(createSession.mock.calls[0][0].internetAccess).toBe(expected);
    });
  });

  describe('space', () => {
    beforeEach(async () => {
      process.env.SPACES_ENABLED = 'true';
      await db.insert(teamsTable).values([{ id: 'team-1', name: 'Acme' }, { id: 'team-2', name: 'Other' }]);
      await db.insert(teamMembersTable).values([
        { id: 'm-1', teamId: 'team-1', githubUserId: 100, userId: TEST_USER_ID, githubLogin: 'tom', role: 'owner' },
      ]);
      await db.insert(spacesTable).values([
        { id: 'space-1', teamId: 'team-1', name: 'Web' },
        { id: 'space-old', teamId: 'team-1', name: 'Old', archivedAt: new Date() },
        { id: 'space-2', teamId: 'team-2', name: 'Not mine' },
      ]);
    });

    afterEach(() => {
      delete process.env.SPACES_ENABLED;
    });

    it('starts a loop with no space in Personal, with no notice', async () => {
      const loop = await dueLoop(db);
      await loopScheduler.tick();
      expect(createSession.mock.calls[0][0].spaceId).toBeNull();
      const [run] = await runsFor(db, loop.id);
      expect(run.notice).toBeNull();
    });

    it('passes the loop’s space to the session', async () => {
      const loop = await dueLoop(db, { spaceId: 'space-1' });
      await loopScheduler.tick();
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ spaceId: 'space-1', source: expect.objectContaining({ loopId: loop.id }) }),
        expect.objectContaining({ id: TEST_USER_ID })
      );
      const [run] = await runsFor(db, loop.id);
      expect(run).toMatchObject({ status: 'queued', notice: null });
    });

    it.each([
      ['archived', 'space-old', 'true', 'The space is archived.'],
      ['of a team the owner is not in', 'space-2', 'true', 'The space was not found, or you are not in its team.'],
      ['behind Spaces switched off', 'space-1', 'false', 'Spaces are not available for this account.'],
    ])('falls back to Personal when the space is %s, and the run says why', async (_label, spaceId, flag, reason) => {
      process.env.SPACES_ENABLED = flag;
      const loop = await dueLoop(db);
      // Written straight to the row: the route refuses these on save, but each
      // can happen after the save.
      await db.update(loopsTable).set({ spaceId }).where(eq(loopsTable.id, loop.id));
      await loopScheduler.tick();

      expect(createSession).toHaveBeenCalledTimes(1);
      expect(createSession.mock.calls[0][0].spaceId).toBeNull();
      const [run] = await runsFor(db, loop.id);
      expect(run.status).toBe('queued');
      expect(run.notice).toBe(`Started in Personal, not in the chosen space: ${reason}`);
    });

    it('falls back when the owner leaves the team after the save, and keeps the notice once the run settles', async () => {
      const loop = await dueLoop(db, { spaceId: 'space-1' });
      await db.delete(teamMembersTable).where(eq(teamMembersTable.id, 'm-1'));
      await loopScheduler.tick();
      expect(createSession.mock.calls[0][0].spaceId).toBeNull();

      const [run] = await runsFor(db, loop.id);
      await setChat(run.workbenchChatId, { status: 'idle', turnCount: 1 });
      await loopScheduler.tick();

      const [settled] = await runsFor(db, loop.id);
      expect(settled.status).toBe('succeeded');
      expect(settled.notice).toBe(
        'Started in Personal, not in the chosen space: The space was not found, or you are not in its team.'
      );
      // The loop keeps its space: rejoining the team puts later runs back in it.
      const [row] = await db.select().from(loopsTable).where(eq(loopsTable.id, loop.id));
      expect(row.spaceId).toBe('space-1');
    });

    it('a deleted space sets the loop back to Personal', async () => {
      const loop = await dueLoop(db, { spaceId: 'space-1' });
      await db.delete(spacesTable).where(eq(spacesTable.id, 'space-1'));
      const [row] = await db.select().from(loopsTable).where(eq(loopsTable.id, loop.id));
      expect(row.spaceId).toBeNull();
      await loopScheduler.tick();
      expect(createSession.mock.calls[0][0].spaceId).toBeNull();
      const [run] = await runsFor(db, loop.id);
      expect(run.notice).toBeNull();
    });

    it('a parked run that retries still starts in the space', async () => {
      createSession.mockRejectedValueOnce(new ConcurrentBoxLimitError(3, 3));
      const loop = await dueLoop(db, { spaceId: 'space-1' });
      await loopScheduler.tick();
      await db
        .update(runsTable)
        .set({ retryAfter: new Date(Date.now() - 1_000) })
        .where(eq(runsTable.loopId, loop.id));
      await loopScheduler.tick();

      expect(createSession).toHaveBeenCalledTimes(2);
      expect(createSession.mock.calls[1][0].spaceId).toBe('space-1');
    });
  });

  describe('catch-up', () => {
    it('fires ONCE for a loop overdue by days, then jumps to the future', async () => {
      // A weekend outage must not replay every missed occurrence: that is a
      // burst of near-identical sessions and a wall of box-limit refusals.
      const loop = await dueLoop(db, {}, new Date(Date.now() - 3 * 86_400_000));
      await loopScheduler.tick();

      expect(createSession).toHaveBeenCalledTimes(1);
      expect(await runsFor(db, loop.id)).toHaveLength(1);

      const [row] = await db.select().from(loopsTable).where(eq(loopsTable.id, loop.id));
      expect(row.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('records the occurrence it stood for, not the moment it ran', async () => {
      // What keeps catch-up honest: the history says "scheduled 09:00, ran
      // 15:04" rather than quietly claiming the 09:00 run happened at 09:00.
      const at = new Date(Date.now() - 6 * 3_600_000);
      const loop = await dueLoop(db, {}, at);
      await loopScheduler.tick();
      const [run] = await runsFor(db, loop.id);
      expect(run.scheduledFor.getTime()).toBe(at.getTime());
      expect(run.createdAt.getTime()).toBeGreaterThan(at.getTime());
    });
  });

  describe('overlap', () => {
    async function fireTwice(concurrency: 'skip' | 'allow') {
      const loop = await dueLoop(db, { concurrency });
      await loopScheduler.tick();
      await db
        .update(loopsTable)
        .set({ nextRunAt: new Date(Date.now() - 30_000) })
        .where(eq(loopsTable.id, loop.id));
      await loopScheduler.tick();
      return runsFor(db, loop.id);
    }

    it('skips when a run is still going, and records why', async () => {
      const runs = await fireTwice('skip');
      expect(runs).toHaveLength(2);
      const skipped = runs.find((r) => r.status === 'skipped');
      expect(skipped?.failureCode).toBe('overlap');
      // One session, not two — the whole point of the setting.
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    it('starts a second run when the loop says to allow it', async () => {
      const runs = await fireTwice('allow');
      expect(createSession).toHaveBeenCalledTimes(2);
      expect(runs.every((r) => r.status === 'queued')).toBe(true);
      expect(new Set(runs.map((r) => r.workbenchId)).size).toBe(2);
    });

    it('fires again once the previous session has settled', async () => {
      const loop = await dueLoop(db, { concurrency: 'skip' });
      await loopScheduler.tick();
      const [first] = await runsFor(db, loop.id);
      await setChat(first.workbenchChatId, { status: 'idle', turnCount: 1 });
      await loopScheduler.tick();
      await db
        .update(loopsTable)
        .set({ nextRunAt: new Date(Date.now() - 30_000) })
        .where(eq(loopsTable.id, loop.id));
      await loopScheduler.tick();

      const runs = await runsFor(db, loop.id);
      expect(runs.map((r) => r.status).sort()).toEqual(['queued', 'succeeded']);
      expect(createSession).toHaveBeenCalledTimes(2);
    });
  });

  describe('the plan limit', () => {
    const PERIOD_END = new Date(Date.now() + 7 * 86_400_000);
    it.each([
      ['box cap', () => new ConcurrentBoxLimitError(2, 2), 'waiting_slot', 'box_limit_reached', 30_000],
      // Used-up hours wait a quarter hour (or the reset, if sooner), never
      // one sweep: an exhausted owner's loop must not ask every 30 seconds.
      ['exhausted', () => new UsageExhaustedError({ tier: 'free', periodEnd: PERIOD_END }), 'waiting_slot', 'usage_exhausted', 15 * 60_000],
      ['exhausted, reset in 5 min', () => new UsageExhaustedError({ tier: 'free', periodEnd: new Date(Date.now() + 5 * 60_000) }), 'waiting_slot', 'usage_exhausted', 5 * 60_000],
      ['size', () => new SizeRequiresProError({ tier: 'free', size: 'large' }), 'failed', 'size_requires_pro', null],
    ] as const)('parks a %s refusal visibly rather than losing it', async (_label, make, status, code, retryInMs) => {
      // There is no request to answer with a 402 and no modal to open, so the
      // run row IS the notification. A silent deferral is why the paywall read
      // as never firing.
      const err = make();
      createSession.mockRejectedValueOnce(err);
      const loop = await dueLoop(db);
      const before = Date.now();
      await loopScheduler.tick();

      const [run] = await runsFor(db, loop.id);
      expect(run.status).toBe(status);
      expect(run.failureCode).toBe(code);
      expect(run.error).toBe(err.message);
      expect(run.workbenchId).toBeNull();
      if (retryInMs === null) {
        expect(run.retryAfter).toBeNull();
      } else {
        const due = run.retryAfter!.getTime() - before;
        expect(due).toBeGreaterThan(retryInMs - 5_000);
        expect(due).toBeLessThanOrEqual(retryInMs + 5_000);
      }
    });

    it('retries a parked run once its retry is due', async () => {
      createSession.mockRejectedValueOnce(new ConcurrentBoxLimitError(3, 3));
      const loop = await dueLoop(db);
      await loopScheduler.tick();
      await db
        .update(runsTable)
        .set({ retryAfter: new Date(Date.now() - 1_000) })
        .where(eq(runsTable.loopId, loop.id));

      await loopScheduler.tick();

      const [run] = await runsFor(db, loop.id);
      expect(run.status).toBe('queued');
      expect(run.workbenchId).toBeTruthy();
      expect(run.failureCode).toBeNull();
      expect(run.retryAfter).toBeNull();
      expect(createSession).toHaveBeenCalledTimes(2);
    });

    it('re-parks a retry that is still refused', async () => {
      createSession.mockRejectedValue(new ConcurrentBoxLimitError(3, 3));
      const loop = await dueLoop(db);
      await loopScheduler.tick();
      await db
        .update(runsTable)
        .set({ retryAfter: new Date(Date.now() - 1_000) })
        .where(eq(runsTable.loopId, loop.id));

      await loopScheduler.tick();

      const [run] = await runsFor(db, loop.id);
      expect(run.status).toBe('waiting_slot');
      expect(run.retryAfter!.getTime()).toBeGreaterThan(Date.now());
      expect(createSession).toHaveBeenCalledTimes(2);
    });

    it('gives up when the NEXT occurrence has been claimed, not after N tries', async () => {
      // Supersession rather than an attempt cap: a cron payload is "it is
      // time", which does not go stale until the next time arrives.
      createSession.mockRejectedValue(new ConcurrentBoxLimitError(3, 3));
      const loop = await dueLoop(db);
      await loopScheduler.tick();

      await db.insert(runsTable).values({
        id: 'newer',
        loopId: loop.id,
        workspaceId: WORKSPACE,
        scheduledFor: new Date(Date.now() + 3_600_000),
        repoFullName: 'acme/widget',
        provider: 'selfhosted',
        model: MODEL,
        target: 'session',
        status: 'queued',
      });
      await db
        .update(runsTable)
        .set({ retryAfter: new Date(Date.now() - 1_000) })
        .where(eq(runsTable.status, 'waiting_slot'));

      await loopScheduler.tick();

      const parked = (await runsFor(db, loop.id)).find((r) => r.id !== 'newer');
      expect(parked?.status).toBe('skipped');
      expect(parked?.failureCode).toBe('box_limit_reached');
    });
  });

  describe('analytics', () => {
    // How anybody finds out whether loops are used and whether they work.
    const captureSpy = () => vi.spyOn(analytics, 'captureWorkspaceEvent').mockReturnValue(undefined);
    const ranEvents = (c: ReturnType<typeof captureSpy>) =>
      c.mock.calls.filter(([, event]) => event === 'loop_ran');

    async function finishFirstTurn(loopId: string) {
      const [run] = await runsFor(db, loopId);
      await setChat(run.workbenchChatId, { status: 'idle', turnCount: 1 });
      return run;
    }

    it('reports a firing that succeeded, with what ran it', async () => {
      const loop = await dueLoop(db);
      await loopScheduler.tick();
      const run = await finishFirstTurn(loop.id);

      const capture = captureSpy();
      await loopScheduler.tick();

      const ran = ranEvents(capture);
      expect(ran).toHaveLength(1);
      expect(ran[0][0]).toBe(WORKSPACE);
      expect(ran[0][2]).toMatchObject({
        loop_id: loop.id,
        run_id: run.id,
        status: 'succeeded',
        trigger: 'schedule',
        provider: 'selfhosted',
        model: MODEL,
        target: 'session',
        started_task: false,
        started_session: true,
        failure_code: null,
      });
      expect(ran[0][2]).toHaveProperty('duration_ms');
      expect(ran[0][2]).toHaveProperty('late_ms');
    });

    it('reports a failure with its code', async () => {
      const loop = await dueLoop(db);
      await loopScheduler.tick();
      const [run] = await runsFor(db, loop.id);
      await db.delete(workbenchesTable).where(eq(workbenchesTable.id, run.workbenchId!));

      const capture = captureSpy();
      await loopScheduler.tick();

      expect(ranEvents(capture)[0]?.[2]).toMatchObject({
        status: 'failed',
        failure_code: 'session_deleted',
      });
    });

    it('says when a firing never got a session at all', async () => {
      // The difference between "the agent failed" and "we never asked" — which
      // is the difference between a product problem and an infrastructure one.
      await dueLoop(db);
      createSession.mockRejectedValueOnce(new Error('provider exploded'));

      const capture = captureSpy();
      await loopScheduler.tick();

      expect(ranEvents(capture)[0]?.[2]).toMatchObject({
        status: 'failed',
        started_task: false,
        started_session: false,
        duration_ms: null,
      });
    });

    it('measures how late the firing was against the occurrence it stood for', async () => {
      // Small on a healthy sweep. Large means catch-up after a deploy or an
      // outage, which the count alone cannot show.
      const loop = await dueLoop(db, {}, new Date(Date.now() - 6 * 60 * 60 * 1000));
      const capture = captureSpy();
      await loopScheduler.tick();
      await finishFirstTurn(loop.id);
      await loopScheduler.tick();

      const late = ranEvents(capture)[0]?.[2] as { late_ms: number };
      expect(late.late_ms).toBeGreaterThan(5 * 60 * 60 * 1000);
    });

    it('says nothing while the run is merely in progress', async () => {
      // `running` is progress, not an outcome; a firing must produce ONE event.
      const loop = await dueLoop(db);
      await loopScheduler.tick();
      const [run] = await runsFor(db, loop.id);
      await setChat(run.workbenchChatId, { status: 'running', turnCount: 1 });

      const capture = captureSpy();
      await loopScheduler.tick();

      expect(ranEvents(capture)).toHaveLength(0);
      expect((await runsFor(db, loop.id))[0].status).toBe('running');
    });

    it('says nothing for a run parked on the plan limit', async () => {
      // Already reported as `paywall_deferred` by the dispatcher, which knows
      // the limit and the plan. Reporting it twice would double-count refusals.
      await dueLoop(db);
      createSession.mockRejectedValueOnce(new ConcurrentBoxLimitError(3, 3));

      const capture = captureSpy();
      await loopScheduler.tick();

      expect(ranEvents(capture)).toHaveLength(0);
      expect(capture.mock.calls.some(([, e]) => e === 'paywall_deferred')).toBe(true);
    });

    it('emits once even when a second settlement races it', async () => {
      // The UPDATE's `WHERE status IN (active)` is the guard: only one caller
      // gets the row back, so only one emits. This is why the event lives in
      // settleRun rather than at its call sites.
      const loop = await dueLoop(db);
      await loopScheduler.tick();
      await finishFirstTurn(loop.id);

      const capture = captureSpy();
      await Promise.all([loopScheduler.tick(), loopScheduler.tick()]);
      await loopScheduler.tick();

      expect(ranEvents(capture)).toHaveLength(1);
    });
  });

  describe('settlement', () => {
    it('follows the session to succeeded and clears the failure count', async () => {
      const loop = await dueLoop(db);
      await db.update(loopsTable).set({ consecutiveFailures: 3 }).where(eq(loopsTable.id, loop.id));
      await loopScheduler.tick();
      const [run] = await runsFor(db, loop.id);
      await setChat(run.workbenchChatId, { status: 'idle', turnCount: 1 });

      await loopScheduler.tick();

      const [settled] = await runsFor(db, loop.id);
      expect(settled.status).toBe('succeeded');
      expect(settled.settledAt).toBeTruthy();
      const [row] = await db.select().from(loopsTable).where(eq(loopsTable.id, loop.id));
      expect(row.consecutiveFailures).toBe(0);
    });

    it('waits while the first turn has not started', async () => {
      const loop = await dueLoop(db);
      await loopScheduler.tick();
      const [run] = await runsFor(db, loop.id);
      await setChat(run.workbenchChatId, { status: 'idle', turnCount: 0 });

      await loopScheduler.tick();

      expect((await runsFor(db, loop.id))[0].status).toBe('queued');
    });

    it('settles failed when the session was deleted mid-flight', async () => {
      const loop = await dueLoop(db);
      await loopScheduler.tick();
      const [run] = await runsFor(db, loop.id);
      await db.delete(workbenchesTable).where(eq(workbenchesTable.id, run.workbenchId!));

      await loopScheduler.tick();

      const [settled] = await runsFor(db, loop.id);
      expect(settled.status).toBe('failed');
      expect(settled.failureCode).toBe('session_deleted');
    });

    it.each([
      ['the session errored', { workbench: { status: 'error' } }, 'The session could not start.'],
      ['the chat needs a person', { chat: { status: 'awaiting_input', turnCount: 1 } }, 'The session stopped and needs a person to continue.'],
      ['the chat errored', { chat: { status: 'error', turnCount: 1 } }, 'The session stopped before its first turn finished.'],
    ] as const)('settles failed when %s', async (_label, change, error) => {
      const loop = await dueLoop(db);
      await loopScheduler.tick();
      const [run] = await runsFor(db, loop.id);
      if ('workbench' in change) {
        await db.update(workbenchesTable).set(change.workbench).where(eq(workbenchesTable.id, run.workbenchId!));
      } else {
        await setChat(run.workbenchChatId, change.chat);
      }

      await loopScheduler.tick();

      const [settled] = await runsFor(db, loop.id);
      expect(settled.status).toBe('failed');
      expect(settled.failureCode).toBe('session_failed');
      expect(settled.error).toBe(error);
      const [row] = await db.select().from(loopsTable).where(eq(loopsTable.id, loop.id));
      expect(row.consecutiveFailures).toBe(1);
    });

    it('switches a loop off after five consecutive failures', async () => {
      // What stops a permanently broken loop spending a box every hour
      // until somebody notices.
      const loop = await dueLoop(db);
      for (let i = 0; i < 5; i += 1) {
        await db
          .update(loopsTable)
          .set({ nextRunAt: new Date(Date.now() - 60_000), enabled: true })
          .where(eq(loopsTable.id, loop.id));
        createSession.mockRejectedValueOnce(new Error('provider exploded'));
        await loopScheduler.tick();
      }
      const [row] = await db.select().from(loopsTable).where(eq(loopsTable.id, loop.id));
      expect(row.enabled).toBe(false);
      expect(row.disabledReason).toBe('too_many_failures');
    });

    describe('an old run that started a cloud task', () => {
      // Runs from before automations stopped creating cloud tasks still
      // settle through the task path.
      async function oldTaskRun(taskStatus: string) {
        const loop = await createLoop(WORKSPACE, loopInput());
        await db.insert(tasksTable).values({
          id: 'task-old',
          workspaceId: WORKSPACE,
          type: 'code_writing',
          status: taskStatus,
          title: 'Morning triage',
          description: '',
          repositoryId: REPO_ID,
        });
        await db.insert(runsTable).values({
          id: 'run-old',
          loopId: loop.id,
          workspaceId: WORKSPACE,
          scheduledFor: new Date(Date.now() - 3_600_000),
          repoFullName: 'acme/widget',
          provider: 'posthog_code',
          model: 'claude-opus-5',
          target: 'task',
          taskId: 'task-old',
          dispatchedAt: new Date(Date.now() - 3_000_000),
          status: 'queued',
        });
        return loop;
      }

      it.each([
        ['in_progress', 'running', null],
        ['completed', 'succeeded', null],
        ['failed', 'failed', 'dispatch_failed'],
        ['cancelled', 'failed', 'dispatch_failed'],
        ['needs_human', 'failed', 'dispatch_failed'],
      ])('maps task %s to %s', async (taskStatus, status, failureCode) => {
        await oldTaskRun(taskStatus);
        await loopScheduler.tick();
        const [run] = await db.select().from(runsTable).where(eq(runsTable.id, 'run-old'));
        expect(run.status).toBe(status);
        expect(run.failureCode).toBe(failureCode);
        expect(createSession).not.toHaveBeenCalled();
      });

      it('settles failed when the task was deleted mid-flight', async () => {
        await oldTaskRun('queued');
        await db.delete(tasksTable).where(eq(tasksTable.id, 'task-old'));
        await loopScheduler.tick();
        const [run] = await db.select().from(runsTable).where(eq(runsTable.id, 'run-old'));
        expect(run.status).toBe('failed');
        expect(run.failureCode).toBe('task_deleted');
      });
    });
  });

  describe('configuration that has gone away', () => {
    it('records a skip and switches off when the repository is disconnected', async () => {
      const loop = await dueLoop(db);
      await db.update(loopsTable).set({ repositoryId: null }).where(eq(loopsTable.id, loop.id));

      await loopScheduler.tick();

      expect(createSession).not.toHaveBeenCalled();
      const [run] = await runsFor(db, loop.id);
      expect(run.status).toBe('skipped');
      expect(run.failureCode).toBe('repo_missing');
      const [row] = await db.select().from(loopsTable).where(eq(loopsTable.id, loop.id));
      expect(row.enabled).toBe(false);
      expect(row.disabledReason).toBe('repo_missing');
    });

    it('fails a fleet loop rather than falling back to PostHog Code', async () => {
      // The decision this test exists to protect: a pinned provider is never
      // failed over. Somebody who chose the fleet chose their own subscription
      // and their own credential custody, and quietly moving that onto metered
      // credits at 3am is a bill they did not agree to.
      vi.mocked(fleetAccess.workspaceMayUseFleet).mockResolvedValue(false);
      const loop = await dueLoop(db);

      await loopScheduler.tick();

      expect(createSession).not.toHaveBeenCalled();
      const [run] = await runsFor(db, loop.id);
      expect(run.status).toBe('failed');
      expect(run.failureCode).toBe('fleet_not_allowed');
    });

    it.each([
      ['gpt-6.1-terra', ['claude'] as const],
      ['claude-sonnet-5', ['codex'] as const],
    ])('fails a %s loop whose agent is no longer connected', async (model, connected) => {
      vi.mocked(fleetCredentials.fleetAgentStatus).mockResolvedValue({
        connectedAgents: [...connected],
        reauthAgents: [],
      });
      const loop = await dueLoop(db, { model });

      await loopScheduler.tick();

      expect(createSession).not.toHaveBeenCalled();
      const [run] = await runsFor(db, loop.id);
      expect(run.failureCode).toBe('agent_not_connected');
      const [row] = await db.select().from(loopsTable).where(eq(loopsTable.id, loop.id));
      expect(row.enabled).toBe(false);
    });

    it('fails when the provider is gone from this deployment', async () => {
      vi.mocked(registry.getCloudProvider).mockReturnValue(undefined as never);
      const loop = await dueLoop(db);

      await loopScheduler.tick();

      expect(createSession).not.toHaveBeenCalled();
      const [run] = await runsFor(db, loop.id);
      expect(run.failureCode).toBe('environment_missing');
    });

    it('fails when the workspace has lost access to Loops entirely', async () => {
      vi.mocked(loopsAccess.workspaceMayUseLoops).mockResolvedValue(false);
      const loop = await dueLoop(db);

      await loopScheduler.tick();

      expect(createSession).not.toHaveBeenCalled();
      const [run] = await runsFor(db, loop.id);
      expect(run.failureCode).toBe('loops_not_allowed');
    });
  });

  describe('the deployment kill switch', () => {
    it('fires nothing at all when it is pulled', async () => {
      process.env.LOOPS_ENABLED = 'false';
      await dueLoop(db);
      expect(await loopScheduler.tick()).toBe(0);
      expect(createSession).not.toHaveBeenCalled();
      delete process.env.LOOPS_ENABLED;
    });
  });
});
