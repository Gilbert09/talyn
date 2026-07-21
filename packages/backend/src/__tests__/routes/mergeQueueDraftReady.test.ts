import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { pullRequestRoutes } from '../../routes/pullRequests.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { mergeQueueProcessor } from '../../services/mergeQueueProcessor.js';
import { markReadyForReview } from '../../services/githubAutoMerge.js';
import { prMonitorService } from '../../services/prMonitor.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  workspaces as workspacesTable,
  settings as settingsTable,
} from '../../db/schema.js';
import { eq } from 'drizzle-orm';

// Keep disableAutoMerge (and everything else) real; only stub the GitHub
// mutation so no network is hit and calls are assertable.
vi.mock('../../services/githubAutoMerge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/githubAutoMerge.js')>();
  return { ...actual, markReadyForReview: vi.fn().mockResolvedValue(true) };
});

/**
 * Queuing a DRAFT PR must flip it ready-for-review — GitHub 405s a draft merge,
 * so a queued draft would sit blocked. The route marks it ready (best-effort)
 * and refreshes the cached summary so the immediate kick can merge. A non-draft
 * PR, and a draft with no node id to mutate, must NOT call the mutation.
 */

const headers = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
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

describe('merge-queue enqueue — draft PRs get marked ready for review', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;
  let prSeq = 0;
  let refreshSpy: ReturnType<typeof vi.spyOn>;

  async function insertPr(summary: Record<string, unknown>): Promise<string> {
    const id = `pr-${++prSeq}`;
    await db.insert(pullRequestsTable).values({
      id,
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      taskId: null,
      owner: 'a',
      repo: 'b',
      number: prSeq,
      state: 'open',
      mergeQueued: false,
      mergeMethod: 'squash',
      lastPolledAt: new Date(),
      lastSummary: { baseBranch: 'main', headSha: 'sha1', ...summary },
    });
    return id;
  }

  function enqueue(prId: string) {
    return fetch(`${url}/pull-requests/${prId}/merge-queue`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enabled: true }),
    });
  }

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await db
      .update(settingsTable)
      .set({ value: 'v1' })
      .where(eq(settingsTable.key, 'merge_queue_engine'));
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
      name: 'b',
      url: 'https://github.com/a/b',
      defaultBranch: 'main',
    });
    vi.spyOn(mergeQueueProcessor, 'runOnce').mockResolvedValue(undefined);
    refreshSpy = vi.spyOn(prMonitorService, 'refreshPr').mockResolvedValue(undefined);
    vi.mocked(markReadyForReview).mockClear().mockResolvedValue(true);
    const s = await makeServer();
    url = s.url;
    close = s.close;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await close();
    await cleanup();
  });

  it('marks a draft PR ready (via draft flag) then refreshes it', async () => {
    const pr = await insertPr({ draft: true, nodeId: 'PR_node_1' });
    expect((await enqueue(pr)).status).toBe(200);
    expect(markReadyForReview).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markReadyForReview).mock.calls[0][0]).toMatchObject({
      nodeId: 'PR_node_1',
      owner: 'a',
      repo: 'b',
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    // Still queued.
    const rows = await db
      .select({ q: pullRequestsTable.mergeQueued })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, pr));
    expect(rows[0]?.q).toBe(true);
  });

  it('detects draft via mergeStateStatus even when the draft flag is absent', async () => {
    const pr = await insertPr({ mergeStateStatus: 'DRAFT', nodeId: 'PR_node_2' });
    expect((await enqueue(pr)).status).toBe(200);
    expect(markReadyForReview).toHaveBeenCalledTimes(1);
  });

  it('does NOT mark a non-draft PR ready', async () => {
    const pr = await insertPr({ draft: false, mergeStateStatus: 'CLEAN', nodeId: 'PR_node_3' });
    expect((await enqueue(pr)).status).toBe(200);
    expect(markReadyForReview).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('skips the mutation when the draft has no node id to mutate', async () => {
    const pr = await insertPr({ draft: true });
    expect((await enqueue(pr)).status).toBe(200);
    expect(markReadyForReview).not.toHaveBeenCalled();
  });

  it('leaves the PR queued even if the refresh is skipped on a mark-ready failure', async () => {
    vi.mocked(markReadyForReview).mockResolvedValueOnce(false);
    const pr = await insertPr({ draft: true, nodeId: 'PR_node_4' });
    expect((await enqueue(pr)).status).toBe(200);
    expect(markReadyForReview).toHaveBeenCalledTimes(1);
    expect(refreshSpy).not.toHaveBeenCalled();
    const rows = await db
      .select({ q: pullRequestsTable.mergeQueued })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, pr));
    expect(rows[0]?.q).toBe(true);
  });
});
