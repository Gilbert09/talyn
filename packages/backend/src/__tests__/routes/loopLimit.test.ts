import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { FREE_PLAN_LOOP_LIMIT, LOOP_LIMIT_ERROR_CODE, validateLoop } from '@talyn/shared';
import { loopRoutes } from '../../routes/loops.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  environments as environmentsTable,
  repositories as reposTable,
  users as usersTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { createLoop } from '../../services/loops/store.js';
import * as loopsAccess from '../../services/loopsAccess.js';
import * as registry from '../../services/cloudProviders/registry.js';

/**
 * Free-plan loop cap at the route surface: POST /loops must 402 with
 * LOOP_LIMIT_ERROR_CODE once the owner keeps FREE_PLAN_LOOP_LIMIT loops —
 * counted across EVERY workspace they own, because the limit is per user and a
 * second workspace is free to make.
 *
 * The workflow cap's twin, and pinned separately rather than trusted to be the
 * same code: the two gates share `withFreePlanGate` but have their own counts,
 * their own error types and their own advisory-lock keys, and a copy-paste that
 * left one of those pointing at workflows would pass every workflow test.
 *
 * Uses the REAL apiErrorHandler, so the status/code contract pinned here is the
 * one production serves.
 */

const OTHER_USER_ID = 'user-other';
const headers = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};
const savedPolarToken = process.env.POLAR_ACCESS_TOKEN;

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/loops', requireAuth, wrapAsyncRoutes(loopRoutes()));
  app.use(apiErrorHandler);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('free-plan loop limit at the route surface', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;
  let seq = 0;

  function body(over: Record<string, unknown> = {}) {
    const workspaceId = (over.workspaceId as string) ?? 'ws-mine';
    return {
      workspaceId,
      name: `Loop ${++seq}`,
      prompt: 'Fix yesterday’s failing checks.',
      cron: '0 9 * * *',
      timezone: 'UTC',
      provider: 'posthog_code',
      model: 'claude-opus-5',
      repositoryId: workspaceId === 'ws-second' ? 'repo-second' : 'repo-mine',
      repoFullName: workspaceId === 'ws-second' ? 'acme/second' : 'acme/widget',
      ...over,
    };
  }

  function post(over: Record<string, unknown> = {}) {
    return fetch(`${url}/loops`, { method: 'POST', headers, body: JSON.stringify(body(over)) });
  }

  async function countIn(workspaceId: string): Promise<number> {
    const res = await fetch(`${url}/loops?workspaceId=${workspaceId}`, { headers });
    return ((await res.json()) as { data: unknown[] }).data.length;
  }

  /** Fill the owner's allowance, spread across both of their workspaces. */
  async function fillAllowance(): Promise<void> {
    for (let i = 0; i < FREE_PLAN_LOOP_LIMIT; i++) {
      const res = await post({ workspaceId: i % 2 === 0 ? 'ws-mine' : 'ws-second' });
      expect(res.status).toBe(200);
    }
  }

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
    delete process.env.LOOPS_ENABLED;
    seq = 0;
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await seedUser(db, { id: OTHER_USER_ID, email: 'other@example.test' });
    await db.insert(workspacesTable).values([
      { id: 'ws-mine', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
      { id: 'ws-second', ownerId: TEST_USER_ID, name: 'second', settings: {} },
      { id: 'ws-theirs', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
    ]);
    await db.insert(reposTable).values([
      {
        id: 'repo-mine',
        workspaceId: 'ws-mine',
        name: 'acme/widget',
        url: 'https://github.com/acme/widget',
        defaultBranch: 'main',
      },
      {
        id: 'repo-second',
        workspaceId: 'ws-second',
        name: 'acme/second',
        url: 'https://github.com/acme/second',
        defaultBranch: 'main',
      },
      {
        id: 'repo-theirs',
        workspaceId: 'ws-theirs',
        name: 'acme/other',
        url: 'https://github.com/acme/other',
        defaultBranch: 'main',
      },
    ]);
    await db.insert(environmentsTable).values({
      id: 'env-1',
      ownerId: TEST_USER_ID,
      name: 'PostHog Code',
      type: 'posthog_code',
      config: {},
    });
    vi.spyOn(loopsAccess, 'workspaceMayUseLoops').mockResolvedValue(true);
    vi.spyOn(registry, 'getCloudProvider').mockReturnValue({ type: 'posthog_code' } as never);
    ({ url, close } = await makeServer());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedPolarToken === undefined) delete process.env.POLAR_ACCESS_TOKEN;
    else process.env.POLAR_ACCESS_TOKEN = savedPolarToken;
    delete process.env.LOOPS_ENABLED;
    await close();
    await cleanup();
  });

  it('402s with the loop code once a free owner is at the limit', async () => {
    await fillAllowance();
    const res = await post();
    expect(res.status).toBe(402);
    const json = (await res.json()) as { code: string; error: string };
    // Its OWN code, not the workflow one — the client branches on this to pick
    // which upgrade pitch to show.
    expect(json.code).toBe(LOOP_LIMIT_ERROR_CODE);
    expect(json.error).toMatch(new RegExp(`${FREE_PLAN_LOOP_LIMIT} loops`));
    // Refused, not silently created.
    expect((await countIn('ws-mine')) + (await countIn('ws-second'))).toBe(FREE_PLAN_LOOP_LIMIT);
  });

  it('creates normally below the limit', async () => {
    for (let i = 0; i < FREE_PLAN_LOOP_LIMIT; i++) {
      expect((await post()).status).toBe(200);
    }
  });

  it('counts every workspace the owner has — a second one is not a second allowance', async () => {
    await fillAllowance();
    expect((await post({ workspaceId: 'ws-second' })).status).toBe(402);
  });

  it('another owner’s loops never eat a slot', async () => {
    // Seeded through the store rather than the route: these belong to a
    // workspace this caller cannot post to, which is exactly the point.
    for (let i = 0; i < FREE_PLAN_LOOP_LIMIT; i++) {
      await createLoop(
        'ws-theirs',
        validateLoop(
          body({
            workspaceId: 'ws-theirs',
            repositoryId: 'repo-theirs',
            repoFullName: 'acme/other',
          })
        )
      );
    }
    await fillAllowance();
    const res = await post();
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toMatch(
      new RegExp(`\\(${FREE_PLAN_LOOP_LIMIT} in use\\)`)
    );
  });

  it('a disabled loop still occupies its slot', async () => {
    // The cap is on how many schedules you KEEP. Counting only the enabled ones
    // would make it a toggle — keep twelve, run three, swap whenever.
    for (let i = 0; i < FREE_PLAN_LOOP_LIMIT; i++) {
      expect((await post({ enabled: false })).status).toBe(200);
    }
    expect((await post()).status).toBe(402);
  });

  it('editing an existing loop at the limit is never gated', async () => {
    await fillAllowance();
    const listed = await fetch(`${url}/loops?workspaceId=ws-mine`, { headers });
    const [first] = ((await listed.json()) as { data: { id: string }[] }).data;
    const res = await fetch(`${url}/loops/${first.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'Renamed at the limit', enabled: false }),
    });
    expect(res.status).toBe(200);
    // Switching it back ON is an edit too, not a new loop — otherwise a free
    // user at the cap could not re-enable the schedule they just paused.
    const back = await fetch(`${url}/loops/${first.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    expect(back.status).toBe(200);
  });

  it('running a loop by hand at the limit is never gated', async () => {
    // "Run now" starts work, it does not keep a schedule. Its own refusal — if
    // any — is the active-task limit, recorded on the run.
    await fillAllowance();
    const listed = await fetch(`${url}/loops?workspaceId=ws-mine`, { headers });
    const [first] = ((await listed.json()) as { data: { id: string }[] }).data;
    const res = await fetch(`${url}/loops/${first.id}/run`, { method: 'POST', headers });
    expect(res.status).toBe(200);
  });

  it('deleting a loop frees its slot', async () => {
    await fillAllowance();
    expect((await post()).status).toBe(402);
    const listed = await fetch(`${url}/loops?workspaceId=ws-mine`, { headers });
    const [first] = ((await listed.json()) as { data: { id: string }[] }).data;
    expect((await fetch(`${url}/loops/${first.id}`, { method: 'DELETE', headers })).status).toBe(
      200
    );
    expect((await post()).status).toBe(200);
  });

  it('the workflow allowance is not the loop allowance', async () => {
    // The two caps are independent: filling one must not refuse the other. A
    // gate that counted the wrong table would pass every other test here.
    await fillAllowance();
    const res = await post();
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).not.toMatch(/workflows/);
  });

  it('comped (plan_override) owners are unlimited', async () => {
    await db
      .update(usersTable)
      .set({ planOverride: 'unlimited' })
      .where(eq(usersTable.id, TEST_USER_ID));
    await fillAllowance();
    expect((await post()).status).toBe(200);
  });

  it('subscribed owners are unlimited', async () => {
    await db.update(usersTable).set({ plan: 'unlimited' }).where(eq(usersTable.id, TEST_USER_ID));
    await fillAllowance();
    expect((await post()).status).toBe(200);
  });

  it('is off entirely when billing is not configured', async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    await fillAllowance();
    expect((await post()).status).toBe(200);
  });
});
