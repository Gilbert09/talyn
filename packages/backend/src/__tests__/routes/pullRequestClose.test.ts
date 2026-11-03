import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { pullRequestRoutes } from '../../routes/pullRequests.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
  workbenches as workbenchesTable,
} from '../../db/schema.js';
import { GitHubApiError, githubService } from '../../services/github.js';
import { GitHubRateLimitError } from '../../services/githubRateGate.js';
import { MAX_CLOSE_COMMENT_CHARS, type ClosePullRequestResult } from '../../services/prClose.js';

const OTHER_USER_ID = 'user-other';
const VIEWER = 'tom';
const PR_CREATED = '2026-11-01T12:00:00Z';

const headers = { ...internalProxyHeaders(TEST_USER_ID), 'content-type': 'application/json' };

interface GhPr {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  html_url: string;
  user: { login: string; avatar_url: string };
  created_at: string;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
}

function ghPr(over: Partial<GhPr> = {}): GhPr {
  return {
    number: 7,
    state: 'open',
    merged: false,
    merged_at: null,
    html_url: 'https://github.com/acme/widgets/pull/7',
    user: { login: VIEWER, avatar_url: '' },
    created_at: PR_CREATED,
    head: { ref: 'tom/old-work', sha: 'sha7', repo: { full_name: 'acme/widgets' } },
    ...over,
  };
}

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

async function seed(db: Database): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await seedUser(db, { id: OTHER_USER_ID });
  await db.insert(workspacesTable).values([
    { id: 'ws-mine', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
    { id: 'ws-other', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
  ]);
  await db.insert(repositoriesTable).values([
    { id: 'repo-mine', workspaceId: 'ws-mine', name: 'acme/widgets', url: 'https://github.com/acme/widgets', defaultBranch: 'main' },
    { id: 'repo-api', workspaceId: 'ws-mine', name: 'acme/api', url: 'https://github.com/acme/api', defaultBranch: 'main' },
    { id: 'repo-other', workspaceId: 'ws-other', name: 'acme/widgets', url: 'https://github.com/acme/widgets', defaultBranch: 'main' },
  ]);
  await db.insert(pullRequestsTable).values([
    pr('pr-old', 7, 'tom/old-work'),
    pr('pr-session', 8, 'tom/session-work'),
    { ...pr('pr-api', 3, 'tom/api-work'), repositoryId: 'repo-api', repo: 'api' },
    { ...pr('pr-theirs', 7, 'tom/old-work'), workspaceId: 'ws-other', repositoryId: 'repo-other' },
  ]);
  await db.insert(workbenchesTable).values([
    session('wb-1', {
      pullRequestId: 'pr-session',
      branch: 'tom/session-work',
      createdAt: new Date(Date.parse(PR_CREATED) - 10 * 60_000),
    }),
    { ...session('wb-thread', {}), kind: 'thread', repositoryId: null, repoFullName: '' },
  ]);
}

function pr(id: string, number: number, headBranch: string) {
  return {
    id,
    workspaceId: 'ws-mine',
    repositoryId: 'repo-mine',
    owner: 'acme',
    repo: 'widgets',
    number,
    state: 'open',
    lastPolledAt: new Date(),
    lastSummary: { title: 'Work', headBranch, author: VIEWER, createdAt: PR_CREATED },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function session(id: string, over: { pullRequestId?: string | null; branch?: string; createdAt?: Date }) {
  return {
    id,
    workspaceId: 'ws-mine',
    repositoryId: 'repo-mine',
    repoFullName: 'acme/widgets',
    name: id,
    branch: over.branch ?? 'tom/other',
    baseBranch: 'main',
    runtime: 'sandbox',
    agent: 'claude',
    status: 'ready',
    pullRequestId: over.pullRequestId ?? null,
    ...(over.createdAt ? { createdAt: over.createdAt } : {}),
  };
}

describe('POST /pull-requests/close', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;
  let getPr: ReturnType<typeof vi.spyOn>;
  let comment: ReturnType<typeof vi.spyOn>;
  let update: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);
    const s = await makeServer();
    serverUrl = s.url;
    closeServer = s.close;
    getPr = vi.spyOn(githubService, 'getPullRequest').mockResolvedValue(ghPr() as never);
    vi.spyOn(githubService, 'getViewerLogin').mockResolvedValue(VIEWER);
    comment = vi.spyOn(githubService, 'createIssueComment').mockResolvedValue(undefined);
    update = vi.spyOn(githubService, 'updatePullRequest').mockResolvedValue({} as never);
  });

  afterEach(async () => {
    await closeServer();
    await cleanup();
    vi.restoreAllMocks();
  });

  async function close(body: Record<string, unknown>) {
    const res = await fetch(`${serverUrl}/pull-requests/close`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: (await res.json()) as {
        success: boolean;
        data: ClosePullRequestResult;
        code?: string;
        error?: string;
      },
    };
  }

  async function rowState(id: string): Promise<string | undefined> {
    const [row] = await db.select({ state: pullRequestsTable.state }).from(pullRequestsTable).where(eq(pullRequestsTable.id, id));
    return row?.state;
  }

  describe('a user token', () => {
    it('closes the user own PR without a comment and marks the row closed', async () => {
      const res = await close({ pullRequestId: 'pr-old' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        owner: 'acme',
        repo: 'widgets',
        number: 7,
        pullRequestId: 'pr-old',
        alreadyClosed: false,
        commentPosted: false,
      });
      expect(comment).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith('ws-mine', 'acme', 'widgets', 7, { state: 'closed' });
      expect(await rowState('pr-old')).toBe('closed');
    });

    it('posts the comment before it closes the PR', async () => {
      const order: string[] = [];
      comment.mockImplementation(async () => void order.push('comment'));
      update.mockImplementation(async () => (order.push('close'), {}) as never);
      const res = await close({ pullRequestId: 'pr-old', comment: '  Replaced by #9.  ' });
      expect(res.status).toBe(200);
      expect(res.body.data.commentPosted).toBe(true);
      expect(comment).toHaveBeenCalledWith('ws-mine', 'acme', 'widgets', 7, 'Replaced by #9.');
      expect(order).toEqual(['comment', 'close']);
    });

    it.each([
      ['repository and number', { workspaceId: 'ws-mine', repository: 'acme/widgets', number: 7 }],
      ['a different letter case', { workspaceId: 'ws-mine', repository: 'ACME/Widgets', number: 7 }],
      ['a number as text', { workspaceId: 'ws-mine', repository: 'acme/widgets', number: '7' }],
    ])('finds the tracked row from %s', async (_label, body) => {
      const res = await close(body);
      expect(res.status).toBe(200);
      expect(res.body.data.pullRequestId).toBe('pr-old');
      expect(await rowState('pr-old')).toBe('closed');
    });

    it('closes an untracked PR of the user, with no row to refresh', async () => {
      getPr.mockResolvedValue(ghPr({ number: 99 }) as never);
      const res = await close({ workspaceId: 'ws-mine', repository: 'acme/widgets', number: 99 });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ number: 99, pullRequestId: null, alreadyClosed: false });
    });

    it.each([
      ['another login', 'someone-else'],
      ['an empty login', ''],
    ])('refuses a PR by %s and posts nothing', async (_label, login) => {
      getPr.mockResolvedValue(ghPr({ user: { login, avatar_url: '' } }) as never);
      const res = await close({ pullRequestId: 'pr-old', comment: 'bye' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_your_pull_request');
      expect(res.body.error).toContain('Talyn closes only your own pull requests');
      expect(comment).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(await rowState('pr-old')).toBe('open');
    });

    it('matches the author login without regard to letter case', async () => {
      getPr.mockResolvedValue(ghPr({ user: { login: 'TOM', avatar_url: '' } }) as never);
      expect((await close({ pullRequestId: 'pr-old' })).status).toBe(200);
    });

    it('refuses when it cannot read the user GitHub login', async () => {
      vi.spyOn(githubService, 'getViewerLogin').mockResolvedValue(null);
      const res = await close({ pullRequestId: 'pr-old' });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('could not read your GitHub login');
      expect(update).not.toHaveBeenCalled();
    });

    it('allows another author PR that a Talyn session opened', async () => {
      getPr.mockResolvedValue(ghPr({ number: 8, user: { login: 'talyn-bot', avatar_url: '' } }) as never);
      const res = await close({ pullRequestId: 'pr-session' });
      expect(res.status).toBe(200);
      expect(update).toHaveBeenCalled();
    });

    it('refuses another author PR when the linked session started after the PR', async () => {
      await db
        .update(workbenchesTable)
        .set({ createdAt: new Date(Date.parse(PR_CREATED) + 60 * 60_000) })
        .where(eq(workbenchesTable.id, 'wb-1'));
      getPr.mockResolvedValue(ghPr({ number: 8, user: { login: 'someone-else', avatar_url: '' } }) as never);
      const res = await close({ pullRequestId: 'pr-session' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_your_pull_request');
    });

    it('treats an already closed PR as a no-op and posts no comment', async () => {
      getPr.mockResolvedValue(ghPr({ state: 'closed' }) as never);
      const res = await close({ pullRequestId: 'pr-old', comment: 'bye' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ alreadyClosed: true, commentPosted: false });
      expect(comment).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(await rowState('pr-old')).toBe('closed');
    });

    it.each([
      ['merged is true', { merged: true, state: 'closed' as const }],
      ['merged_at is set', { merged_at: '2026-11-02T00:00:00Z', state: 'closed' as const }],
    ])('refuses a merged PR when %s', async (_label, over) => {
      getPr.mockResolvedValue(ghPr(over) as never);
      const res = await close({ pullRequestId: 'pr-old', comment: 'bye' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('pull_request_merged');
      expect(comment).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('says the comment was posted when the close then fails', async () => {
      update.mockRejectedValue(new GitHubApiError('GitHub API error 422: Validation Failed', 422));
      const res = await close({ pullRequestId: 'pr-old', comment: 'bye' });
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('close_failed');
      expect(res.body.error).toContain('Talyn posted the comment on acme/widgets#7');
      expect(await rowState('pr-old')).toBe('open');
    });

    it('does not close when the comment fails', async () => {
      comment.mockRejectedValue(new Error('boom'));
      const res = await close({ pullRequestId: 'pr-old', comment: 'bye' });
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('comment_failed');
      expect(update).not.toHaveBeenCalled();
    });

    it('answers 503 and closes nothing when GitHub rate limits the read', async () => {
      getPr.mockRejectedValue(new GitHubRateLimitError('rate limited', 30_000));
      const res = await close({ pullRequestId: 'pr-old', comment: 'bye' });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('rate_limited');
      expect(comment).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('answers 404 when GitHub has no such PR', async () => {
      getPr.mockRejectedValue(new GitHubApiError('GitHub API error 404: Not Found', 404));
      const res = await close({ workspaceId: 'ws-mine', repository: 'acme/widgets', number: 404 });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('pr_not_found');
    });

    it.each([
      ['no target', {}, 400],
      ['a bad repository', { workspaceId: 'ws-mine', repository: 'acme', number: 7 }, 400],
      ['a bad number', { workspaceId: 'ws-mine', repository: 'acme/widgets', number: 0 }, 400],
      ['a fractional number', { workspaceId: 'ws-mine', repository: 'acme/widgets', number: 1.5 }, 400],
      ['a comment that is not text', { pullRequestId: 'pr-old', comment: 5 }, 400],
      ['a comment over the GitHub limit', { pullRequestId: 'pr-old', comment: 'x'.repeat(MAX_CLOSE_COMMENT_CHARS + 1) }, 400],
      ['an unknown PR id', { pullRequestId: 'pr-missing' }, 404],
      ['a PR in another owner workspace', { pullRequestId: 'pr-theirs' }, 404],
      ['another owner workspace', { workspaceId: 'ws-other', repository: 'acme/widgets', number: 7 }, 404],
    ])('refuses %s', async (_label, body, status) => {
      const res = await close(body);
      expect(res.status).toBe(status);
      expect(update).not.toHaveBeenCalled();
      expect(comment).not.toHaveBeenCalled();
    });
  });

  describe('a session token', () => {
    it('closes the user superseded PR in the session repository', async () => {
      const res = await close({ sessionId: 'wb-1', repository: 'acme/widgets', number: 7, comment: 'Replaced by #8.' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ pullRequestId: 'pr-old', commentPosted: true });
      expect(await rowState('pr-old')).toBe('closed');
    });

    it('refuses a PR in another repository', async () => {
      getPr.mockResolvedValue(ghPr({ number: 3 }) as never);
      const res = await close({ sessionId: 'wb-1', pullRequestId: 'pr-api', comment: 'bye' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_session_repository');
      expect(getPr).not.toHaveBeenCalled();
      expect(comment).not.toHaveBeenCalled();
    });

    it('refuses the session own linked PR', async () => {
      const res = await close({ sessionId: 'wb-1', pullRequestId: 'pr-session', comment: 'bye' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('own_session_pull_request');
      expect(comment).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it.each([
      ['the same repository', { full_name: 'acme/widgets' }],
      ['an unknown head repository', null],
    ])('refuses an unlinked PR from the session branch in %s', async (_label, headRepo) => {
      getPr.mockResolvedValue(ghPr({ number: 99, head: { ref: 'tom/session-work', sha: 's', repo: headRepo } }) as never);
      const res = await close({ sessionId: 'wb-1', repository: 'acme/widgets', number: 99 });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('own_session_pull_request');
      expect(update).not.toHaveBeenCalled();
    });

    it('allows a fork PR whose branch name matches the session branch', async () => {
      getPr.mockResolvedValue(ghPr({ number: 99, head: { ref: 'tom/session-work', sha: 's', repo: { full_name: 'tom/widgets' } } }) as never);
      expect((await close({ sessionId: 'wb-1', repository: 'acme/widgets', number: 99 })).status).toBe(200);
    });

    it('still refuses another author PR', async () => {
      getPr.mockResolvedValue(ghPr({ user: { login: 'someone-else', avatar_url: '' } }) as never);
      const res = await close({ sessionId: 'wb-1', pullRequestId: 'pr-old' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('not_your_pull_request');
    });

    it('refuses every close from a thread', async () => {
      const res = await close({ sessionId: 'wb-thread', repository: 'acme/widgets', number: 7 });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('session_has_no_repository');
    });

    it('refuses a session outside the PR workspace', async () => {
      const res = await close({ sessionId: 'wb-missing', pullRequestId: 'pr-old' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('session_not_found');
    });

    it('answers 404 for an unknown session with no workspace', async () => {
      const res = await close({ sessionId: 'wb-missing', repository: 'acme/widgets', number: 7 });
      expect(res.status).toBe(404);
    });
  });
});
