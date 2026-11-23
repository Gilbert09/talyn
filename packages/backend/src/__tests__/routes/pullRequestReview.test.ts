import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { MAX_REVIEW_BODY_CHARS, pullRequestRoutes } from '../../routes/pullRequests.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
} from '../../db/schema.js';
import { GitHubApiError, GitHubNotConnectedError, githubService } from '../../services/github.js';
import { GitHubRateLimitError } from '../../services/githubRateGate.js';
import { prMonitorService } from '../../services/prMonitor.js';

/**
 * POST /pull-requests/:id/review — Approve / Request changes from the app.
 *
 * What is pinned here: the body rules GitHub enforces are refused BEFORE a
 * GitHub call, the review is refused on a closed PR and on the user's own PR,
 * the event maps to GitHub's vocabulary, GitHub's own refusal keeps its status
 * and message, and the answer carries the review plus the refreshed row.
 */

const OTHER_USER_ID = 'user-other';
const headers = { ...internalProxyHeaders(TEST_USER_ID), 'content-type': 'application/json' };

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/pull-requests', requireAuth, pullRequestRoutes());
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

function prRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: 'ws-mine',
    repositoryId: 'repo-mine',
    owner: 'acme',
    repo: 'widgets',
    number: 7,
    state: 'open',
    reviewRequested: true,
    authored: false,
    lastPolledAt: new Date(),
    lastSummary: { title: 'Add feature', headBranch: 'feature/x', author: 'someone' },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

const REVIEW = {
  id: 991,
  user: { login: 'tom', avatar_url: '' },
  body: '',
  state: 'APPROVED' as const,
  submitted_at: '2026-11-10T10:00:00Z',
  html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-991',
};

describe('POST /pull-requests/:id/review', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;
  let createReview: ReturnType<typeof vi.spyOn>;
  let refresh: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
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
    await db.insert(pullRequestsTable).values([
      prRow('pr-open'),
      prRow('pr-closed', { number: 8, state: 'closed' }),
      prRow('pr-merged', { number: 9, state: 'merged' }),
      prRow('pr-own', { number: 10, authored: true, reviewRequested: false }),
      prRow('pr-theirs', { workspaceId: 'ws-other', repositoryId: 'repo-other' }),
    ]);
    createReview = vi.spyOn(githubService, 'createPRReview').mockResolvedValue(REVIEW);
    // Stands in for the per-PR refresh: GitHub drops the request once you review.
    refresh = vi.spyOn(prMonitorService, 'refreshPr').mockImplementation(async () => {
      await db
        .update(pullRequestsTable)
        .set({ reviewRequested: false })
        .where(eq(pullRequestsTable.id, 'pr-open'));
    });
    ({ url, close } = await makeServer());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await close();
    await cleanup();
  });

  function review(id: string, body: unknown) {
    return fetch(`${url}/pull-requests/${id}/review`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  describe('validation', () => {
    it.each<[string, unknown, string]>([
      ['no event', {}, 'invalid_event'],
      ['an unknown event', { event: 'comment' }, 'invalid_event'],
      ['an upper-case event', { event: 'APPROVE' }, 'invalid_event'],
      ['a number event', { event: 1 }, 'invalid_event'],
      ['a body that is not text', { event: 'approve', body: 42 }, 'invalid_body'],
      ['a body that is an object', { event: 'approve', body: { text: 'hi' } }, 'invalid_body'],
      ['request changes with no body', { event: 'request_changes' }, 'body_required'],
      ['request changes with a null body', { event: 'request_changes', body: null }, 'body_required'],
      ['request changes with an empty body', { event: 'request_changes', body: '' }, 'body_required'],
      ['request changes with a blank body', { event: 'request_changes', body: '  \n\t ' }, 'body_required'],
      ['an approve body over the limit', { event: 'approve', body: 'x'.repeat(MAX_REVIEW_BODY_CHARS + 1) }, 'body_too_long'],
      ['a request changes body over the limit', { event: 'request_changes', body: 'x'.repeat(MAX_REVIEW_BODY_CHARS + 1) }, 'body_too_long'],
    ])('400s for %s', async (_label, body, code) => {
      const res = await review('pr-open', body);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.code).toBe(code);
      expect(typeof json.error).toBe('string');
      expect(createReview).not.toHaveBeenCalled();
    });

    it('accepts a body at exactly the limit', async () => {
      const res = await review('pr-open', { event: 'approve', body: 'x'.repeat(MAX_REVIEW_BODY_CHARS) });
      expect(res.status).toBe(200);
    });

    it('measures the limit after trimming', async () => {
      const res = await review('pr-open', {
        event: 'approve',
        body: `  ${'x'.repeat(MAX_REVIEW_BODY_CHARS)}  `,
      });
      expect(res.status).toBe(200);
    });
  });

  describe('scope and state', () => {
    it.each([
      ['an unknown PR', 'pr-missing'],
      ['a PR in another owner workspace', 'pr-theirs'],
    ])('404s for %s', async (_label, id) => {
      const res = await review(id, { event: 'approve' });
      expect(res.status).toBe(404);
      expect(createReview).not.toHaveBeenCalled();
    });

    it.each([
      ['closed', 'pr-closed'],
      ['merged', 'pr-merged'],
    ])('409s pr_not_open on a %s PR', async (_label, id) => {
      const res = await review(id, { event: 'approve' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('pr_not_open');
      expect(createReview).not.toHaveBeenCalled();
    });

    it.each(['approve', 'request_changes'])('409s own_pull_request for %s on your own PR', async (event) => {
      const res = await review('pr-own', { event, body: 'Looks off' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('own_pull_request');
      expect(createReview).not.toHaveBeenCalled();
    });
  });

  describe('submitting', () => {
    it.each<[string, unknown]>([
      ['no body', { event: 'approve' }],
      ['an empty body', { event: 'approve', body: '' }],
      ['a blank body', { event: 'approve', body: '   ' }],
      ['a null body', { event: 'approve', body: null }],
    ])('approves with %s and sends no body', async (_label, body) => {
      const res = await review('pr-open', body);
      expect(res.status).toBe(200);
      expect(createReview).toHaveBeenCalledTimes(1);
      expect(createReview).toHaveBeenCalledWith('ws-mine', 'acme', 'widgets', 7, { event: 'APPROVE' });
    });

    it('approves with a trimmed comment', async () => {
      await review('pr-open', { event: 'approve', body: '  Nice work.  ' });
      expect(createReview).toHaveBeenCalledWith('ws-mine', 'acme', 'widgets', 7, {
        event: 'APPROVE',
        body: 'Nice work.',
      });
    });

    it('requests changes with the comment', async () => {
      createReview.mockResolvedValue({ ...REVIEW, state: 'CHANGES_REQUESTED' });
      const res = await review('pr-open', { event: 'request_changes', body: ' Please add a test. ' });
      expect(res.status).toBe(200);
      expect(createReview).toHaveBeenCalledWith('ws-mine', 'acme', 'widgets', 7, {
        event: 'REQUEST_CHANGES',
        body: 'Please add a test.',
      });
      expect((await res.json()).data.review.state).toBe('CHANGES_REQUESTED');
    });

    it('answers with the review and the refreshed row', async () => {
      const res = await review('pr-open', { event: 'approve' });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.review).toEqual({ id: 991, state: 'APPROVED', url: REVIEW.html_url });
      expect(json.data.row).toMatchObject({
        id: 'pr-open',
        number: 7,
        state: 'open',
        reviewRequested: false,
        mergeQueue: null,
        codeReview: null,
        session: null,
      });
      expect(refresh).toHaveBeenCalledWith('ws-mine', 'acme', 'widgets', 7, { repositoryId: 'repo-mine' });
    });

    it('still answers 200 when the refresh after the review fails', async () => {
      refresh.mockRejectedValue(new Error('graphql down'));
      const res = await review('pr-open', { event: 'approve' });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.review.id).toBe(991);
      expect(json.data.row.reviewRequested).toBe(true);
    });
  });

  describe('GitHub errors', () => {
    it.each([403, 404, 422])('keeps a GitHub %i with its message', async (status) => {
      const message = `GitHub API error ${status}: Unprocessable Entity — Can not approve your own pull request (GitHub request-id: abc)`;
      createReview.mockRejectedValue(new GitHubApiError(message, status));
      const res = await review('pr-open', { event: 'approve' });
      expect(res.status).toBe(status);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toBe(message);
      expect(refresh).not.toHaveBeenCalled();
    });

    it.each<[string, Error]>([
      ['a GitHub 500', new GitHubApiError('GitHub API error 500: Server Error', 500)],
      ['a GitHub 401', new GitHubApiError('GitHub token expired or revoked', 401)],
      ['a transport failure', new Error('fetch failed')],
    ])('502s for %s', async (_label, err) => {
      createReview.mockRejectedValue(err);
      const res = await review('pr-open', { event: 'approve' });
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe(err.message);
    });

    it('409s github_not_connected when there is no token', async () => {
      createReview.mockRejectedValue(new GitHubNotConnectedError());
      const res = await review('pr-open', { event: 'approve' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('github_not_connected');
    });

    it('503s with Retry-After on a rate limit', async () => {
      createReview.mockRejectedValue(new GitHubRateLimitError('rate limited', 30_000));
      const res = await review('pr-open', { event: 'approve' });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('30');
      expect((await res.json()).code).toBe('rate_limited');
    });
  });
});
