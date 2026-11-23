import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { prCodeReviewEvents, prCodeReviews, pullRequests, repositories, workbenches, workspaces } from '../db/schema.js';
import {
  liveWorkbenchesForPrs,
  owningWorkbenchesForPrs,
  owningWorkbenchesForPrsQuery,
} from '../services/workbenches/prSessions.js';
import {
  codeReviewForPr,
  codeReviewsForPrs,
  publicReviewById,
  sessionReportsFor,
} from '../services/codeReview/public.js';
import { SESSION_REPORT_SENT } from '../services/codeReview/sessionReport.js';

const { workbenchRoutes } = await import('../routes/workbenches.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');

type SessionSeed = {
  id: string;
  name?: string;
  pullRequestId?: string | null;
  workspaceId?: string;
  runtime?: 'sandbox' | 'local';
  status?: string;
  archivedAt?: Date | null;
  updatedAt?: Date;
};

const session = (s: SessionSeed) => ({
  id: s.id,
  workspaceId: s.workspaceId ?? 'ws-a',
  repositoryId: 'repo-a',
  repoFullName: 'o/r',
  name: s.name ?? s.id,
  branch: s.name ?? s.id,
  baseBranch: 'main',
  runtime: s.runtime ?? 'sandbox',
  agent: 'claude',
  status: s.status ?? (s.archivedAt ? 'archived' : 'ready'),
  pullRequestId: s.pullRequestId === undefined ? 'p1' : s.pullRequestId,
  archivedAt: s.archivedAt ?? null,
  ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
});

const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, n));

/**
 * Which session a review of PR p1 belongs to. `expected` is the session id, or
 * null for no link.
 */
const CASES: { name: string; sessions: SessionSeed[]; expected: { id: string; archived: boolean } | null }[] = [
  { name: 'one live session', sessions: [{ id: 'w1' }], expected: { id: 'w1', archived: false } },
  { name: 'no session', sessions: [], expected: null },
  { name: 'a session on another PR only', sessions: [{ id: 'w1', pullRequestId: 'p2' }], expected: null },
  { name: 'a session with no PR', sessions: [{ id: 'w1', pullRequestId: null }], expected: null },
  { name: 'a local session', sessions: [{ id: 'w1', runtime: 'local' }], expected: { id: 'w1', archived: false } },
  {
    name: 'an archived session only',
    sessions: [{ id: 'w1', archivedAt: at(5) }],
    expected: { id: 'w1', archived: true },
  },
  {
    name: 'a live session beats a newer archived one',
    sessions: [
      { id: 'live', updatedAt: at(1) },
      { id: 'old', archivedAt: at(9), updatedAt: at(9) },
    ],
    expected: { id: 'live', archived: false },
  },
  {
    name: 'the most recently updated of two live sessions',
    sessions: [
      { id: 'w1', updatedAt: at(1) },
      { id: 'w2', updatedAt: at(2) },
    ],
    expected: { id: 'w2', archived: false },
  },
  {
    name: 'the newest archive of two archived sessions',
    sessions: [
      { id: 'w1', archivedAt: at(8), updatedAt: at(1) },
      { id: 'w2', archivedAt: at(3), updatedAt: at(9) },
    ],
    expected: { id: 'w1', archived: true },
  },
  {
    name: 'a session in an error state',
    sessions: [{ id: 'w1', status: 'error' }],
    expected: { id: 'w1', archived: false },
  },
  {
    name: 'a session in another workspace',
    sessions: [{ id: 'w1', workspaceId: 'ws-b' }],
    expected: null,
  },
];

describe('the session a code review belongs to', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
    const { db } = testDb;
    await seedUser(db, { id: 'owner-a' });
    await db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-b', ownerId: 'owner-a', name: 'B' },
    ]);
    await db.insert(repositories).values({ id: 'repo-a', workspaceId: 'ws-a', name: 'o/r', url: 'https://github.com/o/r' });
    await db.insert(pullRequests).values(
      [1, 2].map((n) => ({
        id: `p${n}`, workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'o', repo: 'r', number: n, state: 'open',
        lastSummary: { headSha: 'abc1234def' },
      })),
    );
    await db.insert(prCodeReviews).values([
      { id: 'rev1', workspaceId: 'ws-a', repositoryId: 'repo-a', pullRequestId: 'p1', cycle: 1, phase: 'ready', targetHeadSha: 'abc1234def' },
      { id: 'rev2', workspaceId: 'ws-a', repositoryId: 'repo-a', pullRequestId: 'p2', cycle: 1, phase: 'ready', targetHeadSha: 'abc1234def' },
    ]);
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it('selects a few columns, never a whole row, and keeps archived sessions', () => {
    const sqlText = owningWorkbenchesForPrsQuery(['ws-a'], ['p1']).toSQL().sql;
    expect(sqlText).not.toMatch(/select \*/i);
    for (const col of ['settings', 'diff_stat', 'status_message', 'local_path']) expect(sqlText).not.toContain(col);
    expect(sqlText).not.toContain('"archived_at" is null');
  });

  it('answers an empty map for no ids or no workspaces', async () => {
    await testDb.db.insert(workbenches).values(session({ id: 'w1' }));
    expect((await owningWorkbenchesForPrs('ws-a', [])).size).toBe(0);
    expect((await owningWorkbenchesForPrs([], ['p1'])).size).toBe(0);
  });

  it.each(CASES)('links $name', async ({ sessions, expected }) => {
    if (sessions.length) await testDb.db.insert(workbenches).values(sessions.map(session));
    const link = (await owningWorkbenchesForPrs('ws-a', ['p1'])).get('p1') ?? null;
    expect(link ? { id: link.id, archived: link.archived } : null).toEqual(expected);
  });

  it.each(CASES)('puts the same session on every review payload: $name', async ({ sessions, expected }) => {
    if (sessions.length) await testDb.db.insert(workbenches).values(sessions.map(session));
    const one = await codeReviewForPr('p1');
    const byId = await publicReviewById('rev1');
    const batch = (await codeReviewsForPrs(['p1', 'p2'])).get('p1');
    for (const payload of [one, byId, batch]) {
      const link = payload?.session ?? null;
      expect(link ? { id: link.id, archived: link.archived } : null).toEqual(expected);
    }
  });

  it('names the session and its status on the payload', async () => {
    await testDb.db.insert(workbenches).values(session({ id: 'w1', name: 'paris' }));
    expect((await codeReviewForPr('p1'))?.session).toEqual({ id: 'w1', name: 'paris', status: 'ready', archived: false });
  });

  it('links each review of a page to its own session', async () => {
    await testDb.db.insert(workbenches).values([
      session({ id: 'w1', pullRequestId: 'p1' }),
      session({ id: 'w2', pullRequestId: 'p2', archivedAt: at(1) }),
    ]);
    const page = await codeReviewsForPrs(['p1', 'p2']);
    expect(page.get('p1')?.session).toMatchObject({ id: 'w1', archived: false });
    expect(page.get('p2')?.session).toMatchObject({ id: 'w2', archived: true });
  });

  it('agrees with the live session the pull request names', async () => {
    await testDb.db.insert(workbenches).values([
      session({ id: 'w1', updatedAt: at(1) }),
      session({ id: 'w2', updatedAt: at(2) }),
      session({ id: 'w3', archivedAt: at(3), updatedAt: at(3) }),
    ]);
    const live = (await liveWorkbenchesForPrs('ws-a', ['p1'])).get('p1');
    expect((await codeReviewForPr('p1'))?.session?.id).toBe(live?.id);
  });

  it('follows a session that links the pull request after the review started', async () => {
    expect((await codeReviewForPr('p1'))?.session).toBeNull();
    await testDb.db.insert(workbenches).values(session({ id: 'late' }));
    expect((await codeReviewForPr('p1'))?.session?.id).toBe('late');
  });
});

describe('the report-back on a code review', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  const sent = (cycle: number, when: Date, detail: Record<string, unknown> = {}) => ({
    reviewId: 'rev1', at: when, toPhase: 'ready', trigger: 'executor', code: SESSION_REPORT_SENT,
    detail: { workbenchId: 'w1', findingIds: ['f1', 'f2'], cycle, ...detail },
  });

  beforeEach(async () => {
    testDb = await createTestDb();
    const { db } = testDb;
    await seedUser(db, { id: 'owner-a' });
    await db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    await db.insert(repositories).values({ id: 'repo-a', workspaceId: 'ws-a', name: 'o/r', url: 'https://github.com/o/r' });
    await db.insert(pullRequests).values({
      id: 'p1', workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'o', repo: 'r', number: 1, state: 'open', lastSummary: {},
    });
    await db.insert(prCodeReviews).values({
      id: 'rev1', workspaceId: 'ws-a', repositoryId: 'repo-a', pullRequestId: 'p1', cycle: 2, phase: 'ready',
    });
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it.each([
    { name: 'no report', events: [], expected: null },
    {
      name: 'a report of this cycle',
      events: [sent(2, at(5))],
      expected: { workbenchId: 'w1', sentAt: at(5).toISOString(), findingCount: 2 },
    },
    { name: 'a report of an older cycle only', events: [sent(1, at(5))], expected: null },
    {
      name: 'the newest of two reports of this cycle',
      events: [sent(2, at(5)), sent(2, at(7), { workbenchId: 'w2', findingIds: ['f1'] })],
      expected: { workbenchId: 'w2', sentAt: at(7).toISOString(), findingCount: 1 },
    },
    { name: 'a report with no session id', events: [sent(2, at(5), { workbenchId: null })], expected: null },
    {
      name: 'a report with no finding ids',
      events: [sent(2, at(5), { findingIds: undefined })],
      expected: { workbenchId: 'w1', sentAt: at(5).toISOString(), findingCount: 0 },
    },
    {
      name: 'another event code',
      events: [{ ...sent(2, at(5)), code: 'session_report_failed' }],
      expected: null,
    },
  ])('shows $name', async ({ events, expected }) => {
    if (events.length) await testDb.db.insert(prCodeReviewEvents).values(events);
    expect((await sessionReportsFor([{ id: 'rev1', cycle: 2 }])).get('rev1') ?? null).toEqual(expected);
    expect((await codeReviewForPr('p1'))?.sessionReport ?? null).toEqual(expected);
    expect((await codeReviewsForPrs(['p1'])).get('p1')?.sessionReport ?? null).toEqual(expected);
  });

  it('answers an empty map for no reviews', async () => {
    expect((await sessionReportsFor([])).size).toBe(0);
  });
});

describe('GET /workbenches/:id/code-review', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base = '';

  async function call(url: string, user = 'owner-a') {
    const resp = await fetch(`${base}${url}`, { headers: { 'x-user': user } });
    return {
      status: resp.status,
      body: (await resp.json()) as {
        success: boolean;
        data?: { pullRequestId: string | null; review: { id: string; session?: { id: string } | null } | null };
      },
    };
  }

  beforeAll(async () => {
    testDb = await createTestDb();
    const { db } = testDb;
    await seedUser(db, { id: 'owner-a' });
    await seedUser(db, { id: 'owner-b' });
    await db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await db.insert(repositories).values({ id: 'repo-a', workspaceId: 'ws-a', name: 'o/r', url: 'https://github.com/o/r' });
    await db.insert(pullRequests).values(
      [1, 2].map((n) => ({
        id: `p${n}`, workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'o', repo: 'r', number: n, state: 'open',
        lastSummary: {},
      })),
    );
    await db.insert(prCodeReviews).values({
      id: 'rev1', workspaceId: 'ws-a', repositoryId: 'repo-a', pullRequestId: 'p1', cycle: 1, phase: 'ready',
    });
    await db.insert(workbenches).values([
      session({ id: 'reviewed', pullRequestId: 'p1' }),
      session({ id: 'archived', pullRequestId: 'p1', archivedAt: at(1) }),
      session({ id: 'unreviewed', pullRequestId: 'p2' }),
      session({ id: 'no-pr', pullRequestId: null }),
    ]);
    const app = express();
    app.use((req, _res, next) => {
      const id = req.headers['x-user'] as string;
      req.user = { id, email: `${id}@example.test`, isAdmin: false };
      next();
    });
    app.use('/workbenches', wrapAsyncRoutes(workbenchRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await testDb.cleanup();
  });

  beforeEach(() => {
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    resetFeatureFlagsForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['a session whose PR was reviewed', 'reviewed', 'p1', 'rev1', 'reviewed'],
    ['an archived session on the same PR', 'archived', 'p1', 'rev1', 'reviewed'],
    ['a session whose PR was never reviewed', 'unreviewed', 'p2', null, null],
    ['a session with no PR', 'no-pr', null, null, null],
  ])('answers %s', async (_name, id, pullRequestId, reviewId, sessionId) => {
    const res = await call(`/workbenches/${id}/code-review`);
    expect(res.status).toBe(200);
    expect(res.body.data?.pullRequestId).toBe(pullRequestId);
    expect(res.body.data?.review?.id ?? null).toBe(reviewId);
    expect(res.body.data?.review?.session?.id ?? null).toBe(sessionId);
  });

  it.each([
    ['an unknown session', 'missing', 'owner-a'],
    ["another owner's session", 'reviewed', 'owner-b'],
  ])('answers 404 for %s', async (_name, id, user) => {
    const res = await call(`/workbenches/${id}/code-review`, user);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
