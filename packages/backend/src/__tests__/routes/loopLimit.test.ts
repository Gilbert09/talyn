import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { LOOP_LIMIT_ERROR_CODE, validateLoop } from '@talyn/shared';
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
 * POST /loops has no plan cap any more: usage billing removed the free plan's
 * three-loop limit. These tests pin that a loop is never refused for a count,
 * on any tier, with billing on or off. Uses the REAL apiErrorHandler.
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

describe('POST /loops has no plan cap', () => {
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

  // Usage billing removed the loop cap (it was 3 on the free plan). A loop
  // keeps a schedule and spends nothing until it fires; each firing is a box,
  // gated by withBoxGate where the task is created.
  const MANY = 8;

  it.each([
    { label: 'free', set: {} },
    { label: 'old Unlimited subscriber', set: { plan: 'unlimited' } },
    { label: 'comp', set: { planOverride: 'unlimited' } },
    { label: 'pro override', set: { planOverride: 'pro' } },
  ])('a $label owner keeps any number of loops across workspaces', async ({ set }) => {
    if (Object.keys(set).length) await db.update(usersTable).set(set).where(eq(usersTable.id, TEST_USER_ID));
    for (let i = 0; i < MANY; i++) {
      expect((await post({ workspaceId: i % 2 === 0 ? 'ws-mine' : 'ws-second' })).status).toBe(200);
    }
    expect((await countIn('ws-mine')) + (await countIn('ws-second'))).toBe(MANY);
  });

  it('disabled loops are never refused either', async () => {
    for (let i = 0; i < MANY; i++) expect((await post({ enabled: false })).status).toBe(200);
  });

  it('another owner’s loops change nothing', async () => {
    for (let i = 0; i < MANY; i++) {
      await createLoop(
        'ws-theirs',
        validateLoop(body({ workspaceId: 'ws-theirs', repositoryId: 'repo-theirs', repoFullName: 'acme/other' }))
      );
    }
    expect((await post()).status).toBe(200);
  });

  it('is never refused with the old loop code, billing on or off', async () => {
    for (const billing of [true, false]) {
      if (billing) process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
      else delete process.env.POLAR_ACCESS_TOKEN;
      for (let i = 0; i < 4; i++) {
        const res = await post();
        expect(res.status).toBe(200);
        expect(((await res.json()) as { code?: string }).code).not.toBe(LOOP_LIMIT_ERROR_CODE);
      }
    }
  });
});
