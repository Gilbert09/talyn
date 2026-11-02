import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { pullRequestRoutes } from '../../routes/pullRequests.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { settleQueueFollowUps } from '../../services/mergeQueue/membership.js';
import { onQueueMembershipChanged } from '../../services/mergeQueue/triggers.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  mergeQueueEntries,
  mergeQueueEvents,
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';

// The kick is what makes the pipeline submit. Stubbed so the test asserts that
// it happened without running a real evaluation against GitHub.
vi.mock('../../services/mergeQueue/triggers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/mergeQueue/triggers.js')>();
  return { ...actual, onQueueMembershipChanged: vi.fn().mockResolvedValue(undefined) };
});

/**
 * POST /pull-requests/:id/merge-queue/resubmit — a person's one-click
 * "re-submit to the merge queue" for an entry the queue parked after trunk gave
 * the PR back (GitHub kept failing trunk, PostHog/posthog#126944, 2026-11-02).
 * It re-arms the entry and kicks an evaluation; it refuses, and changes nothing,
 * when there is nothing to re-submit.
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

type EntryFields = Partial<typeof mergeQueueEntries.$inferInsert>;

describe('POST /pull-requests/:id/merge-queue/resubmit', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;
  let seq = 0;

  async function insertPr(workspaceId = 'ws1'): Promise<string> {
    const id = `pr-${++seq}`;
    await db.insert(pullRequestsTable).values({
      id,
      workspaceId,
      repositoryId: workspaceId === 'ws1' ? 'repo1' : 'repo2',
      taskId: null,
      owner: 'a',
      repo: 'b',
      number: seq,
      state: 'open',
      mergeQueued: true,
      mergeMethod: 'squash',
      lastPolledAt: new Date(),
      lastSummary: { baseBranch: 'main', headSha: 'sha1' },
    });
    return id;
  }

  async function insertEntry(prId: string, fields: EntryFields, workspaceId = 'ws1') {
    const id = `entry-${prId}`;
    await db.insert(mergeQueueEntries).values({
      id,
      pullRequestId: prId,
      workspaceId,
      repositoryId: workspaceId === 'ws1' ? 'repo1' : 'repo2',
      baseBranch: 'main',
      headSha: 'sha1',
      ...fields,
    });
    return id;
  }

  async function entryRow(id: string) {
    const [row] = await db.select().from(mergeQueueEntries).where(eq(mergeQueueEntries.id, id));
    return row!;
  }

  async function eventCodes(entryId: string): Promise<Array<string | null>> {
    const rows = await db
      .select({ code: mergeQueueEvents.code })
      .from(mergeQueueEvents)
      .where(eq(mergeQueueEvents.entryId, entryId));
    return rows.map((r) => r.code);
  }

  async function resubmit(prId: string) {
    const res = await fetch(`${url}/pull-requests/${prId}/merge-queue/resubmit`, {
      method: 'POST',
      headers,
    });
    await settleQueueFollowUps();
    return { status: res.status, body: (await res.json()) as { success: boolean; code?: string } };
  }

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db);
    await seedUser(db, { id: 'someone-else' });
    await db.insert(workspacesTable).values([
      { id: 'ws1', ownerId: TEST_USER_ID, name: 'ws1', settings: {} },
      { id: 'ws2', ownerId: 'someone-else', name: 'ws2', settings: {} },
    ]);
    await db.insert(repositoriesTable).values([
      { id: 'repo1', workspaceId: 'ws1', name: 'b', url: 'https://github.com/a/b', defaultBranch: 'main' },
      { id: 'repo2', workspaceId: 'ws2', name: 'b', url: 'https://github.com/a/b', defaultBranch: 'main' },
    ]);
    vi.mocked(onQueueMembershipChanged).mockClear();
    const s = await makeServer();
    url = s.url;
    close = s.close;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await close();
    await cleanup();
  });

  it.each<[string, EntryFields]>([
    [
      'GitHub kept failing trunk',
      {
        status: 'blocked',
        blockedCode: 'external_queue_rejected',
        blockedReason: 'Trunk could not test or merge this PR because GitHub returned errors to it…',
        externalState: 'failed',
        submitAttempts: 4,
        submitRetryAttempts: 2,
        lastError: 'GitHub repeatedly returned errors',
        lastErrorAt: new Date(),
      },
    ],
    [
      'a fix run stopped for a human after a queue failure',
      {
        status: 'blocked',
        blockedCode: 'agent_needs_human',
        blockedReason: 'Someone needs to re-submit it with `/trunk merge`.',
        externalState: 'failed',
        submitAttempts: 1,
      },
    ],
    [
      'no way to submit automatically',
      { status: 'blocked_manual', blockedCode: 'external_gate', submitAttempts: 1 },
    ],
  ])('re-arms and kicks an entry parked on %s', async (_label, fields) => {
    const prId = await insertPr();
    const entryId = await insertEntry(prId, fields);

    const { status, body } = await resubmit(prId);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const row = await entryRow(entryId);
    expect(row.status).toBe('queued');
    expect(row.blockedCode).toBeNull();
    expect(row.blockedReason).toBeNull();
    expect(row.submitAttempts).toBe(0);
    expect(row.submitRetryAttempts).toBe(0);
    expect(row.externalState).toBeNull();
    // Cleared, so no GitHub-fault wait holds the submit the person asked for.
    expect(row.lastErrorAt).toBeNull();
    expect(await eventCodes(entryId)).toContain('user_resubmit');
    expect(onQueueMembershipChanged).toHaveBeenCalledWith(prId, 'user:resubmit');
  });

  it.each<[string, EntryFields, string]>([
    ['waiting in trunk', { status: 'awaiting_external', externalState: 'queued' }, 'not_parked'],
    ['queued', { status: 'queued' }, 'not_parked'],
    ['fixing', { status: 'fixing', externalState: 'failed' }, 'not_parked'],
    [
      'blocked on something no external queue was part of',
      { status: 'blocked', blockedCode: 'no_progress', blockedReason: 'stuck' },
      'no_external_queue',
    ],
  ])('refuses an entry that is %s', async (_label, fields, code) => {
    const prId = await insertPr();
    const entryId = await insertEntry(prId, fields);
    const before = await entryRow(entryId);

    const { status, body } = await resubmit(prId);

    expect(status).toBe(409);
    expect(body).toMatchObject({ success: false, code });
    const after = await entryRow(entryId);
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);
    expect(await eventCodes(entryId)).not.toContain('user_resubmit');
    expect(onQueueMembershipChanged).not.toHaveBeenCalled();
  });

  it('refuses a PR that is not in the merge queue', async () => {
    const prId = await insertPr();
    const { status, body } = await resubmit(prId);
    expect(status).toBe(409);
    expect(body.code).toBe('not_queued');
    expect(onQueueMembershipChanged).not.toHaveBeenCalled();
  });

  it('refuses a terminal entry as not queued', async () => {
    const prId = await insertPr();
    await insertEntry(prId, { status: 'merged', externalState: 'merged' });
    const { status, body } = await resubmit(prId);
    expect(status).toBe(409);
    expect(body.code).toBe('not_queued');
  });

  it('404s an unknown pull request', async () => {
    const { status } = await resubmit('pr-missing');
    expect(status).toBe(404);
  });

  it("does not touch another account's entry", async () => {
    const prId = await insertPr('ws2');
    const entryId = await insertEntry(
      prId,
      { status: 'blocked', blockedCode: 'external_queue_rejected', externalState: 'failed' },
      'ws2'
    );
    const { status } = await resubmit(prId);
    expect([403, 404]).toContain(status);
    expect((await entryRow(entryId)).status).toBe('blocked');
    expect(onQueueMembershipChanged).not.toHaveBeenCalled();
  });
});
