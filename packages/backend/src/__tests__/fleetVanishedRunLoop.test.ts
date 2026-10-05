import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockClient } = vi.hoisted(() => ({
  mockClient: {
    getSandbox: vi.fn(),
    getEvents: vi.fn(),
  },
}));
vi.mock('../services/selfHosted/credentials.js', () => ({
  getSelfHostedClient: vi.fn(async () => mockClient),
  getSelfHostedCredentials: vi.fn(async () => ({ claudeToken: 'sk-ant-oat01-x' })),
}));

import { eq } from 'drizzle-orm';
import { selfHostedPoller } from '../services/selfHosted/poller.js';
import { FleetRunNotFoundError } from '../services/selfHosted/client.js';
import { _resetTaskWatch } from '../services/cloudProviders/taskWatch.js';
import { drainTaskMetadata } from '../services/taskMetadataMutex.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import * as schema from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { CloudTaskRow } from '../services/cloudProviders/types.js';
import type { TaskStatus } from '@talyn/shared';

const WS = 'ws-1';
const RUN = 'talyn-21dfd550-0000-0000-0000-000000000000';

/**
 * The vanished-run retry loop, closed for the second time.
 *
 * 2026-08-06: a host restarted mid-run and two tasks reconciled every tick for
 * 21 hours, because nothing concluded that a run a reachable host denies is
 * never coming back. The fix was `failVanishedRun` — terminal, not retryable —
 * and `fleetRunNotFound.test.ts` pins the detection it rests on.
 *
 * 2026-10-05: the same loop, by a route that did not exist in August. The
 * generic poller had since grown a third selection branch — EVERY terminal task
 * whose `updatedAt` is inside a 30-minute window and whose transcript is not
 * yet marked final — so it could hand a terminal task back to a provider. Two
 * things then combined:
 *
 *   - the fleet's reconcile had no terminal guard, so it re-asked the host
 *     about a run it had already given up on;
 *   - `failVanishedRun` writes `updatedAt: now`, which is the column that
 *     window is bounded by.
 *
 * So the row re-armed the window that selected it, on every pass, for ever.
 * Fourteen tasks were in it, one fleet round trip each per tick; three quarters
 * of the backend's log volume; and `cloudPoller:tick` exceeded its 300s budget
 * on every single tick, so no pass over the genuinely live tasks ever finished.
 *
 * What is pinned here is the property that kills the loop whichever way it is
 * entered: a terminal task must leave a reconcile with the backfill marker set
 * and its `updatedAt` untouched.
 */
function vanishedRow(id: string, status: TaskStatus = 'in_progress'): CloudTaskRow {
  return {
    id,
    workspaceId: WS,
    title: 'Get PostHog/posthog#111880 mergeable',
    repositoryId: null,
    metadata: { cloudTask: { provider: 'selfhosted', status: 'running', remoteTaskId: RUN } },
    transcriptFinal: false,
    watched: false,
    status,
    completedAt: null,
    updatedAt: new Date(Date.now() - 60_000),
  };
}

async function seedTask(
  db: Database,
  id: string,
  values: Partial<typeof schema.tasks.$inferInsert> = {},
): Promise<void> {
  await db.insert(schema.tasks).values({
    id,
    workspaceId: WS,
    type: 'code_writing',
    status: 'in_progress',
    title: 'Get PostHog/posthog#111880 mergeable',
    description: 'D',
    metadata: { cloudTask: { provider: 'selfhosted', status: 'running', remoteTaskId: RUN } },
    ...values,
  });
}

async function readTask(db: Database, id: string) {
  const rows = await db
    .select({
      status: schema.tasks.status,
      metadata: schema.tasks.metadata,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id));
  return rows[0];
}

describe('selfHostedPoller — a vanished run must not re-enter the backfill window', () => {
  let cleanup: () => Promise<void>;
  let db: Database;

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    cleanup = ctx.cleanup;
    mockClient.getSandbox.mockReset().mockRejectedValue(new FleetRunNotFoundError('no such sandbox'));
    mockClient.getEvents.mockReset().mockResolvedValue({ events: [] });
    _resetTaskWatch();
    await seedUser(db);
    await db.insert(schema.workspaces).values({ id: WS, ownerId: 'user-test', name: 'WS' });
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    await cleanup();
  });

  // The marker is what the generic poller's backfill branch selects on. Without
  // it the row qualifies for ever, because the fail itself refreshes the
  // timestamp that bounds the window.
  it('marks the transcript final, because no event log is ever coming', async () => {
    const id = 'task-vanished';
    await seedTask(db, id);

    await selfHostedPoller.reconcileTask(vanishedRow(id));
    await drainTaskMetadata(id);

    const t = await readTask(db, id);
    expect(t?.status).toBe('failed');
    expect((t?.metadata as Record<string, unknown>).transcriptFinal).toBe(true);
  });

  // The loop, stated directly: the second pass is what used to re-fail the task
  // and re-arm the window. A terminal row must not reach the host at all.
  it('does not ask the host again once the task is already terminal', async () => {
    const id = 'task-vanished-twice';
    await seedTask(db, id);

    await selfHostedPoller.reconcileTask(vanishedRow(id));
    await drainTaskMetadata(id);
    expect(mockClient.getSandbox).toHaveBeenCalledTimes(1);

    const afterFirst = await readTask(db, id);

    // The generic poller hands the row back exactly as it now stands.
    await selfHostedPoller.reconcileTask(vanishedRow(id, 'failed'));
    await drainTaskMetadata(id);

    expect(mockClient.getSandbox).toHaveBeenCalledTimes(1);
    const afterSecond = await readTask(db, id);
    // The timestamp is the whole mechanism: refreshing it is what restarted the
    // 30-minute window on every pass.
    expect(afterSecond?.updatedAt?.getTime()).toBe(afterFirst?.updatedAt?.getTime());
  });

  // The guard must not eat the backfill it exists to serve. A task that went
  // terminal by some other route — cancelled from the API, failed by a watcher —
  // still has a log on the host worth storing, exactly once.
  it('still backfills a terminal task whose transcript is genuinely outstanding', async () => {
    const id = 'task-terminal-backfill';
    await seedTask(db, id, { status: 'cancelled' });

    await selfHostedPoller.reconcileTask(vanishedRow(id, 'cancelled'));
    await drainTaskMetadata(id);

    expect(mockClient.getEvents).toHaveBeenCalledTimes(1);
    expect(mockClient.getSandbox).not.toHaveBeenCalled();
    const t = await readTask(db, id);
    expect(t?.status).toBe('cancelled');
    expect((t?.metadata as Record<string, unknown>).transcriptFinal).toBe(true);
  });
});
