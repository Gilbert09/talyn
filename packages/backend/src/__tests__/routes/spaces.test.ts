import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { eq } from 'drizzle-orm';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createTestDb } from '../helpers/testDb.js';
import { FakeFleet, claudeTurnLines, isAgentTurn } from '../helpers/fakeFleet.js';
import {
  repositories,
  spaceRepositories,
  spaces,
  tasks,
  teamMembers,
  teams,
  users,
  workbenchEvents,
  workbenches,
  workspaces,
} from '../../db/schema.js';

/**
 * The Teams and Spaces routes end to end: the flag, membership, the space
 * listings with the repository check, create in a space, move, and the
 * teammate read path on the workbench routes.
 */

vi.mock('../../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/websocket.js')>()),
  broadcastToWorkspace: () => undefined,
}));

vi.mock('../../services/githubIdentity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/githubIdentity.js')>()),
  ensureGithubUserId: async () => null,
}));

vi.mock('../../services/selfHosted/credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/selfHosted/credentials.js')>()),
  getSelfHostedCredentials: async () => ({ claudeToken: 'sk-ant-oat-claude', openaiKey: 'oa-codex' }),
  fleetAgentStatus: async () => ({ connectedAgents: ['claude', 'codex'], reauthAgents: [] }),
}));

vi.mock('../../services/cloudProviders/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/cloudProviders/registry.js')>()),
  getCloudProvider: () => ({ type: 'selfhosted' }),
}));

vi.mock('../../services/repoDefaultBranch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/repoDefaultBranch.js')>()),
  reconcileDefaultBranch: async (input: { stored: string }) => input.stored || 'main',
}));

const { spaceRoutes } = await import('../../routes/spaces.js');
const { workbenchRoutes } = await import('../../routes/workbenches.js');
const { apiErrorHandler } = await import('../../routes/index.js');
const { wrapAsyncRoutes } = await import('../../middleware/asyncHandler.js');
const { GitHubApiError, githubService } = await import('../../services/github.js');
const { resetFeatureFlagsForTests } = await import('../../services/featureFlags.js');
const { resetRepoReadCacheForTests } = await import('../../services/teams/access.js');
const { SPACE_SESSION_COLUMNS, spaceSessionsQuery, spaceTasksQuery } = await import('../../services/teams/spaces.js');
const { SPACE_COLUMNS, SPACE_DETAIL_COLUMNS } = await import('../../services/teams/membership.js');
const { MAX_SPACE_IMAGE_LENGTH } = await import('@talyn/shared');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const { settleArchivesForTests } = await import('../../services/workbenches/lifecycle.js');
const { setWorkbenchFleetClientForTests } = await import('../../services/workbenches/sandboxRuntime.js');
const { getWorkbench, insertChat, insertWorkbench } = await import('../../services/workbenches/store.js');
const { createWorkbench } = await import('../../services/workbenches/create.js');
const { onWorkbenchEmit } = await import('../../services/workbenches/emit.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
interface Json {
  status: number;
  body: { success: boolean; data?: Loose; error?: string; code?: string };
}

// Ana owns the team and ws-a. Ben is a member with ws-b. Cy is a stranger.
const ANA = 'u-ana';
const BEN = 'u-ben';
const CY = 'u-cy';

describe('space routes', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;
  let fleet: FakeFleet;

  async function call(method: string, path: string, user: string, body?: unknown): Promise<Json> {
    const resp = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: resp.status, body: (await resp.json()) as Json['body'] };
  }

  async function seedSession(id: string, repoFullName: string, extra: Partial<typeof workbenches.$inferInsert> = {}) {
    await insertWorkbench({
      id,
      workspaceId: 'ws-a',
      repositoryId: repoFullName === 'acme/app' ? 'repo-a-app' : 'repo-a-secret',
      repoFullName,
      name: id,
      branch: `talyn/${id}`,
      baseBranch: 'main',
      runtime: 'sandbox',
      agent: 'claude',
      sandboxId: `sbx-${id}`,
      status: 'ready',
      spaceId: 'space-1',
      ...extra,
    });
    const chat = await insertChat({ id: `chat-${id}`, workbenchId: id, workspaceId: 'ws-a', title: 'Chat', agent: 'claude' });
    await testDb.db.insert(workbenchEvents).values({ chatId: chat.id, seq: 1, turn: 1, event: { type: 'user', text: 'hello' } });
  }

  async function seedThread(id: string, extra: Partial<typeof workbenches.$inferInsert> = {}) {
    await insertWorkbench({
      id,
      workspaceId: 'ws-a',
      kind: 'thread',
      repositoryId: null,
      repoFullName: '',
      name: id,
      branch: '',
      baseBranch: '',
      runtime: 'sandbox',
      agent: 'claude',
      sandboxId: `sbx-${id}`,
      status: 'ready',
      spaceId: 'space-1',
      ...extra,
    });
    await insertChat({ id: `chat-${id}`, workbenchId: id, workspaceId: 'ws-a', title: 'Thread', agent: 'claude' });
  }

  beforeEach(async () => {
    vi.stubEnv('SPACES_ENABLED', 'true');
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    vi.stubEnv('FLEET_API_TOKEN', 'fleet-token');
    vi.stubEnv('FLEET_PINNED_ENDPOINT', '');
    vi.stubEnv('FLEET_GATEWAY_TOKEN', '');
    vi.stubEnv('FLEET_ALLOWED', 'true');
    resetFeatureFlagsForTests();
    resetRepoReadCacheForTests();
    testDb = await createTestDb();
    await testDb.db.insert(users).values([
      { id: ANA, email: 'ana@x.test', githubUserId: 100, githubUsername: 'ana' },
      { id: BEN, email: 'ben@x.test', githubUserId: 200, githubUsername: 'ben' },
      { id: CY, email: 'cy@x.test', githubUserId: 300, githubUsername: 'cy' },
    ]);
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: ANA, name: 'A' },
      { id: 'ws-b', ownerId: BEN, name: 'B' },
      { id: 'ws-c', ownerId: CY, name: 'C' },
    ]);
    await testDb.db.insert(repositories).values([
      { id: 'repo-a-app', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main' },
      { id: 'repo-a-secret', workspaceId: 'ws-a', name: 'acme/secret', url: 'https://github.com/acme/secret', defaultBranch: 'main' },
    ]);
    await testDb.db.insert(teams).values([{ id: 'team-1', name: 'Acme' }, { id: 'team-2', name: 'Other' }]);
    await testDb.db.insert(teamMembers).values([
      { id: 'm-ana', teamId: 'team-1', githubUserId: 100, userId: ANA, githubLogin: 'ana', role: 'owner' },
      { id: 'm-ben', teamId: 'team-1', githubUserId: 200, userId: BEN, githubLogin: 'ben' },
      { id: 'm-cy', teamId: 'team-2', githubUserId: 300, userId: CY, githubLogin: 'cy', role: 'owner' },
    ]);
    await testDb.db.insert(spaces).values([
      { id: 'space-1', teamId: 'team-1', name: 'Web' },
      { id: 'space-old', teamId: 'team-1', name: 'Old', archivedAt: new Date() },
      { id: 'space-2', teamId: 'team-2', name: 'Other' },
    ]);
    await testDb.db.insert(spaceRepositories).values([
      { spaceId: 'space-1', repoFullName: 'acme/app' },
      { spaceId: 'space-1', repoFullName: 'acme/secret' },
    ]);

    // Ben's GitHub account can read acme/app but not acme/secret.
    vi.spyOn(githubService, 'canAccessRepository').mockImplementation(async (_ws, _owner, repo) => repo !== 'secret');
    vi.spyOn(githubService, 'branchExists').mockResolvedValue(false);
    vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    fleet = new FakeFleet();
    fleet.handler = async (script) => {
      if (isAgentTurn(script) || isAgentTurn(script, 'codex')) return { stdout: claudeTurnLines('sess-1', 'done') };
      if (script.includes('git commit-tree')) return { stdout: `${'c'.repeat(40)}\n` };
      return { exitCode: 0, stdout: '' };
    };
    setWorkbenchFleetClientForTests(async () => fleet.asClient());

    const app = express();
    // The production limit (index.ts), so a too-large space image reaches the route's own check.
    app.use(express.json({ limit: '2mb' }));
    app.use((req, _res, next) => {
      const id = req.headers['x-user'] as string;
      req.user = { id, email: `${id}@example.test`, isAdmin: false };
      next();
    });
    app.use('/', wrapAsyncRoutes(spaceRoutes()));
    app.use('/workbenches', wrapAsyncRoutes(workbenchRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await settleArchivesForTests();
    setWorkbenchFleetClientForTests(null);
    await new Promise((r) => server.close(r));
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
  });

  it.each([
    ['GET', '/teams'],
    ['GET', '/spaces/space-1/sessions'],
    ['POST', '/teams/team-1/spaces'],
    ['PUT', '/workbenches/wb-x/space'],
    ['POST', '/teams/team-1/invites'],
    ['POST', '/team-invites/accept'],
  ])('refuses %s %s when the spaces flag is off', async (method, path) => {
    vi.stubEnv('SPACES_ENABLED', 'false');
    resetFeatureFlagsForTests();
    const res = await call(method, path, ANA, method === 'GET' ? undefined : {});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('spaces_unavailable');
  });

  describe('teams and spaces', () => {
    it('lists my teams with my role and the live spaces', async () => {
      const res = await call('GET', '/teams', BEN);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        expect.objectContaining({ id: 'team-1', role: 'member', homeWorkspaceId: 'ws-b', spaces: [expect.objectContaining({ id: 'space-1' })] }),
      ]);
    });

    it('creates a team and a space in it', async () => {
      const team = await call('POST', '/teams', CY, { name: 'Cy Co' });
      expect(team.status).toBe(201);
      expect(team.body.data).toMatchObject({ name: 'Cy Co', role: 'owner', homeWorkspaceId: 'ws-c' });
      const space = await call('POST', `/teams/${team.body.data.id}/spaces`, CY, { name: 'API', color: '#4F46E5' });
      expect(space.status).toBe(201);
      expect(space.body.data).toMatchObject({ name: 'API', color: '#4f46e5' });
    });

    it.each([
      [{ name: '' }, 400],
      [{ name: 'Ok', color: 'red' }, 400],
      [{ name: 'Ok', image: 42 }, 400],
      [{ name: 'Ok', image: 'https://example.com/a.png' }, 400],
      [{ name: 'Ok', image: 'data:image/svg+xml;base64,PHN2Zz4=' }, 400],
      [{ name: 'Ok', image: 'data:text/html;base64,PGI+' }, 400],
      [{ name: 'Ok', image: 'data:image/png,not-base64' }, 400],
      [{ name: 'Ok', image: 'data:image/png;base64,!!!' }, 400],
    ])('refuses the space body %j', async (body, status) => {
      expect((await call('POST', '/teams/team-1/spaces', ANA, body)).status).toBe(status);
    });

    it('refuses a space image over the size cap', async () => {
      const image = `data:image/png;base64,${'A'.repeat(MAX_SPACE_IMAGE_LENGTH)}`;
      const res = await call('POST', '/teams/team-1/spaces', ANA, { name: 'Big', image });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/too large/);
    });

    it.each([
      ['png', PNG],
      ['jpeg', 'data:image/jpeg;base64,/9j/4AAQ'],
      ['webp', 'data:image/webp;base64,UklGRg=='],
      ['gif', 'data:image/gif;base64,R0lGODlh'],
    ])('creates a space with a %s image and lists it', async (_kind, image) => {
      const space = await call('POST', '/teams/team-1/spaces', ANA, { name: 'Pics', image });
      expect(space.status).toBe(201);
      expect(space.body.data).toMatchObject({ name: 'Pics', image });
      const listed = (await call('GET', '/teams', BEN)).body.data[0].spaces;
      expect(listed).toEqual(expect.arrayContaining([expect.objectContaining({ id: space.body.data.id, image })]));
    });

    it.each([
      ['an absent image', undefined, null],
      ['a null image', null, null],
      ['an empty image', '', null],
    ])('creates a space with no image for %s', async (_label, image, stored) => {
      const space = await call('POST', '/teams/team-1/spaces', ANA, { name: 'Plain', ...(image === undefined ? {} : { image }) });
      expect(space.status).toBe(201);
      expect(space.body.data.image).toBe(stored);
    });

    it('sets, keeps and removes the image of a space', async () => {
      const set = await call('PATCH', '/spaces/space-1', BEN, { image: PNG });
      expect(set.status).toBe(200);
      expect(set.body.data.image).toBe(PNG);

      const renamed = await call('PATCH', '/spaces/space-1', BEN, { name: 'Renamed' });
      expect(renamed.body.data).toMatchObject({ name: 'Renamed', image: PNG });

      const removed = await call('PATCH', '/spaces/space-1', BEN, { image: null });
      expect(removed.status).toBe(200);
      expect(removed.body.data.image).toBeNull();
      const [row] = await testDb.db.select({ image: spaces.image }).from(spaces).where(eq(spaces.id, 'space-1'));
      expect(row!.image).toBeNull();
    });

    it('refuses a bad image on update and keeps the old one', async () => {
      await testDb.db.update(spaces).set({ image: PNG }).where(eq(spaces.id, 'space-1'));
      const res = await call('PATCH', '/spaces/space-1', BEN, { image: 'data:image/svg+xml;base64,PHN2Zz4=' });
      expect(res.status).toBe(400);
      const [row] = await testDb.db.select({ image: spaces.image }).from(spaces).where(eq(spaces.id, 'space-1'));
      expect(row!.image).toBe(PNG);
    });

    it('refuses to set the image of a space for a stranger', async () => {
      expect((await call('PATCH', '/spaces/space-1', CY, { image: PNG })).status).toBe(404);
    });

    it('keeps the inline image out of the access-check projection', () => {
      expect(Object.keys(SPACE_COLUMNS)).not.toContain('image');
      expect(Object.keys(SPACE_DETAIL_COLUMNS)).toContain('image');
    });

    it('invites a member through the caller GitHub account', async () => {
      vi.spyOn(githubService, 'isConnected').mockReturnValue(true);
      const lookup = vi.spyOn(githubService, 'getAccountByLogin').mockResolvedValue({ id: 300, login: 'cy', avatarUrl: null });
      const res = await call('POST', '/teams/team-1/members', ANA, { githubLogin: '@cy' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ githubLogin: 'cy', role: 'member', source: 'invite', signedUp: true });
      expect(lookup).toHaveBeenCalledWith('ws-a', 'cy');
      expect((await call('GET', '/spaces/space-1/sessions', CY)).status).toBe(200);
    });

    it.each([
      [BEN, 403],
      [CY, 404],
    ])('refuses an invite from %s', async (user, status) => {
      vi.spyOn(githubService, 'isConnected').mockReturnValue(true);
      const lookup = vi.spyOn(githubService, 'getAccountByLogin').mockResolvedValue({ id: 999, login: 'x', avatarUrl: null });
      expect((await call('POST', '/teams/team-1/members', user, { githubLogin: 'x' })).status).toBe(status);
      if (status === 404) expect(lookup).not.toHaveBeenCalled();
    });

    it('changes a role and refuses removing the last owner', async () => {
      expect((await call('PATCH', '/teams/team-1/members/m-ben', ANA, { role: 'admin' })).body.data.role).toBe('admin');
      expect((await call('DELETE', '/teams/team-1/members/m-ana', ANA)).status).toBe(409);
      expect((await call('PUT', '/teams/team-1/home-workspace', BEN, { workspaceId: 'ws-a' })).status).toBe(404);
      expect((await call('PUT', '/teams/team-1/home-workspace', BEN, { workspaceId: 'ws-b' })).body.data).toEqual({ homeWorkspaceId: 'ws-b' });
    });

    it('adds a repository the caller can read, and refuses one they cannot', async () => {
      vi.spyOn(githubService, 'getRepository').mockImplementation(async (_ws, owner, repo) => {
        if (repo === 'hidden') throw new GitHubApiError('nope', 404);
        return { id: 42, name: repo, full_name: `${owner}/${repo}`, default_branch: 'main' } as Loose;
      });
      const added = await call('POST', '/spaces/space-1/repositories', BEN, { repoFullName: 'acme/api' });
      expect(added.status).toBe(201);
      expect(added.body.data).toMatchObject({ repoFullName: 'acme/api', githubRepoId: 42 });
      expect((await call('POST', '/spaces/space-1/repositories', BEN, { repoFullName: 'acme/hidden' })).status).toBe(404);
      expect((await call('POST', '/spaces/space-1/repositories', CY, { repoFullName: 'acme/api' })).status).toBe(404);
      expect((await call('DELETE', '/spaces/space-1/repositories/acme/api', BEN)).status).toBe(200);
      const repos = await call('GET', '/spaces/space-1/repositories', BEN);
      expect(repos.body.data.map((r: Loose) => r.repoFullName)).toEqual(['acme/app', 'acme/secret']);
    });

    it('archives a space for its creator or a manager only', async () => {
      await testDb.db.update(spaces).set({ createdByUserId: ANA }).where(eq(spaces.id, 'space-1'));
      expect((await call('DELETE', '/spaces/space-1', BEN)).status).toBe(403);
      expect((await call('DELETE', '/spaces/space-1', ANA)).status).toBe(200);
      expect((await call('GET', '/teams', BEN)).body.data[0].spaces).toEqual([]);
    });
  });

  describe('invites by email', () => {
    const tokenOf = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').pop()!);

    // No email provider: the link comes back to the inviter.
    beforeEach(() => {
      vi.stubEnv('RESEND_API_KEY', '');
    });

    it('invites by email, then the invitee previews and accepts with the link', async () => {
      const invited = await call('POST', '/teams/team-1/invites', ANA, { email: 'Cy.Work@Example.com' });
      expect(invited.status).toBe(201);
      expect(invited.body.data).toMatchObject({ emailSent: false, invite: { email: 'cy.work@example.com' } });
      const token = tokenOf(invited.body.data.acceptUrl);

      const pending = await call('GET', '/teams/team-1/invites', ANA);
      expect(pending.body.data).toEqual([expect.objectContaining({ email: 'cy.work@example.com', invitedByLogin: 'ana' })]);

      expect((await call('GET', '/spaces/space-1/sessions', CY)).status).toBe(404);
      const preview = await call('POST', '/team-invites/preview', CY, { token });
      expect(preview.body.data).toMatchObject({ teamId: 'team-1', teamName: 'Acme', alreadyMember: false });
      const accepted = await call('POST', '/team-invites/accept', CY, { token });
      expect(accepted.status).toBe(200);
      expect(accepted.body.data).toMatchObject({ id: 'team-1', role: 'member', homeWorkspaceId: 'ws-c' });
      expect((await call('GET', '/spaces/space-1/sessions', CY)).status).toBe(200);
      expect((await call('POST', '/team-invites/accept', CY, { token })).status).toBe(404);
      expect((await call('GET', '/teams/team-1/invites', ANA)).body.data).toEqual([]);
    });

    it.each([
      [BEN, 403],
      [CY, 404],
    ])('refuses email invites from %s', async (user, status) => {
      expect((await call('POST', '/teams/team-1/invites', user, { email: 'x@example.com' })).status).toBe(status);
      expect((await call('GET', '/teams/team-1/invites', user)).status).toBe(status);
    });

    it('revokes an invite so its link stops working', async () => {
      const invited = await call('POST', '/teams/team-1/invites', ANA, { email: 'x@example.com' });
      const token = tokenOf(invited.body.data.acceptUrl);
      expect((await call('DELETE', `/teams/team-1/invites/${invited.body.data.invite.id}`, ANA)).status).toBe(200);
      expect((await call('POST', '/team-invites/preview', CY, { token })).status).toBe(404);
    });

    it.each([{}, { token: 12 }, { token: 'nope' }])('answers 404 for the accept body %j', async (body) => {
      expect((await call('POST', '/team-invites/accept', CY, body)).status).toBe(404);
    });
  });

  describe('space listings', () => {
    it('shows a member the teammate sessions they can read, and counts the rest', async () => {
      await seedSession('wb-app', 'acme/app');
      await seedSession('wb-secret', 'acme/secret');
      await seedSession('wb-old', 'acme/app', { archivedAt: new Date() });
      await seedSession('wb-personal', 'acme/app', { spaceId: null });

      const asBen = await call('GET', '/spaces/space-1/sessions', BEN);
      expect(asBen.status).toBe(200);
      expect(asBen.body.data.hiddenCount).toBe(1);
      expect(asBen.body.data.items.map((r: Loose) => [r.id, r.status])).toEqual([
        ['wb-app', 'ready'],
        ['wb-old', 'archived'],
      ]);
      const row = asBen.body.data.items[0];
      expect(row.creator).toEqual({ userId: ANA, githubLogin: 'ana', avatarUrl: 'https://avatars.githubusercontent.com/u/100?v=4' });
      for (const key of ['sandboxId', 'deviceId', 'localPath', 'settings', 'fleetHost', 'source']) {
        expect(row).not.toHaveProperty(key);
      }

      const asAna = await call('GET', '/spaces/space-1/sessions', ANA);
      expect(asAna.body.data.hiddenCount).toBe(0);
      expect(asAna.body.data.items).toHaveLength(3);
    });

    it('shows a thread and its sessions to the owner, and counts the thread as hidden for a teammate', async () => {
      await seedThread('th-1');
      await seedSession('wb-child', 'acme/app', { threadId: 'th-1' });
      await seedSession('wb-secret-child', 'acme/secret', { threadId: 'th-1' });

      const asBen = await call('GET', '/spaces/space-1/sessions', BEN);
      expect(asBen.status).toBe(200);
      expect(asBen.body.data.items.map((r: Loose) => [r.id, r.kind, r.threadId])).toEqual([['wb-child', 'session', 'th-1']]);
      expect(asBen.body.data.hiddenCount).toBe(2);

      const asAna = await call('GET', '/spaces/space-1/sessions', ANA);
      expect(asAna.body.data.hiddenCount).toBe(0);
      const rows = new Map(asAna.body.data.items.map((r: Loose) => [r.id, r]));
      expect(rows.get('th-1')).toMatchObject({ kind: 'thread', threadId: null, repoFullName: '', spaceId: 'space-1' });
      expect(rows.get('wb-child')).toMatchObject({ kind: 'session', threadId: 'th-1' });
      expect(rows.get('wb-secret-child')).toMatchObject({ kind: 'session', threadId: 'th-1' });
    });

    it.each([
      ['a live thread', {}],
      ['an archived thread', { archivedAt: new Date() }],
    ])('keeps %s owner-only for every teammate', async (_name, extra) => {
      await seedThread('th-1', extra);
      const canRead = vi.spyOn(githubService, 'canAccessRepository').mockResolvedValue(true);
      const asBen = await call('GET', '/spaces/space-1/sessions', BEN);
      expect(asBen.body.data).toEqual({ items: [], hiddenCount: 1 });
      expect(canRead).not.toHaveBeenCalled();
      expect((await call('GET', '/workbenches/th-1', BEN)).status).toBe(404);
      expect((await call('GET', '/workbenches/chats/chat-th-1/events', BEN)).status).toBe(404);
      expect((await call('GET', '/spaces/space-1/sessions', ANA)).body.data.items.map((r: Loose) => r.id)).toEqual(['th-1']);
    });

    it.each([
      [CY, 'space-1'],
      [BEN, 'space-2'],
      [BEN, 'space-gone'],
    ])('answers 404 to %s for %s', async (user, spaceId) => {
      expect((await call('GET', `/spaces/${spaceId}/sessions`, user)).status).toBe(404);
      expect((await call('GET', `/spaces/${spaceId}/tasks`, user)).status).toBe(404);
    });

    it('lists the tasks of a space without prompt, metadata or result', async () => {
      await testDb.db.insert(tasks).values([
        { id: 't-app', workspaceId: 'ws-a', type: 'code_writing', title: 'App', description: 'd', prompt: 'secret prompt', repositoryId: 'repo-a-app', spaceId: 'space-1', metadata: { x: 1 } },
        { id: 't-secret', workspaceId: 'ws-a', type: 'code_writing', title: 'Secret', description: 'd', repositoryId: 'repo-a-secret', spaceId: 'space-1' },
        { id: 't-norepo', workspaceId: 'ws-a', type: 'code_writing', title: 'No repo', description: 'd', spaceId: 'space-1' },
      ]);
      const res = await call('GET', '/spaces/space-1/tasks', BEN);
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((t: Loose) => t.id)).toEqual(['t-app']);
      expect(res.body.data.hiddenCount).toBe(2);
      expect(res.body.data.items[0]).toMatchObject({ repoFullName: 'acme/app', creator: { userId: ANA } });
      for (const key of ['prompt', 'description', 'metadata', 'result', 'transcript']) {
        expect(res.body.data.items[0]).not.toHaveProperty(key);
      }
    });

    it('selects no sandbox, device, path, setting or credential column', () => {
      const sessionSql = spaceSessionsQuery('space-1', false).toSQL().sql;
      for (const column of ['sandbox_id', 'sandbox_generation', 'device_id', 'local_path', '"settings"', 'fleet_host', '"source"', 'work_save_error', 'config']) {
        expect(sessionSql).not.toContain(column);
      }
      expect(Object.keys(SPACE_SESSION_COLUMNS)).toEqual(expect.arrayContaining(['kind', 'threadId']));
      expect(sessionSql).toContain('"thread_id"');
      expect(spaceSessionsQuery('space-1', true).toSQL().params).toEqual(expect.arrayContaining(['session', 'thread']));
      const taskSql = spaceTasksQuery('space-1').toSQL().sql;
      for (const column of ['transcript', '"metadata"', '"result"', '"prompt"', '"description"', 'last_summary']) {
        expect(taskSql).not.toContain(column);
      }
    });
  });

  describe('teammate reads of a session', () => {
    beforeEach(async () => {
      await seedSession('wb-app', 'acme/app');
      await seedSession('wb-secret', 'acme/secret');
      await seedSession('wb-personal', 'acme/app', { spaceId: null });
    });

    it('lets a member read the session without its sandbox, device or path', async () => {
      const res = await call('GET', '/workbenches/wb-app', BEN);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: 'wb-app', spaceId: 'space-1', sandboxId: null, deviceId: null, localPath: null });
      expect(res.body.data.chats).toHaveLength(1);
      expect((await call('GET', '/workbenches/wb-app', ANA)).body.data.sandboxId).toBe('sbx-wb-app');
    });

    it('lets a member read the transcript', async () => {
      const res = await call('GET', '/workbenches/chats/chat-wb-app/events', BEN);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body.data)).toContain('hello');
    });

    it.each([
      ['a repository the member cannot read', BEN, 'wb-secret'],
      ['a session in Personal', BEN, 'wb-personal'],
      ['a stranger', CY, 'wb-app'],
    ])('answers 404 for %s', async (_name, user, id) => {
      expect((await call('GET', `/workbenches/${id}`, user)).status).toBe(404);
      expect((await call('GET', `/workbenches/chats/chat-${id}/events`, user)).status).toBe(404);
    });

    it('answers 404 to a member when the spaces flag is off', async () => {
      vi.stubEnv('SPACES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      expect((await call('GET', '/workbenches/wb-app', BEN)).status).toBe(404);
    });

    it.each([
      ['PATCH', '/workbenches/wb-app', { title: 'Mine now' }],
      ['POST', '/workbenches/chats/chat-wb-app/resume/cancel', {}],
      ['POST', '/workbenches/wb-app/archive', {}],
      ['GET', '/workbenches/wb-app/timing', undefined],
      ['GET', '/workbenches/chats/chat-wb-app/checkpoints', undefined],
    ])('keeps %s %s owner-only', async (method, path, body) => {
      expect((await call(method, path, BEN, body)).status).toBe(404);
    });
  });

  describe('create and move', () => {
    it('starts a session in the member home workspace and adds the repository there', async () => {
      vi.spyOn(githubService, 'getRepository').mockResolvedValue({ id: 7, name: 'app', full_name: 'acme/app', default_branch: 'main' } as Loose);
      const res = await call('POST', '/spaces/space-1/sessions', BEN, { repoFullName: 'ACME/app', agent: 'claude', prompt: 'Fix the bug' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ workspaceId: 'ws-b', addedRepository: true });
      expect(res.body.data.workbench).toMatchObject({ workspaceId: 'ws-b', spaceId: 'space-1', repoFullName: 'acme/app' });
      const id = res.body.data.workbench.id;
      await vi.waitFor(async () => expect((await getWorkbench(id))?.status).toBe('ready'), { timeout: 5000 });
      expect((await getWorkbench(id))?.spaceId).toBe('space-1');

      const listed = await call('GET', '/spaces/space-1/sessions', ANA);
      expect(listed.body.data.items.map((r: Loose) => [r.id, r.creator.userId])).toEqual([[id, BEN]]);
    });

    it('reuses a repository the home workspace already has', async () => {
      const res = await call('POST', '/spaces/space-1/sessions', ANA, { repoFullName: 'acme/app', agent: 'claude' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ workspaceId: 'ws-a', addedRepository: false });
      expect(res.body.data.workbench.repositoryId).toBe('repo-a-app');
      await vi.waitFor(async () => expect((await getWorkbench(res.body.data.workbench.id))?.status).toBe('ready'), { timeout: 5000 });
    });

    it.each([
      ['a repository outside the space', 'space-1', BEN, { repoFullName: 'acme/other', agent: 'claude' }, 400],
      ['a bad repository name', 'space-1', BEN, { repoFullName: 'nope', agent: 'claude' }, 400],
      ['an archived space', 'space-old', BEN, { repoFullName: 'acme/app', agent: 'claude' }, 409],
      ['a stranger', 'space-1', CY, { repoFullName: 'acme/app', agent: 'claude' }, 404],
    ])('refuses %s', async (_name, spaceId, user, body, status) => {
      expect((await call('POST', `/spaces/${spaceId}/sessions`, user, body)).status).toBe(status);
    });

    it('starts a thread in the member home workspace, with no repository', async () => {
      const res = await call('POST', '/spaces/space-1/sessions', BEN, { kind: 'thread', agent: 'claude', prompt: 'Plan the release', name: 'release-plan' });
      expect(res.status, res.body.error).toBe(200);
      expect(res.body.data).toMatchObject({ workspaceId: 'ws-b', addedRepository: false });
      expect(res.body.data.workbench).toMatchObject({
        kind: 'thread', workspaceId: 'ws-b', spaceId: 'space-1', repositoryId: null, repoFullName: '', branch: '', name: 'release-plan',
      });
      const id = res.body.data.workbench.id;
      await vi.waitFor(async () => expect((await getWorkbench(id))?.status).toBe('ready'), { timeout: 5000 });
      expect(await getWorkbench(id)).toMatchObject({ kind: 'thread', spaceId: 'space-1', repositoryId: null });
      expect(await testDb.db.select({ id: repositories.id }).from(repositories).where(eq(repositories.workspaceId, 'ws-b'))).toEqual([]);

      const asBen = await call('GET', '/spaces/space-1/sessions', BEN);
      expect(asBen.body.data.items.map((r: Loose) => [r.id, r.kind])).toEqual([[id, 'thread']]);
      const asAna = await call('GET', '/spaces/space-1/sessions', ANA);
      expect(asAna.body.data).toEqual({ items: [], hiddenCount: 1 });
    });

    it.each([
      ['a repository', { repoFullName: 'acme/app' }],
      ['a branch', { branch: 'feature' }],
      ['a base branch', { baseBranch: 'main' }],
      ['an empty repository', { repoFullName: '' }],
    ])('refuses a thread with %s', async (_name, extra) => {
      const res = await call('POST', '/spaces/space-1/sessions', BEN, { kind: 'thread', agent: 'claude', ...extra });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('A thread takes no repository, branch or base branch.');
      expect(await testDb.db.select({ id: workbenches.id }).from(workbenches)).toEqual([]);
    });

    it.each([
      ['an unknown kind', 'space-1', BEN, { kind: 'folder', agent: 'claude' }, 400],
      ['a bad agent', 'space-1', BEN, { kind: 'thread', agent: 'gpt' }, 400],
      ['an archived space', 'space-old', BEN, { kind: 'thread', agent: 'claude' }, 409],
      ['a stranger', 'space-1', CY, { kind: 'thread', agent: 'claude' }, 404],
    ])('refuses a thread for %s', async (_name, spaceId, user, body, status) => {
      expect((await call('POST', `/spaces/${spaceId}/sessions`, user, body)).status).toBe(status);
    });

    it('puts a session that a thread starts in the space of the thread', async () => {
      await seedThread('th-1');
      const res = await call('POST', '/workbenches', ANA, {
        workspaceId: 'ws-a', repositoryId: 'repo-a-app', runtime: 'sandbox', agent: 'claude', threadId: 'th-1',
      });
      expect(res.status, res.body.error).toBe(200);
      expect(res.body.data).toMatchObject({ threadId: 'th-1', spaceId: 'space-1' });
      await vi.waitFor(async () => expect((await getWorkbench(res.body.data.id))?.status).toBe('ready'), { timeout: 5000 });
      expect((await getWorkbench(res.body.data.id))?.spaceId).toBe('space-1');
    });

    it.each([
      ['inherits the thread space when none is given', 'space-1', undefined, 'space-1'],
      ['stays in Personal when the thread is in Personal', null, undefined, null],
      ['keeps an explicit space over the thread space', 'space-1', 'space-3', 'space-3'],
      ['keeps an explicit Personal over the thread space', 'space-1', null, null],
      ['keeps an explicit space when the thread is in Personal', null, 'space-3', 'space-3'],
    ])('a session in a thread %s', async (_name, threadSpace, explicit, expected) => {
      await testDb.db.insert(spaces).values({ id: 'space-3', teamId: 'team-1', name: 'API' });
      await seedThread('th-1', { spaceId: threadSpace });
      const created = await createWorkbench(
        {
          workspaceId: 'ws-a', repositoryId: 'repo-a-app', runtime: 'sandbox', agent: 'claude', threadId: 'th-1',
          ...(explicit === undefined ? {} : { spaceId: explicit }),
        },
        { id: ANA, email: 'ana@x.test' }
      );
      expect(created).toMatchObject({ threadId: 'th-1', spaceId: expected });
      await vi.waitFor(async () => expect((await getWorkbench(created.id))?.status).toBe('ready'), { timeout: 5000 });
    });

    it.each([
      ['keeps the space of a session in a space', 'space-1'],
      ['stays in Personal for a session in Personal', null],
    ])('continue as thread %s', async (_name, sessionSpace) => {
      await seedSession('wb-c', 'acme/app', { spaceId: sessionSpace });
      const res = await call('POST', '/workbenches/wb-c/thread', ANA, {});
      expect(res.status, res.body.error).toBe(200);
      expect(res.body.data).toMatchObject({ kind: 'thread', spaceId: sessionSpace });
      expect((await getWorkbench(res.body.data.id))?.spaceId ?? null).toBe(sessionSpace);
      await vi.waitFor(async () => expect((await getWorkbench(res.body.data.id))?.status).toBe('ready'), { timeout: 5000 });
    });

    it('moves a thread with its live sessions, leaves archived ones, and moves them back to Personal', async () => {
      await seedThread('th-1', { spaceId: null });
      await seedSession('wb-live', 'acme/app', { spaceId: null, threadId: 'th-1' });
      await seedSession('wb-live-2', 'acme/secret', { spaceId: 'space-1', threadId: 'th-1' });
      await seedSession('wb-archived', 'acme/app', { spaceId: null, threadId: 'th-1', archivedAt: new Date() });
      await seedSession('wb-other', 'acme/app', { spaceId: null });
      const emitted: Array<[string, string | null]> = [];
      const stop = onWorkbenchEmit({ workbench: (wb) => emitted.push([wb.id, wb.spaceId ?? null]) });
      try {
        expect((await call('PUT', '/workbenches/th-1/space', BEN, { spaceId: 'space-1' })).status).toBe(404);
        expect((await call('PUT', '/workbenches/th-1/space', ANA, { spaceId: 'space-2' })).status).toBe(404);
        expect(emitted).toEqual([]);

        const moved = await call('PUT', '/workbenches/th-1/space', ANA, { spaceId: 'space-1' });
        expect(moved.status).toBe(200);
        expect(moved.body.data).toMatchObject({ id: 'th-1', kind: 'thread', spaceId: 'space-1' });
        const spaceOf = async (id: string) => (await getWorkbench(id))?.spaceId ?? null;
        expect(await Promise.all(['th-1', 'wb-live', 'wb-live-2', 'wb-archived', 'wb-other'].map(spaceOf))).toEqual([
          'space-1', 'space-1', 'space-1', null, null,
        ]);
        expect([...emitted].sort()).toEqual([['th-1', 'space-1'], ['wb-live', 'space-1'], ['wb-live-2', 'space-1']]);

        emitted.length = 0;
        const back = await call('PUT', '/workbenches/th-1/space', ANA, { spaceId: null });
        expect(back.body.data.spaceId).toBeNull();
        expect(await Promise.all(['th-1', 'wb-live', 'wb-live-2', 'wb-archived', 'wb-other'].map(spaceOf))).toEqual([
          null, null, null, null, null,
        ]);
        expect([...emitted].sort()).toEqual([['th-1', null], ['wb-live', null], ['wb-live-2', null]]);
      } finally {
        stop();
      }
    });

    it('moves only the session itself when a session moves', async () => {
      await seedThread('th-1', { spaceId: null });
      await seedSession('wb-live', 'acme/app', { spaceId: null, threadId: 'th-1' });
      await seedSession('wb-sibling', 'acme/app', { spaceId: null, threadId: 'th-1' });
      expect((await call('PUT', '/workbenches/wb-live/space', ANA, { spaceId: 'space-1' })).status).toBe(200);
      expect((await getWorkbench('th-1'))?.spaceId).toBeNull();
      expect((await getWorkbench('wb-sibling'))?.spaceId).toBeNull();
    });

    it('lets only the owner move a session, and only into a space of their team', async () => {
      await seedSession('wb-app', 'acme/app', { spaceId: null });
      expect((await call('PUT', '/workbenches/wb-app/space', BEN, { spaceId: 'space-1' })).status).toBe(404);
      expect((await call('PUT', '/workbenches/wb-app/space', ANA, { spaceId: 'space-2' })).status).toBe(404);
      expect((await call('PUT', '/workbenches/wb-app/space', ANA, { spaceId: 'space-old' })).status).toBe(409);
      expect((await call('PUT', '/workbenches/wb-app/space', ANA, {})).status).toBe(400);
      const moved = await call('PUT', '/workbenches/wb-app/space', ANA, { spaceId: 'space-1' });
      expect(moved.status).toBe(200);
      expect(moved.body.data.spaceId).toBe('space-1');
      const back = await call('PUT', '/workbenches/wb-app/space', ANA, { spaceId: null });
      expect(back.body.data.spaceId).toBeNull();
      expect((await getWorkbench('wb-app'))?.spaceId).toBeNull();
    });

    it('lets only the owner move a task', async () => {
      await testDb.db.insert(tasks).values({ id: 't-1', workspaceId: 'ws-a', type: 'code_writing', title: 'T', description: 'd', repositoryId: 'repo-a-app' });
      expect((await call('PUT', '/tasks/t-1/space', BEN, { spaceId: 'space-1' })).status).toBe(404);
      expect((await call('PUT', '/tasks/t-1/space', ANA, { spaceId: 'space-2' })).status).toBe(404);
      const moved = await call('PUT', '/tasks/t-1/space', ANA, { spaceId: 'space-1' });
      expect(moved.status).toBe(200);
      expect(moved.body.data).toMatchObject({ id: 't-1', spaceId: 'space-1' });
      expect((await call('GET', '/spaces/space-1/tasks', BEN)).body.data.items.map((t: Loose) => t.id)).toEqual(['t-1']);
      expect((await call('PUT', '/tasks/t-missing/space', ANA, { spaceId: null })).status).toBe(404);
    });
  });
});
