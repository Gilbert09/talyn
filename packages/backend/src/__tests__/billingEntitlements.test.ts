import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import {
  tasks as tasksTable,
  users as usersTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import {
  ACTIVE_TASK_STATUSES,
  FREE_ACTIVE_TASK_LIMIT,
  TaskLimitError,
  assertCanActivateTask,
  countActiveTasks,
  resolveEntitlement,
  withTaskLimitGate,
} from '../services/billing/entitlements.js';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';

let db: Database;
let cleanup: () => Promise<void>;
let taskSeq = 0;
const savedPolarToken = process.env.POLAR_ACCESS_TOKEN;

const OTHER_USER_ID = 'user-other';

async function insertTask(workspaceId: string, status: string): Promise<string> {
  const id = `task-${++taskSeq}`;
  await db.insert(tasksTable).values({
    id,
    workspaceId,
    type: 'code_writing',
    status,
    title: 't',
    description: 'd',
  });
  return id;
}

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  // Billing "configured" for these tests — enforcement on.
  process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
  await seedUser(db);
  await seedUser(db, { id: OTHER_USER_ID });
  // The free limit spans ALL workspaces an owner has, so seed two for the
  // subject user plus one for a bystander.
  for (const [id, ownerId] of [
    ['ws1', TEST_USER_ID],
    ['ws2', TEST_USER_ID],
    ['ws-other', OTHER_USER_ID],
  ] as const) {
    await db.insert(workspacesTable).values({ id, ownerId, name: id, settings: {} });
  }
});

afterEach(async () => {
  if (savedPolarToken === undefined) delete process.env.POLAR_ACCESS_TOKEN;
  else process.env.POLAR_ACCESS_TOKEN = savedPolarToken;
  await cleanup();
});

describe('resolveEntitlement', () => {
  it.each([
    { plan: 'free', planOverride: null, expected: { plan: 'free', source: 'default' } },
    {
      plan: 'unlimited',
      planOverride: null,
      expected: { plan: 'unlimited', source: 'subscription' },
    },
    {
      plan: 'free',
      planOverride: 'unlimited',
      expected: { plan: 'unlimited', source: 'override' },
    },
    // Override wins in BOTH directions — it's a manual pin, not a floor.
    { plan: 'unlimited', planOverride: 'free', expected: { plan: 'free', source: 'override' } },
  ])(
    'plan=$plan override=$planOverride → $expected.plan ($expected.source)',
    async ({ plan, planOverride, expected }) => {
      await db
        .update(usersTable)
        .set({ plan, planOverride })
        .where(eq(usersTable.id, TEST_USER_ID));
      expect(await resolveEntitlement(TEST_USER_ID)).toEqual(expected);
    }
  );

  it('unknown user resolves to free/default', async () => {
    expect(await resolveEntitlement('user-nonexistent')).toEqual({
      plan: 'free',
      source: 'default',
    });
  });

  it('billing env absent → unlimited (enforcement disabled)', async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    expect(await resolveEntitlement(TEST_USER_ID)).toEqual({
      plan: 'unlimited',
      source: 'billing_disabled',
    });
  });
});

describe('countActiveTasks', () => {
  it.each(ACTIVE_TASK_STATUSES.map((status) => ({ status })))(
    'counts $status tasks',
    async ({ status }) => {
      await insertTask('ws1', status);
      expect(await countActiveTasks(TEST_USER_ID)).toBe(1);
    }
  );

  it.each([{ status: 'completed' }, { status: 'failed' }, { status: 'cancelled' }])(
    'ignores terminal $status tasks',
    async ({ status }) => {
      await insertTask('ws1', status);
      expect(await countActiveTasks(TEST_USER_ID)).toBe(0);
    }
  );

  it('spans every workspace the owner has, ignoring other owners', async () => {
    await insertTask('ws1', 'queued');
    await insertTask('ws2', 'in_progress');
    await insertTask('ws-other', 'queued');
    expect(await countActiveTasks(TEST_USER_ID)).toBe(2);
    expect(await countActiveTasks(OTHER_USER_ID)).toBe(1);
  });

  it('excludeTaskId drops the named task from the count', async () => {
    const id = await insertTask('ws1', 'queued');
    await insertTask('ws1', 'queued');
    expect(await countActiveTasks(TEST_USER_ID, id)).toBe(1);
  });
});

describe('withTaskLimitGate', () => {
  it.each([{ active: 0 }, { active: 1 }, { active: 2 }])(
    'free user with $active active tasks passes',
    async ({ active }) => {
      for (let i = 0; i < active; i++) await insertTask('ws1', 'queued');
      const result = await withTaskLimitGate(TEST_USER_ID, {}, async () => 'created');
      expect(result).toBe('created');
    }
  );

  it(`free user at the limit (${FREE_ACTIVE_TASK_LIMIT}) throws TaskLimitError and fn never runs`, async () => {
    for (let i = 0; i < FREE_ACTIVE_TASK_LIMIT; i++) await insertTask('ws1', 'queued');
    let ran = false;
    const attempt = withTaskLimitGate(TEST_USER_ID, {}, async () => {
      ran = true;
    });
    await expect(attempt).rejects.toThrowError(TaskLimitError);
    await expect(
      withTaskLimitGate(TEST_USER_ID, {}, async () => undefined)
    ).rejects.toMatchObject({
      code: 'task_limit_reached',
      limit: FREE_ACTIVE_TASK_LIMIT,
      active: FREE_ACTIVE_TASK_LIMIT,
    });
    expect(ran).toBe(false);
  });

  it('limit spans workspaces (2 in ws1 + 1 in ws2 blocks)', async () => {
    await insertTask('ws1', 'queued');
    await insertTask('ws1', 'in_progress');
    await insertTask('ws2', 'pending');
    await expect(
      withTaskLimitGate(TEST_USER_ID, {}, async () => undefined)
    ).rejects.toThrowError(TaskLimitError);
  });

  it.each([
    { label: 'subscription', plan: 'unlimited', planOverride: null },
    { label: 'override (comped)', plan: 'free', planOverride: 'unlimited' },
  ])('$label user passes far beyond the limit', async ({ plan, planOverride }) => {
    await db
      .update(usersTable)
      .set({ plan, planOverride })
      .where(eq(usersTable.id, TEST_USER_ID));
    for (let i = 0; i < FREE_ACTIVE_TASK_LIMIT + 2; i++) await insertTask('ws1', 'queued');
    const result = await withTaskLimitGate(TEST_USER_ID, {}, async () => 'created');
    expect(result).toBe('created');
  });

  it('billing env absent → no enforcement even at the limit', async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    for (let i = 0; i < FREE_ACTIVE_TASK_LIMIT; i++) await insertTask('ws1', 'queued');
    const result = await withTaskLimitGate(TEST_USER_ID, {}, async () => 'created');
    expect(result).toBe('created');
  });

  it('terminal tasks free their slot', async () => {
    const ids: string[] = [];
    for (let i = 0; i < FREE_ACTIVE_TASK_LIMIT; i++) ids.push(await insertTask('ws1', 'queued'));
    await expect(
      withTaskLimitGate(TEST_USER_ID, {}, async () => undefined)
    ).rejects.toThrowError(TaskLimitError);
    await db
      .update(tasksTable)
      .set({ status: 'completed' })
      .where(eq(tasksTable.id, ids[0]));
    const result = await withTaskLimitGate(TEST_USER_ID, {}, async () => 'created');
    expect(result).toBe('created');
  });
});

describe('assertCanActivateTask', () => {
  it('re-activating an inactive task while 3 others are active throws', async () => {
    for (let i = 0; i < FREE_ACTIVE_TASK_LIMIT; i++) await insertTask('ws1', 'queued');
    const failedId = await insertTask('ws1', 'failed');
    await expect(assertCanActivateTask(TEST_USER_ID, failedId)).rejects.toThrowError(
      TaskLimitError
    );
  });

  it('idempotent re-queue of a still-active task never self-blocks', async () => {
    const ids: string[] = [];
    for (let i = 0; i < FREE_ACTIVE_TASK_LIMIT; i++) ids.push(await insertTask('ws1', 'queued'));
    // 3/3 active, but the task being (re)activated is one of them.
    await expect(assertCanActivateTask(TEST_USER_ID, ids[0])).resolves.toBeUndefined();
  });

  it('passes when a slot is free', async () => {
    await insertTask('ws1', 'queued');
    const failedId = await insertTask('ws1', 'failed');
    await expect(assertCanActivateTask(TEST_USER_ID, failedId)).resolves.toBeUndefined();
  });
});
