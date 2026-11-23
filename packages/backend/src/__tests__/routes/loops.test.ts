import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import type { LoopRun, LoopWithStats } from '@talyn/shared';
import { loopRoutes } from '../../routes/loops.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  loops as loopsTable,
  repositories as reposTable,
  spaces as spacesTable,
  teamMembers as teamMembersTable,
  teams as teamsTable,
  workbenchChats as chatsTable,
  workbenches as workbenchesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import * as loopsAccess from '../../services/loopsAccess.js';
import * as registry from '../../services/cloudProviders/registry.js';
import * as fleetAccess from '../../services/cloudProviders/fleetAccess.js';
import * as fleetCredentials from '../../services/selfHosted/credentials.js';
import * as taskCreate from '../../services/taskCreate.js';
import * as workbenchReadiness from '../../services/workbenches/readiness.js';
import * as workbenchCreate from '../../services/workbenches/create.js';

/**
 * The loops API.
 *
 * What is pinned beyond CRUD:
 *   - the flag answers EVERY verb, because a hidden nav item is not a gate;
 *   - the refusal is a 403 that says why, not a 404;
 *   - PATCH is a whole-loop replace, so a partial body cannot land a
 *     provider/model pair the validator would refuse as a whole;
 *   - a validator message reaches the caller verbatim;
 *   - the checks the validator cannot make — the repository belongs to this
 *     workspace, the fleet agent is connected, the owner can start a session —
 *     are made here;
 *   - a schedule starts sessions only: no cloud task, no per-loop MCP servers.
 */

const OTHER_USER_ID = 'user-other';
const headers = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/loops', requireAuth, wrapAsyncRoutes(loopRoutes()));
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

const READY = {
  sandbox: {
    ok: true,
    reasons: [],
    agents: { claude: { ok: true }, codex: { ok: true } },
  },
} as const;

const body = (over: Record<string, unknown> = {}) => ({
  workspaceId: 'ws-mine',
  name: 'Morning triage',
  prompt: 'Fix yesterday’s failing checks.',
  cron: '0 9 * * 1-5',
  timezone: 'Europe/London',
  provider: 'selfhosted',
  model: 'claude-sonnet-5-5',
  target: 'session',
  repositoryId: 'repo-mine',
  repoFullName: 'acme/widget',
  ...over,
});

describe('loop routes', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;
  let mayUseLoops: MockInstance<typeof loopsAccess.workspaceMayUseLoops>;
  let createSession: MockInstance<typeof workbenchCreate.createWorkbench>;
  let createTask: MockInstance<typeof taskCreate.createCloudTask>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await seedUser(db, { id: OTHER_USER_ID, email: 'other@example.test' });
    await db.insert(workspacesTable).values([
      { id: 'ws-mine', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
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
        id: 'repo-theirs',
        workspaceId: 'ws-theirs',
        name: 'acme/other',
        url: 'https://github.com/acme/other',
        defaultBranch: 'main',
      },
    ]);
    ({ url, close } = await makeServer());
    delete process.env.LOOPS_ENABLED;
    mayUseLoops = vi.spyOn(loopsAccess, 'workspaceMayUseLoops').mockResolvedValue(true);
    vi.spyOn(registry, 'getCloudProvider').mockReturnValue({ type: 'selfhosted' } as never);
    vi.spyOn(fleetAccess, 'workspaceMayUseFleet').mockResolvedValue(true);
    vi.spyOn(fleetCredentials, 'fleetAgentStatus').mockResolvedValue({
      connectedAgents: ['claude', 'codex'],
      reauthAgents: [],
    });
    vi.spyOn(workbenchReadiness, 'workbenchReadiness').mockResolvedValue(READY as never);
    createTask = vi.spyOn(taskCreate, 'createCloudTask').mockRejectedValue(new Error('a loop must never create a task'));
    createSession = vi.spyOn(workbenchCreate, 'createWorkbench').mockImplementation(async (input) => {
      await db.insert(workbenchesTable).values({
        id: 'session-manual',
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId!,
        repoFullName: 'acme/widget',
        name: 'morning-triage',
        branch: 'morning-triage',
        baseBranch: 'main',
        runtime: 'sandbox',
        agent: input.agent,
        model: input.model,
        sandboxState: 'creating',
        status: 'provisioning',
        settings: { autoCreatePr: true },
        source: input.source,
      });
      await db.insert(chatsTable).values({
        id: 'chat-manual',
        workbenchId: 'session-manual',
        workspaceId: input.workspaceId,
        title: 'Morning triage',
        agent: input.agent,
        model: input.model,
        queuedMessages: [],
      });
      return { id: 'session-manual', workspaceId: input.workspaceId, chats: [{ id: 'chat-manual' }] } as never;
    });
  });

  afterEach(async () => {
    expect(createTask).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    delete process.env.LOOPS_ENABLED;
    await close();
    await cleanup();
  });

  async function create(over: Record<string, unknown> = {}): Promise<LoopWithStats> {
    const res = await fetch(`${url}/api/v1/loops`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body(over)),
    });
    const json = (await res.json()) as { success: boolean; data: LoopWithStats; error?: string };
    expect(json.success, json.error).toBe(true);
    return json.data;
  }

  it('creates, lists, counts and deletes', async () => {
    const made = await create();
    expect(made).toMatchObject({
      name: 'Morning triage',
      enabled: true,
      workspaceId: 'ws-mine',
      provider: 'selfhosted',
      target: 'session',
      mcpServerIds: null,
    });
    // The next run is computed on the write, so the list row renders a schedule
    // without waiting for the first sweep.
    expect(made.nextRunAt).toBeTruthy();
    expect(made.stats).toMatchObject({ runsTotal: 0, lastRunAt: null, lastStatus: null });

    const listed = await fetch(`${url}/api/v1/loops?workspaceId=ws-mine`, { headers });
    expect(((await listed.json()) as { data: LoopWithStats[] }).data.map((l) => l.id)).toEqual([
      made.id,
    ]);

    const counted = await fetch(`${url}/api/v1/loops/count?workspaceId=ws-mine`, { headers });
    expect(((await counted.json()) as { data: { enabled: number } }).data.enabled).toBe(1);

    const del = await fetch(`${url}/api/v1/loops/${made.id}`, { method: 'DELETE', headers });
    expect(del.status).toBe(200);
    const after = await fetch(`${url}/api/v1/loops?workspaceId=ws-mine`, { headers });
    expect(((await after.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('/count is matched before /:id', async () => {
    // Express matches in declaration order; declared the other way round,
    // `/count` is read as a loop id and 404s.
    const res = await fetch(`${url}/api/v1/loops/count?workspaceId=ws-mine`, { headers });
    expect(res.status).toBe(200);
  });

  describe('the flag gates every verb', () => {
    it.each([
      ['GET', '/api/v1/loops?workspaceId=ws-mine'],
      ['POST', '/api/v1/loops'],
    ])('%s %s is refused', async (method, path) => {
      mayUseLoops.mockResolvedValue(false);
      const res = await fetch(`${url}${path}`, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(body()) : undefined,
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as { code: string; error: string };
      // 403 with a reason, NOT 404: somebody who switched the feature off
      // should be able to tell that from a route that does not exist.
      expect(json.code).toBe('loops_unavailable');
      expect(json.error).toMatch(/not available/);
    });

    it('refuses PATCH and DELETE on a loop that already exists', async () => {
      const made = await create();
      mayUseLoops.mockResolvedValue(false);
      for (const method of ['PATCH', 'DELETE'] as const) {
        const res = await fetch(`${url}/api/v1/loops/${made.id}`, {
          method,
          headers,
          body: method === 'PATCH' ? JSON.stringify({ enabled: false }) : undefined,
        });
        expect(res.status).toBe(403);
      }
    });
  });

  it('requires a workspaceId before anything else', async () => {
    const res = await fetch(`${url}/api/v1/loops`, { headers });
    expect(res.status).toBe(400);
  });

  it('refuses another owner’s workspace as 404, not 403', async () => {
    // Not-found rather than forbidden, and that is `requireWorkspaceAccess`'s
    // call throughout: a 403 would confirm that the workspace exists to
    // somebody who is only guessing ids.
    const res = await fetch(`${url}/api/v1/loops?workspaceId=ws-theirs`, { headers });
    expect(res.status).toBe(404);
  });

  it('404s an unknown loop', async () => {
    const res = await fetch(`${url}/api/v1/loops/nope`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  describe('validation', () => {
    async function refused(over: Record<string, unknown>) {
      const res = await fetch(`${url}/api/v1/loops`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body(over)),
      });
      expect(res.status).toBe(400);
      return ((await res.json()) as { error: string }).error;
    }

    it.each([
      ['a Talyn Fleet model on PostHog Code', { provider: 'posthog_code', model: 'gpt-6.1-sol' }, /Talyn Fleet model/],
      ['a PostHog Code loop', { provider: 'posthog_code', model: 'claude-opus-5' }, /sessions run on Talyn Fleet/],
      ['a model the fleet cannot run', { model: 'not-a-model' }, /not a model Talyn Fleet can run/],
      ['a cloud task target', { target: 'task' }, /Schedules cannot start cloud tasks/],
      ['an unknown target', { target: 'banana' }, /target must be session/],
    ])('passes the validator’s message through verbatim for %s', async (_label, over, message) => {
      expect(await refused(over)).toMatch(message);
    });

    it.each([[[]], [['mcp-1']], [['mcp-1', 'mcp-2']]])('refuses a per-loop MCP selection %j', async (mcpServerIds) => {
      // A session uses the workspace MCP servers; even an empty list is a
      // selection the session would not honour.
      expect(await refused({ mcpServerIds })).toMatch(/A schedule cannot choose its own/);
    });

    it('accepts an explicit null MCP selection', async () => {
      const made = await create({ mcpServerIds: null });
      expect(made.mcpServerIds).toBeNull();
    });

    it('refuses a repository belonging to another workspace', async () => {
      // The check the shared validator cannot make: it has no database.
      expect(await refused({ repositoryId: 'repo-theirs', repoFullName: 'acme/other' })).toMatch(/not connected/);
    });

    it('refuses a loop when the workspace has no fleet access', async () => {
      vi.mocked(fleetAccess.workspaceMayUseFleet).mockResolvedValue(false);
      expect(await refused({})).toMatch(/Talyn Fleet/);
    });

    it.each([
      ['gpt-6.1-terra', ['claude'], /no Codex subscription/],
      ['claude-sonnet-5', ['codex'], /no Claude subscription/],
    ] as const)('refuses a %s loop whose agent is not connected', async (model, connected, message) => {
      // Saving a loop with no subscription for its agent would produce a loop
      // that fails every firing — refuse it while somebody is looking at it.
      vi.mocked(fleetCredentials.fleetAgentStatus).mockResolvedValue({
        connectedAgents: [...connected],
        reauthAgents: [],
      });
      expect(await refused({ model })).toMatch(message);
    });

    it('refuses a loop when the owner cannot start a session', async () => {
      vi.mocked(workbenchReadiness.workbenchReadiness).mockResolvedValue({
        sandbox: {
          ok: false,
          reasons: [{ code: 'flag_off', message: 'Sessions are not available: off.' }],
          agents: READY.sandbox.agents,
        },
      } as never);
      expect(await refused({})).toBe('Sessions are not available: off.');
      expect(workbenchReadiness.workbenchReadiness).toHaveBeenCalledWith(
        'ws-mine',
        expect.objectContaining({ id: TEST_USER_ID })
      );
    });

    it.each([
      ['claude-sonnet-5-5', 'claude'],
      ['gpt-6.1-sol', 'codex'],
    ])('creates a %s session loop when its fleet agent is available', async (model) => {
      const made = await create({ model });
      expect(made).toMatchObject({ target: 'session', provider: 'selfhosted', model });
    });

    it('defaults the target to session when the body leaves it out', async () => {
      const made = await create({ target: undefined });
      expect(made.target).toBe('session');
    });
  });

  describe('internet access', () => {
    it('refuses it on a PostHog Code loop', async () => {
      // Storing it there would be a setting the user can see and the dispatch
      // cannot keep. The validator refuses the provider first.
      const res = await fetch(`${url}/api/v1/loops`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body({ provider: 'posthog_code', model: 'claude-opus-5', internetAccess: true })),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/Talyn Fleet/);
    });

    it.each([
      [undefined, false],
      [false, false],
      [true, true],
    ])('stores internetAccess=%s as %s on a fleet loop', async (internetAccess, expected) => {
      const made = await create({ internetAccess });
      expect(made.internetAccess).toBe(expected);
    });
  });

  describe('PATCH', () => {
    it('is a whole-loop replace, and recomputes the schedule', async () => {
      const made = await create();
      const res = await fetch(`${url}/api/v1/loops/${made.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ cron: '0 17 * * *', name: 'Evening triage' }),
      });
      const json = (await res.json()) as { data: LoopWithStats };
      expect(json.data.name).toBe('Evening triage');
      expect(json.data.cron).toBe('0 17 * * *');
      // Unsent fields survive the replace — that is what makes it a replace of
      // the MERGED object rather than of the body.
      expect(json.data.prompt).toBe(made.prompt);
      expect(json.data.nextRunAt).not.toBe(made.nextRunAt);
    });

    it.each([
      ['an incoherent provider/model pair', { provider: 'posthog_code' }, /is a Talyn Fleet model/],
      ['a PostHog Code loop', { provider: 'posthog_code', model: 'claude-opus-5' }, /sessions run on Talyn Fleet/],
      ['a cloud task target', { target: 'task' }, /Schedules cannot start cloud tasks/],
      ['a per-loop MCP selection', { mcpServerIds: [] }, /A schedule cannot choose its own/],
    ])('refuses a partial body that lands %s', async (_label, patch, message) => {
      // A one-field merge is exactly how a loop ends up pinned to something it
      // cannot run. The whole object has to validate.
      const made = await create();
      const res = await fetch(`${url}/api/v1/loops/${made.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(patch),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    });

    it('switches a fleet loop to the other agent', async () => {
      const made = await create();
      const res = await fetch(`${url}/api/v1/loops/${made.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ model: 'gpt-6.1-sol' }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: LoopWithStats }).data).toMatchObject({
        provider: 'selfhosted',
        model: 'gpt-6.1-sol',
        target: 'session',
      });
    });

    it('clears next_run_at when the loop is switched off', async () => {
      const made = await create();
      const res = await fetch(`${url}/api/v1/loops/${made.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled: false }),
      });
      const json = (await res.json()) as { data: LoopWithStats };
      expect(json.data.enabled).toBe(false);
      expect(json.data.nextRunAt).toBeNull();
    });

    it('resumes from now when switched back on, rather than backfilling', async () => {
      const made = await create();
      await fetch(`${url}/api/v1/loops/${made.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled: false }),
      });
      const res = await fetch(`${url}/api/v1/loops/${made.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled: true }),
      });
      const json = (await res.json()) as { data: LoopWithStats };
      expect(new Date(json.data.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('history', () => {
    it('caps a page at 200 however much is asked for', async () => {
      const made = await create();
      const res = await fetch(`${url}/api/v1/loops/${made.id}/runs?limit=5000`, { headers });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
    });
  });

  describe('run now', () => {
    async function runNow(id: string) {
      const res = await fetch(`${url}/api/v1/loops/${id}/run`, { method: 'POST', headers });
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: LoopRun }).data;
    }

    it('dispatches through the same path the scheduler uses', async () => {
      const made = await create();
      const run = await runNow(made.id);
      expect(run).toMatchObject({
        trigger: 'manual',
        target: 'session',
        sessionId: 'session-manual',
        taskId: null,
        status: 'queued',
      });
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          runtime: 'sandbox',
          agent: 'claude',
          autoCreatePr: true,
          source: { kind: 'loop', loopId: made.id, runId: run.id },
        }),
        expect.objectContaining({ id: TEST_USER_ID })
      );
    });

    it('reports a refusal as the run’s own state, not as an HTTP error', async () => {
      // A manual run and a scheduled one must settle the same way. Answering
      // 402 here would make "Run now" a different code path from the schedule,
      // which is a test of something the schedule never does.
      const made = await create();
      // Take the provider away AFTER the loop is saved — exactly what a
      // disconnect does, and the reason dispatch re-checks what the route
      // already checked.
      vi.mocked(registry.getCloudProvider).mockReturnValue(undefined as never);
      const run = await runNow(made.id);
      expect(run.status).toBe('failed');
      expect(run.failureCode).toBe('environment_missing');
      expect(createSession).not.toHaveBeenCalled();
    });

    it('refuses a stored PostHog Code loop without creating a task or a session', async () => {
      const made = await create();
      await db
        .update(loopsTable)
        .set({ provider: 'posthog_code', model: 'claude-opus-5', target: 'task' })
        .where(eq(loopsTable.id, made.id));
      const run = await runNow(made.id);
      expect(run).toMatchObject({ status: 'failed', failureCode: 'environment_missing', taskId: null, sessionId: null });
      expect(run.error).toMatch(/choose a Talyn Fleet agent/);
      expect(createSession).not.toHaveBeenCalled();
    });
  });

  describe('a space for the runs', () => {
    const save = (method: 'POST' | 'PATCH', path: string, payload: Record<string, unknown>) =>
      fetch(`${url}/api/v1/loops${path}`, { method, headers, body: JSON.stringify(payload) });

    beforeEach(async () => {
      process.env.SPACES_ENABLED = 'true';
      await db.insert(teamsTable).values([{ id: 'team-1', name: 'Acme' }, { id: 'team-2', name: 'Other' }]);
      await db.insert(teamMembersTable).values([
        { id: 'm-1', teamId: 'team-1', githubUserId: 100, userId: TEST_USER_ID, githubLogin: 'tom', role: 'owner' },
      ]);
      await db.insert(spacesTable).values([
        { id: 'space-1', teamId: 'team-1', name: 'Web' },
        { id: 'space-3', teamId: 'team-1', name: 'Mobile' },
        { id: 'space-old', teamId: 'team-1', name: 'Old', archivedAt: new Date() },
        { id: 'space-2', teamId: 'team-2', name: 'Not mine' },
      ]);
    });

    afterEach(() => {
      delete process.env.SPACES_ENABLED;
    });

    it.each([
      ['no space', {}],
      ['a null space', { spaceId: null }],
      ['an empty space', { spaceId: '' }],
    ])('saves %s as Personal', async (_label, over) => {
      const made = await create(over);
      expect(made.spaceId).toBeNull();
      const [row] = await db.select().from(loopsTable).where(eq(loopsTable.id, made.id));
      expect(row.spaceId).toBeNull();
    });

    it('creates a loop with a space the caller is in, and lists it', async () => {
      const made = await create({ spaceId: 'space-1' });
      expect(made.spaceId).toBe('space-1');
      const listed = await fetch(`${url}/api/v1/loops?workspaceId=ws-mine`, { headers });
      expect(((await listed.json()) as { data: LoopWithStats[] }).data[0].spaceId).toBe('space-1');
    });

    it('updates the space, and clears it back to Personal', async () => {
      const made = await create();
      const moved = await save('PATCH', `/${made.id}`, { spaceId: 'space-3' });
      expect(moved.status).toBe(200);
      expect(((await moved.json()) as { data: LoopWithStats }).data.spaceId).toBe('space-3');

      // A PATCH that does not name the space keeps it.
      const renamed = await save('PATCH', `/${made.id}`, { name: 'Renamed' });
      expect(((await renamed.json()) as { data: LoopWithStats }).data.spaceId).toBe('space-3');

      const cleared = await save('PATCH', `/${made.id}`, { spaceId: null });
      expect(((await cleared.json()) as { data: LoopWithStats }).data.spaceId).toBeNull();
    });

    it.each([
      ['a space of another team', 'true', 'space-2', 'The space was not found, or you are not in its team.'],
      ['a space that does not exist', 'true', 'space-gone', 'The space was not found, or you are not in its team.'],
      ['an archived space', 'true', 'space-old', 'The space is archived.'],
      ['any space while Spaces is off', 'false', 'space-1', 'Spaces are not available for this account.'],
    ])('refuses to create a loop with %s', async (_label, flag, spaceId, error) => {
      process.env.SPACES_ENABLED = flag;
      const res = await save('POST', '', body({ spaceId }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ success: false, error, code: 'space_unavailable' });
      expect(await db.select().from(loopsTable)).toEqual([]);
    });

    it.each([
      ['a space of another team', 'space-2'],
      ['an archived space', 'space-old'],
    ])('refuses to update a loop to %s and keeps the old space', async (_label, spaceId) => {
      const made = await create({ spaceId: 'space-1' });
      const res = await save('PATCH', `/${made.id}`, { spaceId });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('space_unavailable');
      const [row] = await db.select().from(loopsTable).where(eq(loopsTable.id, made.id));
      expect(row.spaceId).toBe('space-1');
    });

    it('lets a loop keep a space the caller left, so it can still be edited', async () => {
      const made = await create({ spaceId: 'space-1' });
      await db.delete(teamMembersTable).where(eq(teamMembersTable.id, 'm-1'));

      const off = await save('PATCH', `/${made.id}`, { enabled: false });
      expect(off.status).toBe(200);
      expect(((await off.json()) as { data: LoopWithStats }).data.spaceId).toBe('space-1');
    });

    it('Run now starts the session in the loop’s space', async () => {
      const made = await create({ spaceId: 'space-1' });
      const res = await fetch(`${url}/api/v1/loops/${made.id}/run`, { method: 'POST', headers });
      const run = ((await res.json()) as { data: LoopRun }).data;
      expect(run).toMatchObject({ status: 'queued', notice: null });
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ spaceId: 'space-1' }),
        expect.objectContaining({ id: TEST_USER_ID })
      );
    });

    it('Run now starts in Personal and says why when the space was archived after the save', async () => {
      const made = await create({ spaceId: 'space-1' });
      await db.update(spacesTable).set({ archivedAt: new Date() }).where(eq(spacesTable.id, 'space-1'));
      const res = await fetch(`${url}/api/v1/loops/${made.id}/run`, { method: 'POST', headers });
      const run = ((await res.json()) as { data: LoopRun }).data;
      expect(run).toMatchObject({
        status: 'queued',
        notice: 'Started in Personal, not in the chosen space: The space is archived.',
      });
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ spaceId: null }), expect.anything());
    });
  });
});
