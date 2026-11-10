import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { pullRequestRoutes } from '../../routes/pullRequests.js';
import { repositoryRoutes } from '../../routes/repositories.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { ownerScope, continueWithoutOwnerScope } from '../../middleware/ownerScope.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import * as dbClient from '../../db/client.js';
import type { Database } from '../../db/client.js';
import { inflightEntries, _resetInflight } from '../../db/inflight.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
} from '../../db/schema.js';
import * as graphqlModule from '../../services/githubGraphql.js';
import type { PRSummary } from '../../services/githubGraphql.js';
import { prMonitorService } from '../../services/prMonitor.js';
import * as prSessionsModule from '../../services/workbenches/prSessions.js';

/**
 * The PR detail and refresh routes wait on GitHub. They must commit the
 * request's owner-scoped transaction first, so the wait does not hold a pooled
 * connection idle in transaction. These tests run the real `ownerScope`
 * middleware with the real transaction path (RLS on, against pglite).
 */

const OTHER_USER_ID = 'user-other';
const auth = { ...internalProxyHeaders(TEST_USER_ID), 'content-type': 'application/json' };

function summary(over: Partial<PRSummary> = {}): PRSummary {
  return {
    owner: 'acme', repo: 'widgets', number: 7, title: 'Fresh title', body: '',
    url: 'https://github.com/acme/widgets/pull/7', author: 'me', draft: false, state: 'open',
    mergedAt: null, closedAt: null, headBranch: 'feature/x', baseBranch: 'main', headSha: 'sha2',
    updatedAt: '2026-01-01T00:00:00Z', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    reviewDecision: null, blockingReason: 'mergeable',
    checks: { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 },
    unresolvedReviewThreads: 0, checkDigest: 'sha2:new', recentReviews: [],
    recentReviewComments: [], recentComments: [],
    ...over,
  };
}

/** What the scope looked like while GitHub was being called. */
function probeScope(): { scoped: boolean; ownerTx: number } {
  return {
    scoped: dbClient.getScopedDb() !== undefined,
    ownerTx: inflightEntries().filter((e) => e.kind === 'owner_tx').length,
  };
}

describe('GitHub waits run outside the owner scope', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await seedUser(db, { id: OTHER_USER_ID });
    await db.insert(workspacesTable).values([
      { id: 'ws-mine', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
      { id: 'ws-other', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
    ]);
    await db.insert(repositoriesTable).values([
      { id: 'repo-mine', workspaceId: 'ws-mine', name: 'acme/widgets', url: 'https://github.com/acme/widgets', defaultBranch: 'main' },
      { id: 'repo-other', workspaceId: 'ws-other', name: 'acme/widgets', url: 'https://github.com/acme/widgets', defaultBranch: 'main' },
    ]);
    for (const [id, workspaceId, repositoryId] of [
      ['pr-mine', 'ws-mine', 'repo-mine'],
      ['pr-other', 'ws-other', 'repo-other'],
    ]) {
      await db.insert(pullRequestsTable).values({
        id, workspaceId, repositoryId, owner: 'acme', repo: 'widgets', number: 7, state: 'open',
        lastPolledAt: new Date(),
        lastSummary: { title: 'Old title', headBranch: 'feature/x', author: 'me', blockingReason: 'ci_pending' },
        lastCheckDigest: 'sha1:old',
      });
    }
    _resetInflight();
    vi.spyOn(dbClient, 'isRealPostgres').mockReturnValue(true);
    // It reads on the pool. pglite has one connection, so a pool read inside an
    // open transaction waits forever here. Production has separate connections.
    vi.spyOn(prSessionsModule, 'liveWorkbenchForPr').mockResolvedValue(null);

    const app = express();
    app.use(express.json());
    app.use('/api/v1', requireAuth, ownerScope);
    app.use('/api/v1/pull-requests', wrapAsyncRoutes(pullRequestRoutes()));
    app.use('/api/v1/repositories', wrapAsyncRoutes(repositoryRoutes()));
    app.get('/api/v1/early/:mode', async (req, res, next) => {
      try {
        const ids = await continueWithoutOwnerScope(req, async () => {
          if (req.params.mode === 'throw') throw new Error('after the scope');
          const rows = await dbClient.getDbClient().select({ id: workspacesTable.id }).from(workspacesTable);
          return rows.map((r) => r.id).sort();
        });
        res.json({ ids, probe: probeScope() });
      } catch (err) {
        next(err);
      }
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  it('GET /:id fetches with no owner transaction open, persists the fetch and answers as before', async () => {
    const probes: Array<ReturnType<typeof probeScope>> = [];
    vi.spyOn(graphqlModule, 'batchPullRequests').mockImplementation(async () => {
      probes.push(probeScope());
      return [{ branch: 'feature/x', pr: summary() }];
    });
    const res = await fetch(`${base}/api/v1/pull-requests/pr-mine`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { row: { id: string; summary: { title: string }; mergeQueue: unknown; codeReview: unknown; session: unknown }; fresh: PRSummary };
    };
    expect(probes).toEqual([{ scoped: false, ownerTx: 0 }]);
    expect(body.success).toBe(true);
    expect(Object.keys(body.data)).toEqual(['row', 'fresh']);
    expect(body.data.row.id).toBe('pr-mine');
    expect(body.data.row.summary.title).toBe('Fresh title');
    expect(body.data.row).toMatchObject({ mergeQueue: null, codeReview: null, session: null });
    expect(body.data.fresh.title).toBe('Fresh title');
    const [mine] = await db.select().from(pullRequestsTable).where(eq(pullRequestsTable.id, 'pr-mine'));
    const [other] = await db.select().from(pullRequestsTable).where(eq(pullRequestsTable.id, 'pr-other'));
    expect((mine.lastSummary as { title: string }).title).toBe('Fresh title');
    expect((other.lastSummary as { title: string }).title).toBe('Old title');
    expect(inflightEntries()).toEqual([]);
  });

  it('POST /:id/refresh fetches with no owner transaction open and writes only the proved row', async () => {
    const probes: Array<ReturnType<typeof probeScope>> = [];
    vi.spyOn(graphqlModule, 'batchPullRequests').mockImplementation(async () => {
      probes.push(probeScope());
      return [{ branch: 'feature/x', pr: summary({ title: 'Refreshed' }) }];
    });
    const res = await fetch(`${base}/api/v1/pull-requests/pr-mine/refresh`, { method: 'POST', headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string; summary: { title: string } } };
    expect(probes).toEqual([{ scoped: false, ownerTx: 0 }]);
    expect(body).toMatchObject({ success: true, data: { id: 'pr-mine', summary: { title: 'Refreshed' } } });
    const [other] = await db.select().from(pullRequestsTable).where(eq(pullRequestsTable.id, 'pr-other'));
    expect((other.lastSummary as { title: string }).title).toBe('Old title');
    expect(inflightEntries()).toEqual([]);
  });

  it.each([
    ['GET', '/api/v1/pull-requests/pr-other'],
    ['POST', '/api/v1/pull-requests/pr-other/refresh'],
    ['GET', '/api/v1/pull-requests/missing'],
    ['POST', '/api/v1/pull-requests/missing/refresh'],
  ])('%s %s answers 404 and never calls GitHub', async (method, path) => {
    const spy = vi.spyOn(graphqlModule, 'batchPullRequests');
    const res = await fetch(`${base}${path}`, { method, headers: auth });
    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('POST /:id/refresh answers 404 off the scope when GitHub has nothing', async () => {
    vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([{ branch: 'feature/x', pr: null }]);
    const res = await fetch(`${base}/api/v1/pull-requests/pr-mine/refresh`, { method: 'POST', headers: auth });
    expect(res.status).toBe(404);
    expect(inflightEntries()).toEqual([]);
  });

  it('POST /repositories/poll waits on the poll with no owner transaction open', async () => {
    const probes: Array<ReturnType<typeof probeScope>> = [];
    vi.spyOn(prMonitorService, 'forcePollForOwner').mockImplementation(async (ownerId) => {
      expect(ownerId).toBe(TEST_USER_ID);
      probes.push(probeScope());
      return { repos: 1, failedRepos: 0, failure: null };
    });
    const res = await fetch(`${base}/api/v1/repositories/poll`, { method: 'POST', headers: auth });
    expect(res.status).toBe(200);
    expect(probes).toEqual([{ scoped: false, ownerTx: 0 }]);
  });

  it('continueWithoutOwnerScope runs its function on the pool after the scope commits', async () => {
    const res = await fetch(`${base}/api/v1/early/read`, { headers: auth });
    expect(res.status).toBe(200);
    // The pool is not RLS-filtered, which is why callers must prove ownership
    // first. After the call the handler still sees the closed scoped handle.
    expect(await res.json()).toEqual({ ids: ['ws-mine', 'ws-other'], probe: { scoped: true, ownerTx: 0 } });
  });

  it('an error after the scope ended reaches the handler once', async () => {
    const res = await fetch(`${base}/api/v1/early/throw`, { headers: auth });
    expect(res.status).toBe(500);
    expect(inflightEntries()).toEqual([]);
  });
});
