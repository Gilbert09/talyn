import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import {
  CONCURRENT_BOX_LIMIT_ERROR_CODE,
  PLAN_LIMITS,
  SIZE_REQUIRES_PRO_ERROR_CODE,
  USAGE_EXHAUSTED_ERROR_CODE,
  type PlanTier,
} from '@talyn/shared';
import type { UsageBudget } from '../../services/billing/usage/charge.js';

const { getBudget } = vi.hoisted(() => ({ getBudget: vi.fn() }));
vi.mock('../../services/billing/usage/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/billing/usage/index.js')>()),
  getBudget,
}));

import { taskRoutes } from '../../routes/tasks.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  environments as environmentsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
  users as usersTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { resetBoxDeferralsForTests } from '../../services/billing/boxDeferral.js';

/**
 * Every task path a person takes (create, retry, start, PATCH to an active
 * status) answers each box refusal with a 402 that carries the notice, so
 * both apps can open the upgrade or buy-credits prompt. The gate sees the
 * run's real size and whether it runs a metered box at all.
 */

const headers = { ...internalProxyHeaders(TEST_USER_ID), 'content-type': 'application/json' };
const savedPolar = process.env.POLAR_ACCESS_TOKEN;
const PERIOD_END = new Date('2026-12-01T00:00:00.000Z');

function budget(tier: PlanTier, exhausted: boolean): UsageBudget {
  return {
    tier,
    period: { start: new Date('2026-11-01T00:00:00.000Z'), end: PERIOD_END },
    includedWsec: PLAN_LIMITS[tier].includedBoxHours * 3600,
    usedWsec: 0,
    includedLeftWsec: exhausted ? 0 : 3600,
    creditMicros: 0,
    autoTopupPossible: false,
    exhausted,
  };
}

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/tasks', requireAuth, wrapAsyncRoutes(taskRoutes()));
  app.use(apiErrorHandler);
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((res) => {
        server.closeAllConnections();
        server.close(() => res());
      }),
  };
}

type Refusal = 'exhausted' | 'box cap' | 'size';
const EXPECTED_CODE: Record<Refusal, string> = {
  exhausted: USAGE_EXHAUSTED_ERROR_CODE,
  'box cap': CONCURRENT_BOX_LIMIT_ERROR_CODE,
  size: SIZE_REQUIRES_PRO_ERROR_CODE,
};

describe('the box gate at the task routes', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;
  let seq = 0;

  async function insertTask(status: string, extra: Partial<typeof tasksTable.$inferInsert> = {}): Promise<string> {
    const id = `task-${++seq}`;
    await db.insert(tasksTable).values({
      id,
      workspaceId: 'ws1',
      type: 'code_writing',
      status,
      title: 't',
      description: 'd',
      repositoryId: 'repo1',
      ...extra,
    });
    return id;
  }

  /** Put the owner into the state that makes the gate refuse this way. */
  async function arrange(refusal: Refusal): Promise<void> {
    if (refusal === 'exhausted') getBudget.mockResolvedValue(budget('free', true));
    if (refusal === 'box cap') {
      for (let i = 0; i < PLAN_LIMITS.free.concurrentBoxes; i++) await insertTask('queued');
    }
    // The repository asks for a box the Free plan cannot start.
    if (refusal === 'size') {
      await db.update(repositoriesTable).set({ settings: { sandboxSize: 'large' } }).where(eq(repositoriesTable.id, 'repo1'));
    }
  }

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
    getBudget.mockReset();
    getBudget.mockResolvedValue(budget('free', false));
    resetBoxDeferralsForTests();
    await seedUser(db);
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} });
    // A chosen size, so sizing the repository never reads GitHub.
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'repo',
      url: 'https://github.com/x/y',
      settings: { sandboxSize: 'standard' },
    });
    await db.insert(environmentsTable).values([
      { id: 'env-phc', ownerId: TEST_USER_ID, name: 'PostHog Code', type: 'posthog_code', config: {} },
      { id: 'env-fleet', ownerId: TEST_USER_ID, name: 'Talyn Fleet', type: 'selfhosted', config: {} },
    ]);
    ({ url, close } = await makeServer());
  });

  afterEach(async () => {
    if (savedPolar === undefined) delete process.env.POLAR_ACCESS_TOKEN;
    else process.env.POLAR_ACCESS_TOKEN = savedPolar;
    await close();
    await cleanup();
  });

  const createBody = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ workspaceId: 'ws1', type: 'code_writing', title: 'new', description: 'd', repositoryId: 'repo1', ...extra });

  const paths = {
    create: async () => fetch(`${url}/tasks`, { method: 'POST', headers, body: createBody() }),
    retry: async (id: string) => fetch(`${url}/tasks/${id}/retry`, { method: 'POST', headers }),
    start: async (id: string) => fetch(`${url}/tasks/${id}/start`, { method: 'POST', headers }),
    patch: async (id: string) =>
      fetch(`${url}/tasks/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'queued' }) }),
  } as const;

  const cases = (Object.keys(paths) as Array<keyof typeof paths>).flatMap((path) =>
    (['exhausted', 'box cap', 'size'] as Refusal[]).map((refusal) => ({ path, refusal }))
  );

  it.each(cases)('$path: $refusal → 402 with the code and the notice', async ({ path, refusal }) => {
    const target = path === 'create' ? '' : await insertTask('failed');
    await arrange(refusal);
    const before = await db.select({ id: tasksTable.id }).from(tasksTable);

    const res = await paths[path](target);

    expect(res.status).toBe(402);
    const body = (await res.json()) as { success: boolean; error: string; code: string; notice: { code: string; message: string; workspaceId?: string } };
    expect(body.success).toBe(false);
    expect(body.code).toBe(EXPECTED_CODE[refusal]);
    expect(body.notice.code).toBe(EXPECTED_CODE[refusal]);
    expect(body.notice.message).toBe(body.error);
    expect(body.notice.workspaceId).toBe('ws1');
    // Nothing started: no new row, and a re-activated task kept its status.
    expect(await db.select({ id: tasksTable.id }).from(tasksTable)).toHaveLength(before.length);
    if (target) {
      const [row] = await db.select({ status: tasksTable.status }).from(tasksTable).where(eq(tasksTable.id, target));
      expect(row?.status).toBe('failed');
    }
  });

  it.each(Object.keys(paths) as Array<keyof typeof paths>)('%s passes with budget, a free slot and an allowed size', async (path) => {
    const target = path === 'create' ? '' : await insertTask('failed');
    const res = await paths[path](target);
    expect(res.status).toBeLessThan(300);
  });

  describe('a task on PostHog Code runs no box', () => {
    it('creates with no hours left, at a size the plan cannot start', async () => {
      await arrange('exhausted');
      await arrange('size');
      const res = await fetch(`${url}/tasks`, { method: 'POST', headers, body: createBody({ assignedEnvironmentId: 'env-phc' }) });
      expect(res.status).toBe(201);
    });

    it('still counts against the concurrent-box cap', async () => {
      await arrange('box cap');
      const res = await fetch(`${url}/tasks`, { method: 'POST', headers, body: createBody({ assignedEnvironmentId: 'env-phc' }) });
      expect(res.status).toBe(402);
      expect(((await res.json()) as { code: string }).code).toBe(CONCURRENT_BOX_LIMIT_ERROR_CODE);
    });

    it('re-activates with no hours left', async () => {
      const id = await insertTask('failed', { assignedEnvironmentId: 'env-phc' });
      await arrange('exhausted');
      expect((await paths.retry(id)).status).toBe(200);
    });

    it('a fleet task does not', async () => {
      await arrange('exhausted');
      const res = await fetch(`${url}/tasks`, { method: 'POST', headers, body: createBody({ assignedEnvironmentId: 'env-fleet' }) });
      expect(res.status).toBe(402);
    });
  });

  it('re-activating an unattended (loop) task by hand checks its small box, attended', async () => {
    // A loop task's box is small whatever the repository asks for; a person
    // retrying it is checked at that size and answered with a 402.
    await arrange('size');
    const id = await insertTask('failed', { metadata: { source: 'loop' } });
    expect((await paths.retry(id)).status).toBe(200);
    await db.update(tasksTable).set({ status: 'failed' }).where(eq(tasksTable.id, id));
    await arrange('exhausted');
    expect((await paths.retry(id)).status).toBe(402);
  });

  it('a person is never handed a held refusal: credits that just arrived count at once', async () => {
    await arrange('exhausted');
    expect((await paths.create()).status).toBe(402);
    getBudget.mockResolvedValue(budget('free', false));
    expect((await paths.create()).status).toBe(201);
  });

  it('a comp (Pro) owner may start any size', async () => {
    await db.update(usersTable).set({ planOverride: 'pro' }).where(eq(usersTable.id, TEST_USER_ID));
    getBudget.mockResolvedValue(budget('pro', false));
    await arrange('size');
    expect((await paths.create()).status).toBe(201);
  });
});
