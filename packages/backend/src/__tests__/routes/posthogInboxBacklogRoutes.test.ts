import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Workbench, WorkflowAction, WorkflowConditions } from '@talyn/shared';
import { validateWorkflow } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import { FakePostHog } from '../helpers/fakePostHogInbox.js';
import type { Database } from '../../db/client.js';
import { integrations, repositories, users, workflowRuns, workspaces as workspacesTable } from '../../db/schema.js';
import type { CreateWorkbenchServiceInput } from '../../services/workbenches/create.js';

/**
 * The PostHog Inbox backlog routes over real Express: the page
 * (`POST /posthog-inbox/backlog`) and "Run selected"
 * (`POST /:id/posthog-inbox/run`), with their gates (workspace access, the
 * `posthogInboxRules` flag), their input checks and their PostHog errors.
 * The session create is stubbed.
 */

vi.mock('../../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/websocket.js')>()),
  broadcastToWorkspace: () => undefined,
  broadcastToUser: () => undefined,
}));

const created: CreateWorkbenchServiceInput[] = [];
vi.mock('../../services/workbenches/create.js', () => ({
  createWorkbench: async (input: CreateWorkbenchServiceInput) => {
    created.push(input);
    const { insertWorkbench, rowToWorkbench } = await import('../../services/workbenches/store.js');
    const id = `wb-${created.length}`;
    const row = await insertWorkbench({
      id,
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      repoFullName: 'acme/web-app',
      name: id,
      branch: id,
      baseBranch: 'main',
      runtime: 'sandbox',
      agent: input.agent,
      model: input.model ?? null,
      status: 'provisioning',
      source: input.source ?? null,
    });
    return rowToWorkbench(row) as Workbench;
  },
}));

const { workflowRoutes } = await import('../../routes/workflows.js');
const { apiErrorHandler } = await import('../../routes/index.js');
const { wrapAsyncRoutes } = await import('../../middleware/asyncHandler.js');
const { internalProxyHeaders, requireAuth } = await import('../../middleware/auth.js');
const { _resetWorkflowStore, createWorkflow } = await import('../../services/workflows/store.js');
const { resetFeatureFlagsForTests } = await import('../../services/featureFlags.js');
const { resetWebAppUrlCacheForTests } = await import('../../services/webApp.js');
const { encryptString } = await import('../../services/tokenCrypto.js');
const { _resetClaimGatesForTests } = await import('../../services/posthogInbox/claims.js');

const HOST = 'https://us.posthog.com';
const MODEL = 'claude-sonnet-4-5';
const VERSION = '2026-11-14T00:00:00.000001Z';
const headers = { ...internalProxyHeaders(TEST_USER_ID), 'content-type': 'application/json' };
const realFetch = globalThis.fetch;

describe('PostHog Inbox backlog routes', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let server: Server;
  let posthog: FakePostHog;

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('POSTHOG_INBOX_RULES_ENABLED', 'true');
    vi.stubEnv('WEB_APP_URL', 'https://app.talyn.test');
    resetFeatureFlagsForTests();
    resetWebAppUrlCacheForTests();
    _resetWorkflowStore();
    _resetClaimGatesForTests();
    created.length = 0;

    posthog = new FakePostHog();
    posthog.filterList = true;
    posthog.listRepoSlug = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(String(input instanceof Request ? input.url : input));
      if (target.origin === HOST) return posthog.handle(target, init);
      return realFetch(input, init);
    });

    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await db.insert(workspacesTable).values({ id: 'ws-mine', ownerId: TEST_USER_ID, name: 'mine', settings: {} });
    await db
      .insert(repositories)
      .values({ id: 'r-web', workspaceId: 'ws-mine', name: 'acme/web-app', url: 'https://github.com/acme/web-app' });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/workflows', requireAuth, wrapAsyncRoutes(workflowRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workflows`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
    _resetWorkflowStore();
    _resetClaimGatesForTests();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  async function connect(workspaceId = 'ws-mine'): Promise<void> {
    await db.delete(integrations).where(eq(integrations.workspaceId, workspaceId));
    await db.insert(integrations).values({
      id: `int-${workspaceId}`,
      workspaceId,
      type: 'posthog',
      enabled: true,
      config: { apiKeyEnc: encryptString('phx_test'), projectId: '2', host: HOST, authMethod: 'personal_api_key' },
    });
  }

  /** An OAuth grant with these scopes. */
  async function connectWithOAuth(scope: string): Promise<void> {
    await db.delete(integrations).where(eq(integrations.workspaceId, 'ws-mine'));
    await db.insert(integrations).values({
      id: 'int-ws-mine',
      workspaceId: 'ws-mine',
      type: 'posthog',
      enabled: true,
      config: {
        projectId: '2',
        host: HOST,
        authMethod: 'oauth',
        oauth: {
          accessTokenEnc: encryptString('pha_access'),
          refreshTokenEnc: encryptString('phr_refresh'),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          scope,
          clientId: 'client',
        },
      },
    });
  }

  async function theirs(): Promise<void> {
    await seedUser(db, { id: 'user-other', email: 'other@example.test' });
    await db.insert(workspacesTable).values({ id: 'ws-theirs', ownerId: 'user-other', name: 'theirs', settings: {} });
    await connect('ws-theirs');
  }

  async function rule(workspaceId = 'ws-mine', conditions: WorkflowConditions = {}, extra: Record<string, unknown> = {}) {
    const action: WorkflowAction = { type: 'start_session', repositoryId: null, prompt: 'Fix the report.', model: MODEL };
    return createWorkflow(
      workspaceId,
      validateWorkflow({
        integration: 'posthog_inbox',
        name: 'Fix ready reports',
        events: ['report_ready'],
        conditions,
        actions: [action],
        ...extra,
      })
    );
  }

  async function githubRule() {
    return createWorkflow(
      'ws-mine',
      validateWorkflow({
        name: 'Label PRs',
        events: ['pr_opened'],
        conditions: {},
        actions: [{ type: 'add_labels', labels: ['x'] }],
      })
    );
  }

  function report(id: string, overrides: Parameters<FakePostHog['put']>[1] = {}) {
    return posthog.put(id, { created_at: new Date(Date.now() - 60 * 60_000).toISOString(), ...overrides });
  }

  type Json = { success: boolean; data: Record<string, unknown> | null; error?: string; code?: string };
  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Json };
  }
  const backlog = (body: unknown) => call('POST', '/posthog-inbox/backlog', body);
  const runReports = (id: string, body: unknown) => call('POST', `/${id}/posthog-inbox/run`, body);
  const listQuery = () =>
    new URL(`http://x${posthog.requests.find((r) => r.startsWith('/api/projects/2/signals/reports/?'))}`).searchParams;

  // ---- The backlog page -----------------------------------------------------------

  describe('POST /posthog-inbox/backlog', () => {
    it('answers one page for a saved rule', async () => {
      await connect();
      const wf = await rule();
      report('rep-1', { title: 'Checkout crashes', created_at: new Date(Date.now() - 60_000).toISOString() });
      report('rep-2', { status: 'suppressed', suppression_source: 'safety_judge', created_at: new Date(Date.now() - 120_000).toISOString() });
      const res = await backlog({ workspaceId: 'ws-mine', workflowId: wf.id });
      expect(res.status).toBe(200);
      expect(res.json.data).toEqual({
        rows: [
          expect.objectContaining({ id: 'rep-1', title: 'Checkout crashes', state: 'not_run', selectable: true, repository: 'acme/web-app' }),
          expect.objectContaining({ id: 'rep-2', state: 'held_back', selectable: false }),
        ],
        scanned: 2,
        nextOffset: null,
        total: 2,
        days: 7,
        workflowId: wf.id,
        runnable: true,
        notRunnableReason: null,
        dailyCap: 10,
        runsToday: 0,
      });
    });

    it.each<[unknown, number]>([
      [undefined, 7],
      [7, 7],
      [30, 30],
      ['90', 90],
      [14, 7],
      ['nope', 7],
    ])('reads days %j as %s', async (days, expected) => {
      await connect();
      const wf = await rule();
      const res = await backlog({ workspaceId: 'ws-mine', workflowId: wf.id, ...(days !== undefined ? { days } : {}) });
      expect(res.status).toBe(200);
      expect(res.json.data?.days).toBe(expected);
      const after = Date.parse(listQuery().get('created_after')!);
      expect(Math.abs(Date.now() - expected * 24 * 60 * 60_000 - after)).toBeLessThan(60_000);
    });

    it.each<[unknown, string]>([
      [undefined, '0'],
      [0, '0'],
      [25, '25'],
      ['50', '50'],
    ])('passes offset %j', async (offset, expected) => {
      await connect();
      const wf = await rule();
      const res = await backlog({ workspaceId: 'ws-mine', workflowId: wf.id, ...(offset !== undefined ? { offset } : {}) });
      expect(res.status).toBe(200);
      expect(listQuery().get('offset')).toBe(expected);
    });

    it.each([[-1], [1.5], ['abc'], [{}], [[1, 2]]])('refuses offset %j', async (offset) => {
      await connect();
      const wf = await rule();
      const res = await backlog({ workspaceId: 'ws-mine', workflowId: wf.id, offset });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/offset/);
      expect(posthog.requests).toEqual([]);
    });

    it("matches an unsaved rule's conditions, and nothing can run", async () => {
      await connect();
      report('rep-1', { priority: 'P2' });
      report('rep-2', { priority: 'P0' });
      const res = await backlog({ workspaceId: 'ws-mine', workflow: { conditions: { priorities: ['P2'] } } });
      expect(res.status).toBe(200);
      expect(res.json.data).toMatchObject({
        workflowId: null,
        runnable: false,
        notRunnableReason: 'Save the automation first. Then you can run reports.',
        dailyCap: null,
      });
      expect((res.json.data!.rows as Array<{ id: string; selectable: boolean }>).map((r) => [r.id, r.selectable])).toEqual([['rep-1', false]]);
      expect(listQuery().get('priority')).toBe('P2');
    });

    it("refuses to run while the editor's conditions differ from the saved rule's", async () => {
      await connect();
      const wf = await rule('ws-mine', { priorities: ['P0'] });
      report('rep-1', { priority: 'P1' });
      const res = await backlog({ workspaceId: 'ws-mine', workflowId: wf.id, workflow: { conditions: { priorities: ['P1'] } } });
      expect(res.json.data).toMatchObject({
        workflowId: wf.id,
        runnable: false,
        notRunnableReason: 'Save your changes first. Then you can run reports.',
      });
      const rows = res.json.data!.rows as Array<{ id: string; state: string; selectable: boolean }>;
      expect(rows.map((r) => [r.id, r.state, r.selectable])).toEqual([['rep-1', 'not_run', false]]);
    });

    it('treats the same conditions in another order as no change', async () => {
      await connect();
      const wf = await rule('ws-mine', { priorities: ['P0', 'P1'], titleContains: 'crash' });
      const res = await backlog({
        workspaceId: 'ws-mine',
        workflowId: wf.id,
        workflow: { conditions: { titleContains: 'crash', priorities: ['P0', 'P1'] } },
      });
      expect(res.json.data).toMatchObject({ runnable: true, notRunnableReason: null });
    });

    it('a disabled rule cannot run', async () => {
      await connect();
      const wf = await rule('ws-mine', {}, { enabled: false });
      const res = await backlog({ workspaceId: 'ws-mine', workflowId: wf.id });
      expect(res.json.data).toMatchObject({ runnable: false, notRunnableReason: 'Turn the automation on first. Then you can run reports.' });
    });

    it('counts the runs of the last day toward the cap', async () => {
      await connect();
      const wf = await rule('ws-mine', {}, { maxRunsPerDay: 5 });
      await db.insert(workflowRuns).values([
        { id: 'run-a', workflowId: wf.id, workspaceId: 'ws-mine', integration: 'posthog_inbox', event: 'report_ready', deliveryId: 'a', status: 'succeeded' },
        { id: 'run-b', workflowId: wf.id, workspaceId: 'ws-mine', integration: 'posthog_inbox', event: 'report_ready', deliveryId: 'b', status: 'skipped' },
      ]);
      const res = await backlog({ workspaceId: 'ws-mine', workflowId: wf.id });
      expect(res.json.data).toMatchObject({ dailyCap: 5, runsToday: 1 });
    });

    it('needs a workspace', async () => {
      const res = await backlog({ workflow: { conditions: {} } });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/workspaceId/);
    });

    it('needs a saved rule or conditions', async () => {
      await connect();
      const res = await backlog({ workspaceId: 'ws-mine' });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('workflowId or workflow.conditions is required');
    });

    it('refuses conditions that do not validate', async () => {
      await connect();
      const res = await backlog({ workspaceId: 'ws-mine', workflow: { conditions: { minSignalCount: 'many' } } });
      expect(res.status).toBe(400);
      expect(posthog.requests).toEqual([]);
    });

    it('answers 404 for an unknown rule', async () => {
      await connect();
      const res = await backlog({ workspaceId: 'ws-mine', workflowId: 'nope' });
      expect(res.status).toBe(404);
    });

    it("answers 404 for another workspace's rule, asked through mine", async () => {
      await connect();
      await theirs();
      const wf = await rule('ws-theirs');
      const res = await backlog({ workspaceId: 'ws-mine', workflowId: wf.id });
      expect(res.status).toBe(404);
      expect(res.json.error).toBe('Automation not found');
      expect(posthog.requests).toEqual([]);
    });

    it("refuses another workspace's backlog", async () => {
      await theirs();
      const wf = await rule('ws-theirs');
      for (const body of [{ workspaceId: 'ws-theirs', workflowId: wf.id }, { workspaceId: 'ws-theirs', workflow: { conditions: {} } }]) {
        const res = await backlog(body);
        expect([403, 404]).toContain(res.status);
      }
      expect(posthog.requests).toEqual([]);
    });

    it('refuses a rule that is not a PostHog Inbox rule', async () => {
      await connect();
      const wf = await githubRule();
      const res = await backlog({ workspaceId: 'ws-mine', workflowId: wf.id });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('Only a PostHog Inbox automation has a backlog.');
    });

    it('asks to connect PostHog first', async () => {
      const res = await backlog({ workspaceId: 'ws-mine', workflow: { conditions: {} } });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('posthog_inbox_unavailable');
    });

    it('reads with a grant that can read but not claim', async () => {
      await connectWithOAuth('inbox:read');
      report('rep-1');
      const res = await backlog({ workspaceId: 'ws-mine', workflow: { conditions: {} } });
      expect(res.status).toBe(200);
    });

    it.each<[number, string]>([
      [401, 'posthog_inbox_forbidden'],
      [403, 'posthog_inbox_forbidden'],
      [404, 'posthog_inbox_unreachable'],
      [500, 'posthog_inbox_unreachable'],
    ])('answers 502 when PostHog says %s', async (status, code) => {
      await connect();
      const wf = await rule();
      posthog.status = status;
      const res = await backlog({ workspaceId: 'ws-mine', workflowId: wf.id });
      expect(res.status).toBe(502);
      expect(res.json.code).toBe(code);
    });
  });

  // ---- Run selected ---------------------------------------------------------------

  describe('POST /:id/posthog-inbox/run', () => {
    it('starts sessions and records who ran them', async () => {
      await connect();
      await db.update(users).set({ githubUsername: 'tomgh' }).where(eq(users.id, TEST_USER_ID));
      const wf = await rule();
      report('rep-1');
      report('rep-2', { priority: 'P2', actionability: 'not_actionable' });
      const res = await runReports(wf.id, { reportIds: ['rep-1', 'rep-2', 'nope'] });
      expect(res.status).toBe(200);
      expect(res.json.data).toEqual({
        results: [
          { reportId: 'rep-1', outcome: 'started', message: 'Talyn started a session.', runId: expect.any(String), workbenchId: 'wb-1' },
          { reportId: 'rep-2', outcome: 'not_eligible', message: expect.stringMatching(/^The report no longer matches/), runId: null, workbenchId: null },
          { reportId: 'nope', outcome: 'not_found', message: 'PostHog does not have this report.', runId: null, workbenchId: null },
        ],
        requested: 3,
        started: 1,
        dailyCap: 10,
        summary: '1 of 3 started.',
      });
      expect(posthog.claimCalls).toEqual([{ reportId: 'rep-1', body: {} }]);
      const [row] = await db.select().from(workflowRuns);
      expect(row).toMatchObject({
        deliveryId: `posthog_inbox:rep-1:${VERSION}`,
        triggerSource: 'manual',
        triggeredByUserId: TEST_USER_ID,
        triggeredByLabel: 'tomgh',
      });

      const history = await call('GET', `/${wf.id}/runs`);
      expect(history.json.data).toEqual([expect.objectContaining({ trigger: 'manual', triggeredBy: 'tomgh' })]);
    });

    it('records the email when the user has no GitHub login', async () => {
      await connect();
      const wf = await rule();
      report('rep-1');
      await runReports(wf.id, { reportIds: ['rep-1'] });
      const [row] = await db.select().from(workflowRuns);
      expect(row.triggeredByLabel).toBe('tom@example.test');
    });

    it('answers 404 for an unknown rule', async () => {
      await connect();
      const res = await runReports('nope', { reportIds: ['rep-1'] });
      expect(res.status).toBe(404);
    });

    it("refuses another workspace's rule", async () => {
      await theirs();
      const wf = await rule('ws-theirs');
      report('rep-1');
      const res = await runReports(wf.id, { reportIds: ['rep-1'] });
      expect([403, 404]).toContain(res.status);
      expect(posthog.requests).toEqual([]);
      expect(created).toEqual([]);
    });

    it('refuses a rule that is not a PostHog Inbox rule', async () => {
      await connect();
      const wf = await githubRule();
      const res = await runReports(wf.id, { reportIds: ['rep-1'] });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('Only a PostHog Inbox automation can run reports.');
    });

    it.each<[string, unknown]>([
      ['no body', undefined],
      ['no ids', {}],
      ['an empty list', { reportIds: [] }],
      ['blank ids', { reportIds: ['', '  '] }],
      ['a string', { reportIds: 'rep-1' }],
      ['numbers', { reportIds: [1, 2] }],
      ['a mix', { reportIds: ['rep-1', null] }],
    ])('refuses %s', async (_name, body) => {
      await connect();
      const wf = await rule();
      const res = await runReports(wf.id, body);
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('reportIds must be a list of report ids.');
      expect(posthog.requests).toEqual([]);
    });

    it('refuses more than 20 reports', async () => {
      await connect();
      const wf = await rule();
      const res = await runReports(wf.id, { reportIds: Array.from({ length: 21 }, (_, i) => `rep-${i}`) });
      expect(res.status).toBe(400);
      expect(res.json.code).toBe('too_many_reports');
      expect(res.json.error).toBe('Select at most 20 reports at a time.');
      expect(posthog.requests).toEqual([]);
    });

    it('takes 21 ids that are 20 without repeats', async () => {
      await connect();
      const wf = await rule('ws-mine', {}, { maxRunsPerDay: 50 });
      const ids = Array.from({ length: 20 }, (_, i) => `rep-${i}`);
      const res = await runReports(wf.id, { reportIds: [...ids, ' rep-3 '] });
      expect(res.status).toBe(200);
      expect(res.json.data).toMatchObject({ requested: 20 });
      expect((res.json.data!.results as Array<{ reportId: string }>).map((r) => r.reportId)).toEqual(ids);
    });

    it('refuses a disabled rule', async () => {
      await connect();
      const wf = await rule('ws-mine', {}, { enabled: false });
      const res = await runReports(wf.id, { reportIds: ['rep-1'] });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('workflow_not_runnable');
      expect(res.json.error).toBe('Turn the automation on first. Then you can run reports.');
    });

    it('needs a connection', async () => {
      const wf = await rule();
      const res = await runReports(wf.id, { reportIds: ['rep-1'] });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('posthog_inbox_unavailable');
    });

    it('needs a connection that can claim', async () => {
      await connectWithOAuth('inbox:read');
      const wf = await rule();
      const res = await runReports(wf.id, { reportIds: ['rep-1'] });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('posthog_inbox_unavailable');
      expect(posthog.claimCalls).toEqual([]);
    });
  });

  // ---- Both routes ----------------------------------------------------------------

  describe('the flag', () => {
    it.each(['backlog', 'run'])('hides %s behind the flag', async (which) => {
      await connect();
      const wf = await rule();
      report('rep-1');
      vi.stubEnv('POSTHOG_INBOX_RULES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      const res =
        which === 'backlog'
          ? await backlog({ workspaceId: 'ws-mine', workflowId: wf.id })
          : await runReports(wf.id, { reportIds: ['rep-1'] });
      expect(res.status).toBe(404);
      expect(res.json.code).toBe('posthog_inbox_rules_unavailable');
      expect(posthog.requests).toEqual([]);
      expect(created).toEqual([]);
    });
  });
});
