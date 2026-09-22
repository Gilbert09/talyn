import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { pullRequestRoutes } from '../../routes/pullRequests.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';

/**
 * POST /pull-requests/:id/review-hidden — "I am not reviewing this one".
 *
 * The contracts worth pinning:
 *   - it is a VIEW decision: `review_requested` is untouched, so the review
 *     history and the monitor's reconcile keep working,
 *   - re-hiding keeps the ORIGINAL instant (the column answers "when did I
 *     decide to skip this"), and
 *   - a hidden row survives the un-watch delete. The row is the only record of
 *     the choice, and hiding is sticky — dropping it would silently unhide the
 *     PR the next time GitHub asks.
 */

const headers = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
  'x-talyn-client-version': '0.3.0-test',
};

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/pull-requests', requireAuth, wrapAsyncRoutes(pullRequestRoutes()));
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

describe('POST /pull-requests/:id/review-hidden', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;

  async function insertPr(over: Record<string, unknown> = {}): Promise<string> {
    const id = `pr-${Math.random().toString(36).slice(2, 9)}`;
    await db.insert(pullRequestsTable).values({
      id,
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'a',
      repo: 'b',
      number: 7,
      state: 'open',
      reviewRequested: true,
      lastPolledAt: new Date(),
      lastSummary: {},
      ...over,
    });
    return id;
  }

  function readRow(id: string) {
    return db
      .select()
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  function setHidden(id: string, hidden: boolean) {
    return fetch(`${url}/pull-requests/${id}/review-hidden`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ hidden }),
    });
  }

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db);
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws1',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'a/b',
      url: 'https://github.com/a/b',
      defaultBranch: 'main',
    });
    ({ url, close } = await makeServer());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await close();
    await cleanup();
  });

  it('stamps the hide and leaves the review request alone', async () => {
    const id = await insertPr();
    const res = await setHidden(id, true);
    expect(res.status).toBe(200);

    const row = await readRow(id);
    expect(row?.reviewHiddenAt).toBeInstanceOf(Date);
    // The user is still a requested reviewer on GitHub. Clearing this would
    // also break the review-history record, and the monitor would rewrite it
    // within a poll anyway.
    expect(row?.reviewRequested).toBe(true);
  });

  it('keeps the original instant when the same PR is hidden twice', async () => {
    const id = await insertPr();
    await setHidden(id, true);
    const first = (await readRow(id))?.reviewHiddenAt as Date;
    await setHidden(id, true);
    expect((await readRow(id))?.reviewHiddenAt).toEqual(first);
  });

  it('unhides on demand — the only thing that does', async () => {
    const id = await insertPr();
    await setHidden(id, true);
    const res = await setHidden(id, false);
    expect(res.status).toBe(200);
    expect((await readRow(id))?.reviewHiddenAt).toBeNull();
  });

  it('404s for a PR that is not there', async () => {
    const res = await setHidden('pr-missing', true);
    expect(res.status).toBe(404);
  });

  it('keeps a hidden row that un-watch would otherwise delete', async () => {
    // Nothing else references this row: not authored, no review request left
    // (reviewed on github.com), no task, no queue entry, no watcher. Without
    // the hide it is deleted — see POST /:id/watch.
    const id = await insertPr({ reviewRequested: false, watching: true });
    await setHidden(id, true);

    const res = await fetch(`${url}/pull-requests/${id}/watch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.deleted).toBe(false);
    const row = await readRow(id);
    expect(row).not.toBeNull();
    expect(row?.reviewHiddenAt).toBeInstanceOf(Date);
  });

  it('still deletes an unhidden row nothing references', async () => {
    const id = await insertPr({ reviewRequested: false, watching: true });
    const res = await fetch(`${url}/pull-requests/${id}/watch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    expect((await res.json()).data.deleted).toBe(true);
    expect(await readRow(id)).toBeNull();
  });
});
