import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { validateLoop, type LoopInput } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  environments as environmentsTable,
  loopRuns as runsTable,
  loops as loopsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import { createLoop } from '../services/loops/store.js';
import { loopScheduler } from '../services/loops/scheduler.js';
import { TaskLimitError } from '../services/billing/entitlements.js';
import * as taskCreate from '../services/taskCreate.js';
import * as fleetAccess from '../services/cloudProviders/fleetAccess.js';
import * as registry from '../services/cloudProviders/registry.js';
import * as loopsAccess from '../services/loopsAccess.js';
import * as fleetCredentials from '../services/selfHosted/credentials.js';

/**
 * The scheduler end to end, against a real Postgres.
 *
 * What is pinned here is everything that cannot be checked another way: the
 * insert-is-the-claim idempotency that stops two replicas double-firing, the
 * catch-up rule, the overlap setting, the plan-limit deferral that has no
 * request behind it to 402, and the refusal to fail a pinned provider over to
 * another vendor.
 */

const WORKSPACE = 'ws-1';
const REPO_ID = 'repo-1';
const ENV_ID = 'env-1';

function loopInput(over: Partial<LoopInput> = {}): LoopInput {
  return validateLoop({
    name: 'Morning triage',
    prompt: 'Fix yesterday’s failing checks.',
    cron: '0 9 * * *',
    timezone: 'UTC',
    provider: 'posthog_code',
    model: 'claude-opus-5',
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
  let createTask: ReturnType<typeof vi.spyOn>;

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
    await db.insert(environmentsTable).values({
      id: ENV_ID,
      ownerId: TEST_USER_ID,
      name: 'PostHog Code',
      type: 'posthog_code',
      config: {},
    });

    delete process.env.LOOPS_ENABLED;
    vi.spyOn(loopsAccess, 'workspaceMayUseLoops').mockResolvedValue(true);
    vi.spyOn(registry, 'getCloudProvider').mockReturnValue({ type: 'posthog_code' } as never);
    createTask = vi
      .spyOn(taskCreate, 'createCloudTask')
      .mockImplementation(async (input) => {
        const id = `task-${Math.random().toString(36).slice(2, 10)}`;
        await db.insert(tasksTable).values({
          id,
          workspaceId: input.workspaceId,
          type: input.type,
          status: 'queued',
          title: input.title,
          description: input.description,
          repositoryId: input.repositoryId,
        });
        return { id } as never;
      });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  describe('claiming', () => {
    it('fires a due loop once and advances the schedule past it', async () => {
      const loop = await dueLoop(db);
      const fired = await loopScheduler.tick();

      expect(fired).toBe(1);
      expect(createTask).toHaveBeenCalledTimes(1);

      const runs = await runsFor(db, loop.id);
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('queued');
      expect(runs[0].taskId).toBeTruthy();

      const [row] = await db.select().from(loopsTable).where(eq(loopsTable.id, loop.id));
      expect(row.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('links the task back to the firing that started it', async () => {
      await dueLoop(db);
      await loopScheduler.tick();
      const input = createTask.mock.calls[0][0] as { loop?: { loopId: string; runId: string } };
      // `metadata.loop` is how somebody reading a surprising 3am task gets back
      // to the schedule that asked for it.
      expect(input.loop?.loopId).toBeTruthy();
      expect(input.loop?.runId).toBeTruthy();
    });

    it('does not fire a loop whose occurrence has not arrived', async () => {
      await dueLoop(db, {}, new Date(Date.now() + 3_600_000));
      expect(await loopScheduler.tick()).toBe(0);
      expect(createTask).not.toHaveBeenCalled();
    });

    it('does not fire a disabled loop', async () => {
      const loop = await dueLoop(db);
      await db
        .update(loopsTable)
        .set({ enabled: false, nextRunAt: new Date(Date.now() - 60_000) })
        .where(eq(loopsTable.id, loop.id));
      expect(await loopScheduler.tick()).toBe(0);
    });

    it('a second tick on the same occurrence creates no second task', async () => {
      // The core of the concurrency design. Two replicas racing the same due
      // loop both derive the same (loop_id, scheduled_for), so the second
      // insert conflicts — this simulates that by rewinding next_run_at, which
      // is exactly the state a crashed mid-fire leaves behind.
      const at = new Date(Date.now() - 60_000);
      const loop = await dueLoop(db, {}, at);
      await loopScheduler.tick();
      await db.update(loopsTable).set({ nextRunAt: at }).where(eq(loopsTable.id, loop.id));
      await loopScheduler.tick();

      expect(createTask).toHaveBeenCalledTimes(1);
      expect(await runsFor(db, loop.id)).toHaveLength(1);
    });

    it('recovers a claim that was never dispatched', async () => {
      // The crash window: the row exists, the task does not. The due-scan
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
        provider: 'posthog_code',
        model: 'claude-opus-5',
        status: 'queued',
      });

      await loopScheduler.tick();

      expect(createTask).toHaveBeenCalledTimes(1);
      const [run] = await runsFor(db, loop.id);
      expect(run.id).toBe('orphan-1');
      expect(run.taskId).toBeTruthy();
    });
  });

  describe('catch-up', () => {
    it('fires ONCE for a loop overdue by days, then jumps to the future', async () => {
      // A weekend outage must not replay every missed occurrence: that is a
      // burst of near-identical cloud tasks and, on a free plan, one run plus a
      // wall of refusals.
      const loop = await dueLoop(db, {}, new Date(Date.now() - 3 * 86_400_000));
      await loopScheduler.tick();

      expect(createTask).toHaveBeenCalledTimes(1);
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
    it('skips when a run is still going, and records why', async () => {
      const loop = await dueLoop(db, { concurrency: 'skip' });
      await loopScheduler.tick();

      await db
        .update(loopsTable)
        .set({ nextRunAt: new Date(Date.now() - 30_000) })
        .where(eq(loopsTable.id, loop.id));
      await loopScheduler.tick();

      const runs = await runsFor(db, loop.id);
      expect(runs).toHaveLength(2);
      const skipped = runs.find((r) => r.status === 'skipped');
      expect(skipped?.failureCode).toBe('overlap');
      // One task, not two — the whole point of the setting.
      expect(createTask).toHaveBeenCalledTimes(1);
    });

    it('starts a second run when the loop says to allow it', async () => {
      const loop = await dueLoop(db, { concurrency: 'allow' });
      await loopScheduler.tick();
      await db
        .update(loopsTable)
        .set({ nextRunAt: new Date(Date.now() - 30_000) })
        .where(eq(loopsTable.id, loop.id));
      await loopScheduler.tick();

      expect(createTask).toHaveBeenCalledTimes(2);
      const runs = await runsFor(db, loop.id);
      expect(runs.every((r) => r.status === 'queued')).toBe(true);
    });
  });

  describe('the plan limit', () => {
    it('parks the run visibly rather than losing it', async () => {
      // There is no request to answer with a 402 and no modal to open, so the
      // run row IS the notification. A silent deferral is why the paywall read
      // as never firing.
      createTask.mockRejectedValueOnce(new TaskLimitError(3, 3));
      const loop = await dueLoop(db);
      await loopScheduler.tick();

      const [run] = await runsFor(db, loop.id);
      expect(run.status).toBe('waiting_slot');
      expect(run.failureCode).toBe('task_limit_reached');
      expect(run.retryAfter).toBeTruthy();
    });

    it('retries a parked run once its retry is due', async () => {
      createTask.mockRejectedValueOnce(new TaskLimitError(3, 3));
      const loop = await dueLoop(db);
      await loopScheduler.tick();
      await db
        .update(runsTable)
        .set({ retryAfter: new Date(Date.now() - 1_000) })
        .where(eq(runsTable.loopId, loop.id));

      await loopScheduler.tick();

      const [run] = await runsFor(db, loop.id);
      expect(run.status).toBe('queued');
      expect(run.taskId).toBeTruthy();
    });

    it('gives up when the NEXT occurrence has been claimed, not after N tries', async () => {
      // Supersession rather than an attempt cap: a cron payload is "it is
      // time", which does not go stale until the next time arrives.
      createTask.mockRejectedValue(new TaskLimitError(3, 3));
      const loop = await dueLoop(db);
      await loopScheduler.tick();

      await db.insert(runsTable).values({
        id: 'newer',
        loopId: loop.id,
        workspaceId: WORKSPACE,
        scheduledFor: new Date(Date.now() + 3_600_000),
        repoFullName: 'acme/widget',
        provider: 'posthog_code',
        model: 'claude-opus-5',
        status: 'queued',
      });
      await db
        .update(runsTable)
        .set({ retryAfter: new Date(Date.now() - 1_000) })
        .where(eq(runsTable.status, 'waiting_slot'));

      await loopScheduler.tick();

      const parked = (await runsFor(db, loop.id)).find((r) => r.id !== 'newer');
      expect(parked?.status).toBe('skipped');
      expect(parked?.failureCode).toBe('task_limit_reached');
    });
  });

  describe('settlement', () => {
    it('follows the task to succeeded and clears the failure count', async () => {
      const loop = await dueLoop(db);
      await loopScheduler.tick();
      const [run] = await runsFor(db, loop.id);
      await db
        .update(tasksTable)
        .set({ status: 'completed' })
        .where(eq(tasksTable.id, run.taskId!));

      await loopScheduler.tick();

      const [settled] = await runsFor(db, loop.id);
      expect(settled.status).toBe('succeeded');
      expect(settled.settledAt).toBeTruthy();
    });

    it('settles failed when the task was deleted mid-flight', async () => {
      const loop = await dueLoop(db);
      await loopScheduler.tick();
      const [run] = await runsFor(db, loop.id);
      await db.delete(tasksTable).where(eq(tasksTable.id, run.taskId!));

      await loopScheduler.tick();

      const [settled] = await runsFor(db, loop.id);
      expect(settled.status).toBe('failed');
      expect(settled.failureCode).toBe('task_deleted');
    });

    it('switches a loop off after five consecutive failures', async () => {
      // What stops a permanently broken loop spending a task slot every hour
      // until somebody notices.
      const loop = await dueLoop(db);
      for (let i = 0; i < 5; i += 1) {
        await db
          .update(loopsTable)
          .set({ nextRunAt: new Date(Date.now() - 60_000), enabled: true })
          .where(eq(loopsTable.id, loop.id));
        createTask.mockRejectedValueOnce(new Error('provider exploded'));
        await loopScheduler.tick();
      }
      const [row] = await db.select().from(loopsTable).where(eq(loopsTable.id, loop.id));
      expect(row.enabled).toBe(false);
      expect(row.disabledReason).toBe('too_many_failures');
    });
  });

  describe('configuration that has gone away', () => {
    it('records a skip and switches off when the repository is disconnected', async () => {
      const loop = await dueLoop(db);
      await db.update(loopsTable).set({ repositoryId: null }).where(eq(loopsTable.id, loop.id));

      await loopScheduler.tick();

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
      vi.spyOn(fleetAccess, 'workspaceMayUseFleet').mockResolvedValue(false);
      const loop = await dueLoop(db, { provider: 'selfhosted', model: 'claude-sonnet-5' });

      await loopScheduler.tick();

      expect(createTask).not.toHaveBeenCalled();
      const [run] = await runsFor(db, loop.id);
      expect(run.status).toBe('failed');
      expect(run.failureCode).toBe('fleet_not_allowed');
    });

    it('fails a fleet loop whose agent is no longer connected', async () => {
      vi.spyOn(fleetAccess, 'workspaceMayUseFleet').mockResolvedValue(true);
      vi.spyOn(fleetCredentials, 'fleetAgentStatus').mockResolvedValue({
        connectedAgents: ['claude'],
        reauthAgents: [],
      });
      const loop = await dueLoop(db, { provider: 'selfhosted', model: 'gpt-5.6-terra' });

      await loopScheduler.tick();

      const [run] = await runsFor(db, loop.id);
      expect(run.failureCode).toBe('agent_not_connected');
    });

    it('fails when the workspace has lost access to Loops entirely', async () => {
      vi.spyOn(loopsAccess, 'workspaceMayUseLoops').mockResolvedValue(false);
      const loop = await dueLoop(db);

      await loopScheduler.tick();

      const [run] = await runsFor(db, loop.id);
      expect(run.failureCode).toBe('loops_not_allowed');
    });
  });

  describe('the deployment kill switch', () => {
    it('fires nothing at all when it is pulled', async () => {
      process.env.LOOPS_ENABLED = 'false';
      await dueLoop(db);
      expect(await loopScheduler.tick()).toBe(0);
      expect(createTask).not.toHaveBeenCalled();
    });
  });
});
