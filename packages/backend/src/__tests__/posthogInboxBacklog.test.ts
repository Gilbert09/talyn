import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Workbench, WorkflowAction, WorkflowConditions, WorkflowDefinition } from '@talyn/shared';
import { validateWorkflow } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { FakePostHog, type FakeReport } from './helpers/fakePostHogInbox.js';
import { externalIssueLinks, integrations, pullRequests, repositories, workflowRuns, workspaces } from '../db/schema.js';
import type { CreateWorkbenchServiceInput } from '../services/workbenches/create.js';

/**
 * The PostHog Inbox backlog against a database and a fake PostHog: the page
 * (paging, time range, the state of each row, what can be selected, the
 * daily cap) and "Run selected" (the claim path, a lost claim, the dedupe,
 * the daily cap split, a report that changed since the list) and the
 * engine's manual run. The session create is stubbed.
 */

vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: () => undefined,
  broadcastToUser: () => undefined,
}));

const created: Array<{ input: CreateWorkbenchServiceInput; claimCallsBefore: number }> = [];
let posthog: FakePostHog;

vi.mock('../services/workbenches/create.js', () => ({
  createWorkbench: async (input: CreateWorkbenchServiceInput) => {
    created.push({ input, claimCallsBefore: posthog.claimCalls.length });
    const { insertWorkbench, rowToWorkbench } = await import('../services/workbenches/store.js');
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

const { encryptString } = await import('../services/tokenCrypto.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { resetWebAppUrlCacheForTests } = await import('../services/webApp.js');
const { _resetWorkflowStore, createWorkflow, listWorkflowRuns } = await import('../services/workflows/store.js');
const { ingestPostHogReport } = await import('../services/posthogInbox/ingest.js');
const { getPostHogInboxConnection } = await import('../services/posthogInbox/connection.js');
const { _resetClaimGatesForTests } = await import('../services/posthogInbox/claims.js');
const { posthogInboxBacklog, runPostHogInboxReports, runsInLastDay, BACKLOG_PAGE_SIZE } = await import(
  '../services/posthogInbox/backlog.js'
);
const { runWorkflowManually } = await import('../services/workflows/engine.js');
const { posthogInboxWorkflowSource, posthogInboxDeliveryId } = await import('../services/workflows/sources/posthogInbox.js');
const { reportToFacts } = await import('../services/posthogInbox/facts.js');

const MODEL = 'claude-sonnet-4-5';
const HOST = 'https://us.posthog.com';
const PR_URL = 'https://github.com/acme/web-app/pull/31';
const VERSION = '2026-11-14T00:00:00.000001Z';
const DAY = 24 * 60 * 60_000;
const MANUAL = { userId: 'u1', label: 'tom' };
const realFetch = globalThis.fetch;

describe('PostHog Inbox backlog', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  /** Runs before the fake answers a request, to stage a race. */
  let beforeAnswer: ((url: URL) => Promise<void>) | null;
  let now: Date;

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('POSTHOG_INBOX_RULES_ENABLED', 'true');
    vi.stubEnv('WEB_APP_URL', 'https://app.talyn.test');
    resetFeatureFlagsForTests();
    resetWebAppUrlCacheForTests();
    _resetWorkflowStore();
    _resetClaimGatesForTests();
    created.length = 0;
    beforeAnswer = null;
    now = new Date();

    posthog = new FakePostHog();
    posthog.filterList = true;
    posthog.listRepoSlug = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.origin === HOST) {
        if (beforeAnswer) await beforeAnswer(url);
        return posthog.handle(url, init);
      }
      return realFetch(input, init);
    });

    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'u1', email: 'owner@example.test' });
    await testDb.db.insert(workspaces).values({ id: 'ws1', ownerId: 'u1', name: 'One' });
    await testDb.db
      .insert(repositories)
      .values({ id: 'r-web', workspaceId: 'ws1', name: 'acme/web-app', url: 'https://github.com/acme/web-app' });
    await testDb.db.insert(integrations).values({
      id: 'int-1',
      workspaceId: 'ws1',
      type: 'posthog',
      enabled: true,
      config: { apiKeyEnc: encryptString('phx_test'), projectId: '2', host: HOST, authMethod: 'personal_api_key' },
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    _resetWorkflowStore();
    _resetClaimGatesForTests();
    resetFeatureFlagsForTests();
    await testDb?.cleanup();
  });

  async function rule(conditions: WorkflowConditions = {}, extra: Record<string, unknown> = {}) {
    const action: WorkflowAction = { type: 'start_session', repositoryId: null, prompt: 'Fix the report.', model: MODEL };
    return createWorkflow(
      'ws1',
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

  async function connection() {
    const c = await getPostHogInboxConnection('ws1');
    if (!c) throw new Error('no connection');
    return c;
  }

  /** A ready report, created `ageDays` ago. */
  function report(id: string, overrides: Partial<FakeReport> = {}, ageDays = 1): FakeReport {
    return posthog.put(id, { created_at: new Date(now.getTime() - ageDays * DAY).toISOString(), ...overrides });
  }

  async function page(
    workflow: WorkflowDefinition | null,
    opts: Partial<Parameters<typeof posthogInboxBacklog>[1]> = {}
  ) {
    return posthogInboxBacklog(await connection(), {
      conditions: workflow?.conditions ?? {},
      workflow,
      days: 7,
      offset: 0,
      now,
      ...opts,
    });
  }

  async function run(workflow: WorkflowDefinition, ids: string[]) {
    return runPostHogInboxReports(await connection(), workflow, ids, MANUAL);
  }

  const runs = () => testDb.db.select().from(workflowRuns).orderBy(workflowRuns.createdAt);
  const links = () => testDb.db.select().from(externalIssueLinks).orderBy(externalIssueLinks.createdAt);
  const listRequests = () => posthog.requests.filter((r) => r.startsWith('/api/projects/2/signals/reports/?'));
  const reads = (id: string) => posthog.requests.filter((r) => r === `/api/projects/2/signals/reports/${id}/`).length;

  async function insertRun(workflowId: string, deliveryId: string, opts: { status?: string; createdAt?: Date } = {}) {
    const id = randomUUID();
    await testDb.db.insert(workflowRuns).values({
      id,
      workflowId,
      workspaceId: 'ws1',
      integration: 'posthog_inbox',
      event: 'report_ready',
      deliveryId,
      status: opts.status ?? 'succeeded',
      createdAt: opts.createdAt ?? new Date(),
    });
    return id;
  }

  /** Ingest one report the event way, so a run, a link and a claim exist. */
  async function ingested(reportId: string) {
    await ingestPostHogReport(await connection(), reportId);
    const link = (await links()).find((l) => l.externalId === reportId);
    if (!link) throw new Error('no link');
    return link;
  }

  // ---- The page ---------------------------------------------------------------

  describe('paging and time range', () => {
    it('reads 25 reports a page, newest created first, and says where the next page starts', async () => {
      const wf = await rule();
      for (let i = 0; i < 30; i++) report(`rep-${String(i).padStart(2, '0')}`, {}, i / 10);

      const first = await page(wf);
      expect(first.rows).toHaveLength(BACKLOG_PAGE_SIZE);
      expect(first.rows[0].id).toBe('rep-00');
      expect(first).toMatchObject({ scanned: 25, nextOffset: 25, total: 30, days: 7, workflowId: wf.id });

      const second = await page(wf, { offset: 25 });
      expect(second.rows.map((r) => r.id)).toEqual(['rep-25', 'rep-26', 'rep-27', 'rep-28', 'rep-29']);
      expect(second).toMatchObject({ scanned: 5, nextOffset: null, total: 30 });

      const [q1, q2] = listRequests().map((r) => new URL(`http://x${r}`).searchParams);
      expect(q1.get('offset')).toBe('0');
      expect(q2.get('offset')).toBe('25');
      expect(q2.get('limit')).toBe('25');
    });

    it('sends the rule filters to PostHog', async () => {
      const wf = await rule({
        priorities: ['P1', 'P0'],
        sourceProducts: ['error_tracking'],
        scouts: { include: ['crash-scout'] },
        titleContains: 'checkout',
        actionability: ['immediately_actionable', 'requires_human_input'],
      });
      await page(wf);
      const q = new URL(`http://x${listRequests()[0]}`).searchParams;
      expect(Object.fromEntries(q)).toEqual({
        status: 'ready,suppressed',
        actionability: 'immediately_actionable,requires_human_input',
        priority: 'P0,P1',
        source_product: 'error_tracking',
        scout: 'crash-scout',
        search: 'checkout',
        created_after: new Date(now.getTime() - 7 * DAY).toISOString(),
        ordering: '-created_at',
        include_source_metadata: 'true',
        limit: '25',
        offset: '0',
      });
    });

    it.each([7, 30, 90] as const)('sends created_after for %s days and keeps only reports created since', async (days) => {
      const wf = await rule();
      report('rep-new', {}, 1);
      report('rep-20d', {}, 20);
      report('rep-60d', {}, 60);
      report('rep-120d', {}, 120);
      const res = await page(wf, { days });
      const q = new URL(`http://x${listRequests()[0]}`).searchParams;
      expect(q.get('created_after')).toBe(new Date(now.getTime() - days * DAY).toISOString());
      const expected = { 7: ['rep-new'], 30: ['rep-new', 'rep-20d'], 90: ['rep-new', 'rep-20d', 'rep-60d'] }[days];
      expect(res.rows.map((r) => r.id)).toEqual(expected);
      expect(res.days).toBe(days);
    });

    it.each<[string, { count?: number; next?: string | null; n: number }, number | null, number | null]>([
      ['a next link', { count: 60, next: 'https://us.posthog.com/next', n: 25 }, 25, 60],
      ['an empty next link', { count: 25, next: '', n: 25 }, null, 25],
      ['a null next link on a full page', { count: 25, next: null, n: 25 }, null, 25],
      ['no next field on a full page', { n: 25 }, 25, null],
      ['no next field on a short page', { n: 3 }, null, null],
      ['no rows', { count: 0, next: null, n: 0 }, null, 0],
    ])('reads paging from %s', async (_name, shape, nextOffset, total) => {
      const wf = await rule();
      const c = await connection();
      const rows = Array.from({ length: shape.n }, (_, i) => ({
        ...posthog.put(`rep-${i}`, { created_at: now.toISOString() }),
      }));
      vi.spyOn(c.client, 'listReports').mockResolvedValue({
        results: rows,
        ...(shape.count !== undefined ? { count: shape.count } : {}),
        ...(shape.next !== undefined ? { next: shape.next } : {}),
      });
      const res = await posthogInboxBacklog(c, { conditions: {}, workflow: wf, days: 7, offset: 0, now });
      expect(res.nextOffset).toBe(nextOffset);
      expect(res.total).toBe(total);
      expect(res.scanned).toBe(shape.n);
    });

    it('reads at most one page of rows even when PostHog sends more, and copes with no results list', async () => {
      const wf = await rule();
      const c = await connection();
      const rows = Array.from({ length: 30 }, (_, i) => posthog.put(`rep-${i}`, { created_at: now.toISOString() }));
      const spy = vi.spyOn(c.client, 'listReports').mockResolvedValueOnce({ results: rows, count: 30, next: 'n' });
      expect((await posthogInboxBacklog(c, { conditions: {}, workflow: wf, days: 7, offset: 0, now })).scanned).toBe(25);
      spy.mockResolvedValueOnce({ results: null as unknown as [] });
      const empty = await posthogInboxBacklog(c, { conditions: {}, workflow: wf, days: 7, offset: 0, now });
      expect(empty).toMatchObject({ rows: [], scanned: 0, nextOffset: null, total: null });
    });

    it('throws a PostHog refusal to the caller', async () => {
      const wf = await rule();
      posthog.status = 403;
      await expect(page(wf)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('row states', () => {
    it('shows a report the rule would act on as not run and selectable, with its facts', async () => {
      const wf = await rule();
      report('rep-1', { title: 'Checkout crashes', priority: 'P0', signal_count: 7, source_products: ['error_tracking'] });
      const res = await page(wf);
      expect(res.rows).toEqual([
        {
          id: 'rep-1',
          title: 'Checkout crashes',
          url: `${HOST}/project/2/inbox/rep-1`,
          priority: 'P0',
          actionability: 'immediately_actionable',
          repository: 'acme/web-app',
          sourceProducts: ['error_tracking'],
          signalCount: 7,
          createdAt: expect.any(String),
          updatedAt: VERSION,
          state: 'not_run',
          selectable: true,
          runId: null,
          workbenchId: null,
          pullRequestId: null,
          prUrl: null,
        },
      ]);
      expect(res).toMatchObject({ runnable: true, notRunnableReason: null });
      // A list row with `repo_slug` needs no second read.
      expect(reads('rep-1')).toBe(0);
    });

    it('shows a report Talyn works on as running, with its session and pull request', async () => {
      const wf = await rule();
      report('rep-1');
      const link = await ingested('rep-1');
      await testDb.db
        .insert(pullRequests)
        .values({ id: 'pr-1', workspaceId: 'ws1', repositoryId: 'r-web', owner: 'acme', repo: 'web-app', number: 31, state: 'open' });
      await testDb.db
        .update(externalIssueLinks)
        .set({ pullRequestId: 'pr-1', posthogClaimPrUrl: PR_URL })
        .where(eq(externalIssueLinks.id, link.id));
      const [row] = (await page(wf)).rows;
      expect(row).toMatchObject({
        state: 'running',
        selectable: false,
        runId: link.runId,
        workbenchId: 'wb-1',
        pullRequestId: 'pr-1',
        prUrl: PR_URL,
      });
    });

    it('shows a running report even when PostHog marks it addressed or held by Talyn', async () => {
      const wf = await rule();
      report('rep-1');
      await ingested('rep-1');
      report('rep-1', { already_addressed: true });
      expect((await page(wf)).rows[0].state).toBe('running');
    });

    it('shows a version the rule already ran as already run, with the run and its session', async () => {
      const wf = await rule();
      report('rep-1');
      const link = await ingested('rep-1');
      await testDb.db.update(externalIssueLinks).set({ status: 'done' }).where(eq(externalIssueLinks.id, link.id));
      posthog.claims.get('rep-1')!.released = true;
      const [row] = (await page(wf)).rows;
      expect(row).toMatchObject({ state: 'already_run', selectable: false, runId: link.runId, workbenchId: 'wb-1' });
    });

    it('reads a run row with the same delivery id as already run, without a link', async () => {
      const wf = await rule();
      report('rep-1');
      const runId = await insertRun(wf.id, `posthog_inbox:rep-1:${VERSION}`);
      const [row] = (await page(wf)).rows;
      expect(row).toMatchObject({ state: 'already_run', runId, workbenchId: null });
    });

    it("does not count another rule's run, or another version's run", async () => {
      const wf = await rule();
      const other = await rule({}, { name: 'Other' });
      report('rep-1');
      await insertRun(other.id, `posthog_inbox:rep-1:${VERSION}`);
      await insertRun(wf.id, 'posthog_inbox:rep-1:2026-11-01T00:00:00.000001Z');
      expect((await page(wf)).rows[0].state).toBe('not_run');
    });

    it.each([
      ['a person', 'person:alice'],
      ['another agent', 'some-agent'],
    ])('shows a report %s holds as claimed elsewhere', async (_who, holder) => {
      const wf = await rule();
      report('rep-1');
      posthog.claimByOther('rep-1', holder);
      expect((await page(wf)).rows[0]).toMatchObject({ state: 'claimed_elsewhere', selectable: false });
    });

    it.each<[string, Partial<FakeReport>, string]>([
      ['an open PR of somebody else', { implementation_pr_url: PR_URL, implementation_pr_state: 'open' }, 'claimed_elsewhere'],
      ['a draft PR of somebody else', { implementation_pr_url: PR_URL, implementation_pr_state: 'draft' }, 'claimed_elsewhere'],
      ['a merged PR', { implementation_pr_url: PR_URL, implementation_pr_state: 'merged' }, 'not_run'],
      ['a closed PR', { implementation_pr_url: PR_URL, implementation_pr_state: 'closed' }, 'not_run'],
      ['an explicit assignee', { assignee: { kind: 'user' } }, 'claimed_elsewhere'],
      ['an explicit null assignee', { assignee: null }, 'not_run'],
    ])('reads %s', async (_name, overrides, state) => {
      const wf = await rule();
      report('rep-1', overrides);
      expect((await page(wf)).rows[0].state).toBe(state);
    });

    it("shows Talyn's own stale claim on a newer version as already run", async () => {
      const wf = await rule();
      report('rep-1');
      const link = await ingested('rep-1');
      await testDb.db.update(externalIssueLinks).set({ status: 'done' }).where(eq(externalIssueLinks.id, link.id));
      // PostHog has not taken the release yet, and the report changed since.
      report('rep-1', { updated_at: '2026-11-15T00:00:00.000001Z' });
      const [row] = (await page(wf)).rows;
      expect(row).toMatchObject({ state: 'already_run', selectable: false, runId: null, workbenchId: null });
    });

    it.each<[string, Partial<FakeReport>, string]>([
      ['already addressed', { already_addressed: true }, 'already_addressed'],
      ['repository not connected', { repo_slug: 'acme/other' }, 'repository_not_connected'],
      ['no repository picked', { repo_slug: null }, 'repository_not_connected'],
      ['held back for safety', { status: 'suppressed', suppression_source: 'safety_judge' }, 'held_back'],
      ['held back, even when also addressed', { status: 'suppressed', suppression_source: 'SAFETY_JUDGE', already_addressed: true }, 'held_back'],
    ])('shows %s', async (_name, overrides, state) => {
      const wf = await rule();
      report('rep-1', overrides);
      const res = await page(wf);
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toMatchObject({ state, selectable: false });
    });

    it.each<[string, Partial<FakeReport>]>([
      ['dismissed', { status: 'suppressed', suppression_source: 'dismissed' }],
      ['suppressed with no source', { status: 'suppressed', suppression_source: null }],
    ])('drops a %s report', async (_name, overrides) => {
      const wf = await rule();
      report('rep-1', overrides);
      report('rep-2');
      const res = await page(wf);
      expect(res.rows.map((r) => r.id)).toEqual(['rep-2']);
      expect(res.scanned).toBe(2);
      expect(reads('rep-1')).toBe(0);
    });

    it('shows each state side by side on one page', async () => {
      const wf = await rule();
      report('a-not-run', {}, 0.1);
      report('b-held', { status: 'suppressed', suppression_source: 'safety_judge' }, 0.2);
      report('c-addressed', { already_addressed: true }, 0.3);
      report('d-other-repo', { repo_slug: 'acme/other' }, 0.4);
      report('e-claimed', {}, 0.5);
      posthog.claimByOther('e-claimed');
      report('f-ran', {}, 0.6);
      await insertRun(wf.id, `posthog_inbox:f-ran:${VERSION}`);
      const res = await page(wf);
      expect(res.rows.map((r) => [r.id, r.state, r.selectable])).toEqual([
        ['a-not-run', 'not_run', true],
        ['b-held', 'held_back', false],
        ['c-addressed', 'already_addressed', false],
        ['d-other-repo', 'repository_not_connected', false],
        ['e-claimed', 'claimed_elsewhere', false],
        ['f-ran', 'already_run', false],
      ]);
    });
  });

  describe('reading and matching', () => {
    it('reads a report by id when the list row has no repo_slug key', async () => {
      posthog.listRepoSlug = false;
      const wf = await rule();
      report('rep-1');
      const [row] = (await page(wf)).rows;
      expect(row).toMatchObject({ repository: 'acme/web-app', state: 'not_run' });
      expect(reads('rep-1')).toBe(1);
    });

    it('does not read by id when the list row has repo_slug null', async () => {
      const wf = await rule();
      report('rep-1', { repo_slug: null });
      const [row] = (await page(wf)).rows;
      expect(row).toMatchObject({ repository: null, state: 'repository_not_connected' });
      expect(reads('rep-1')).toBe(0);
    });

    it('leaves out a report it cannot read by id, and keeps the rest', async () => {
      posthog.listRepoSlug = false;
      const wf = await rule();
      report('rep-1', {}, 0.1);
      report('rep-2', {}, 0.2);
      posthog.readFailures.set('rep-1', 500);
      const res = await page(wf);
      expect(res.rows.map((r) => r.id)).toEqual(['rep-2']);
      expect(res.scanned).toBe(2);
    });

    it.each<[string, WorkflowConditions, Partial<FakeReport>]>([
      ['a priority', { priorities: ['P0'] }, { priority: 'P1' }],
      ['a repository', { repositories: ['acme/api'] }, {}],
      ['a title', { titleContains: 'login' }, { title: 'Checkout crashes', summary: 'login fails' }],
      ['a summary', { summaryContains: 'login' }, { title: 'login', summary: 'Checkout crashes' }],
      ['a signal count', { minSignalCount: 10 }, { signal_count: 3 }],
      ['a scout exclude', { scouts: { exclude: ['crash-scout'] } }, { scout_name: 'crash-scout' }],
      ['an actionability', {}, { actionability: 'requires_human_input' }],
      ['a reviewer', { suggestedReviewers: ['ann'] }, {}],
    ])("leaves out a report that fails the rule's %s condition", async (_name, conditions, overrides) => {
      // PostHog applies none of the filters here, so only Talyn's matcher decides.
      posthog.filterList = false;
      const wf = await rule(conditions);
      posthog.reviewers.set('rep-1', ['tom']);
      report('rep-1', overrides);
      const res = await page(wf);
      expect(res.rows).toEqual([]);
      expect(res.scanned).toBe(1);
    });

    it('keeps a report with a matching reviewer, from the artefacts', async () => {
      const wf = await rule({ suggestedReviewers: ['Tom'] });
      posthog.reviewers.set('rep-1', ['tom']);
      report('rep-1');
      expect((await page(wf)).rows.map((r) => r.state)).toEqual(['not_run']);
      expect(posthog.requests).toContain('/api/projects/2/signals/reports/rep-1/artefacts/');
    });

    it("matches the editor's conditions, not the saved rule's", async () => {
      const wf = await rule({ priorities: ['P0'] });
      report('rep-1', { priority: 'P2' });
      expect((await page(wf)).rows).toEqual([]);
      const res = await page(wf, { conditions: { priorities: ['P2'] }, unsavedChanges: true });
      expect(res.rows).toHaveLength(1);
    });
  });

  describe('selection and the daily cap', () => {
    it('lets nothing be selected for an unsaved rule, and has no cap or dedupe state', async () => {
      report('rep-1');
      const res = await page(null);
      expect(res).toMatchObject({
        workflowId: null,
        runnable: false,
        notRunnableReason: 'Save the automation first. Then you can run reports.',
        dailyCap: null,
        runsToday: 0,
      });
      expect(res.rows.map((r) => [r.state, r.selectable])).toEqual([['not_run', false]]);
    });

    it('lets nothing be selected for a disabled rule', async () => {
      const wf = await rule({}, { enabled: false });
      report('rep-1');
      const res = await page(wf);
      expect(res).toMatchObject({ runnable: false, notRunnableReason: 'Turn the automation on first. Then you can run reports.' });
      expect(res.rows[0].selectable).toBe(false);
    });

    it('lets nothing be selected while the editor has unsaved changes', async () => {
      const wf = await rule();
      report('rep-1');
      const res = await page(wf, { unsavedChanges: true });
      expect(res).toMatchObject({ runnable: false, notRunnableReason: 'Save your changes first. Then you can run reports.' });
      expect(res.rows[0].selectable).toBe(false);
    });

    it('a disabled rule says to turn it on, before the unsaved changes', async () => {
      const wf = await rule({}, { enabled: false });
      const res = await page(wf, { unsavedChanges: true });
      expect(res.notRunnableReason).toMatch(/Turn the automation on/);
    });

    it('counts the runs of the last 24 hours, without skipped runs or other rules', async () => {
      const wf = await rule({}, { maxRunsPerDay: 10 });
      const other = await rule({}, { name: 'Other' });
      await insertRun(wf.id, 'd1');
      await insertRun(wf.id, 'd2', { status: 'failed' });
      await insertRun(wf.id, 'd3', { status: 'pending_retry' });
      await insertRun(wf.id, 'd4', { status: 'skipped' });
      await insertRun(wf.id, 'd5', { createdAt: new Date(now.getTime() - DAY - 60_000) });
      await insertRun(other.id, 'd6');
      const res = await page(wf);
      expect(res).toMatchObject({ dailyCap: 10, runsToday: 3 });
      expect(await runsInLastDay(wf.id, now)).toBe(3);
    });

    it('shows no cap for a rule without one', async () => {
      // validateWorkflow always gives a PostHog Inbox rule a cap; an older row may have none.
      const wf = { ...(await rule()), maxRunsPerDay: null };
      await insertRun(wf.id, 'd1');
      expect(await page(wf)).toMatchObject({ dailyCap: null, runsToday: 1 });
    });

    it.each([null, undefined])('defaults a PostHog Inbox rule to a cap of 10 (asked %s)', async (maxRunsPerDay) => {
      const wf = await rule({}, { maxRunsPerDay });
      expect((await page(wf)).dailyCap).toBe(10);
    });
  });

  // ---- Run selected -------------------------------------------------------------

  describe('run selected', () => {
    it('claims each report in PostHog, links it and starts a session, as a manual run', async () => {
      const wf = await rule();
      report('rep-1');
      report('rep-2');
      const res = await run(wf, ['rep-1', 'rep-2']);

      expect(res).toMatchObject({ requested: 2, started: 2, dailyCap: 10, summary: '2 of 2 started.' });
      expect(res.results).toEqual([
        { reportId: 'rep-1', outcome: 'started', message: 'Talyn started a session.', runId: expect.any(String), workbenchId: 'wb-1' },
        { reportId: 'rep-2', outcome: 'started', message: 'Talyn started a session.', runId: expect.any(String), workbenchId: 'wb-2' },
      ]);
      expect(posthog.claimCalls).toEqual([
        { reportId: 'rep-1', body: {} },
        { reportId: 'rep-2', body: {} },
      ]);
      expect(created.map((c) => c.claimCallsBefore)).toEqual([1, 2]);
      expect(created[0].input).toMatchObject({ repositoryId: 'r-web', source: { kind: 'workflow', integration: 'posthog_inbox' } });

      const rows = await runs();
      expect(rows.map((r) => [r.deliveryId, r.status, r.triggerSource, r.triggeredByUserId, r.triggeredByLabel])).toEqual([
        [`posthog_inbox:rep-1:${VERSION}`, 'succeeded', 'manual', 'u1', 'tom'],
        [`posthog_inbox:rep-2:${VERSION}`, 'succeeded', 'manual', 'u1', 'tom'],
      ]);
      expect(rows.map((r) => r.id)).toEqual(res.results.map((r) => r.runId));
      expect((await links()).map((l) => [l.externalId, l.status, l.workbenchId, l.posthogClaimId])).toEqual([
        ['rep-1', 'active', 'wb-1', 'claim-1'],
        ['rep-2', 'active', 'wb-2', 'claim-2'],
      ]);
      const history = await listWorkflowRuns(wf.id, { limit: 10 });
      expect(history.map((h) => [h.trigger, h.triggeredBy])).toEqual([
        ['manual', 'tom'],
        ['manual', 'tom'],
      ]);

      // The backlog now shows both as running.
      expect((await page(wf)).rows.map((r) => r.state)).toEqual(['running', 'running']);
    });

    it('records a manual run without a label', async () => {
      const wf = await rule();
      report('rep-1');
      await runPostHogInboxReports(await connection(), wf, ['rep-1'], { userId: 'u1', label: null });
      const [row] = await runs();
      expect(row).toMatchObject({ triggerSource: 'manual', triggeredByUserId: 'u1', triggeredByLabel: null });
      const [history] = await listWorkflowRuns(wf.id, { limit: 1 });
      expect(history).toMatchObject({ trigger: 'manual', triggeredBy: null });
    });

    it('still records poller and push runs as event runs', async () => {
      const wf = await rule();
      report('rep-1');
      await ingested('rep-1');
      const [row] = await runs();
      expect(row).toMatchObject({ triggerSource: 'event', triggeredByUserId: null, triggeredByLabel: null });
      const [history] = await listWorkflowRuns(wf.id, { limit: 1 });
      expect(history).toMatchObject({ trigger: 'event', triggeredBy: null });
    });

    it.each<[string, () => void]>([
      ['PostHog answers 409', () => { posthog.claimFailures = [409]; }],
      ['somebody claimed it after the read', () => { posthog.exposeClaims = false; posthog.claimByOther('rep-1'); }],
    ])('reports a lost claim (%s) as claimed elsewhere, starts no session and runs the rest', async (_name, stage) => {
      const wf = await rule();
      report('rep-1');
      report('rep-2');
      stage();
      const res = await run(wf, ['rep-1', 'rep-2']);
      expect(res.results.map((r) => r.outcome)).toEqual(['claimed_elsewhere', 'started']);
      expect(res.results[0]).toMatchObject({
        message: 'Another person or agent claimed this report in PostHog first.',
        runId: expect.any(String),
        workbenchId: null,
      });
      expect(res.summary).toBe('1 of 2 started.');
      expect(created).toHaveLength(1);
      expect(created[0].input.source).toMatchObject({ kind: 'workflow' });
      expect((await runs()).map((r) => r.status)).toEqual(['skipped', 'succeeded']);
    });

    it('does not run a version again: already run, and no second run row', async () => {
      const wf = await rule();
      report('rep-1');
      const link = await ingested('rep-1');
      await testDb.db.update(externalIssueLinks).set({ status: 'done' }).where(eq(externalIssueLinks.id, link.id));
      posthog.claims.get('rep-1')!.released = true;
      const claimsBefore = posthog.claimCalls.length;

      const res = await run(wf, ['rep-1']);
      expect(res.results).toEqual([
        {
          reportId: 'rep-1',
          outcome: 'already_run',
          message: 'This automation already ran on this version of the report.',
          runId: link.runId,
          workbenchId: 'wb-1',
        },
      ]);
      expect(await runs()).toHaveLength(1);
      expect(created).toHaveLength(1);
      expect(posthog.claimCalls).toHaveLength(claimsBefore);
    });

    it('answers already run for a report Talyn works on now', async () => {
      const wf = await rule();
      report('rep-1');
      await ingested('rep-1');
      const res = await run(wf, ['rep-1']);
      expect(res.results[0]).toMatchObject({ outcome: 'already_run', message: 'Talyn already works on this report.', workbenchId: 'wb-1' });
      expect(await runs()).toHaveLength(1);
    });

    it('answers already run when the engine finds the run first (a race with the poller)', async () => {
      const wf = await rule({ suggestedReviewers: ['tom'] });
      posthog.reviewers.set('rep-1', ['tom']);
      report('rep-1');
      // The second artefacts read is the engine's: the poller's run lands just before it.
      let artefactReads = 0;
      beforeAnswer = async (url) => {
        if (!url.pathname.endsWith('/rep-1/artefacts/')) return;
        artefactReads += 1;
        if (artefactReads === 2) await insertRun(wf.id, `posthog_inbox:rep-1:${VERSION}`);
      };
      const res = await run(wf, ['rep-1']);
      expect(artefactReads).toBe(2);
      expect(res.results[0]).toMatchObject({ outcome: 'already_run', runId: null, workbenchId: null });
      expect(await runs()).toHaveLength(1);
      expect(created).toHaveLength(0);
      expect(posthog.claimCalls).toHaveLength(0);
    });

    it('splits at the daily cap: 3 of 5 start, the rest are refused without a read and without a run row', async () => {
      const wf = await rule({}, { maxRunsPerDay: 10 });
      for (let i = 0; i < 7; i++) await insertRun(wf.id, `old-${i}`, { createdAt: new Date(now.getTime() - 60 * 60_000) });
      const ids = ['rep-1', 'rep-2', 'rep-3', 'rep-4', 'rep-5'];
      for (const id of ids) report(id);

      const res = await run(wf, ids);
      expect(res.results.map((r) => r.outcome)).toEqual(['started', 'started', 'started', 'daily_cap', 'daily_cap']);
      expect(res.results[3]).toMatchObject({ message: 'The daily cap of 10 is reached.', runId: null, workbenchId: null });
      expect(res).toMatchObject({ requested: 5, started: 3, dailyCap: 10, summary: '3 of 5 started; the daily cap of 10 is reached.' });
      expect(reads('rep-4')).toBe(0);
      expect(reads('rep-5')).toBe(0);

      const rows = await runs();
      expect(rows).toHaveLength(10);
      expect(rows.filter((r) => r.status === 'skipped')).toHaveLength(0);
      expect(rows.filter((r) => r.deliveryId.includes('rep-4') || r.deliveryId.includes('rep-5'))).toEqual([]);
    });

    it('refuses everything at once when the cap is already spent', async () => {
      const wf = await rule({}, { maxRunsPerDay: 2 });
      await insertRun(wf.id, 'old-1');
      await insertRun(wf.id, 'old-2');
      report('rep-1');
      report('rep-2');
      const res = await run(wf, ['rep-1', 'rep-2']);
      expect(res.results.map((r) => r.outcome)).toEqual(['daily_cap', 'daily_cap']);
      expect(res.summary).toBe('0 of 2 started; the daily cap of 2 is reached.');
      expect(res.results[0]).toEqual({ reportId: 'rep-1', outcome: 'daily_cap', message: 'The daily cap of 2 is reached.', runId: null, workbenchId: null });
      // The cap comes before the read: nothing is read from PostHog.
      expect(reads('rep-1')).toBe(0);
      expect(reads('rep-2')).toBe(0);
      expect(await runs()).toHaveLength(2);
    });

    it('stops at the cap the engine finds, and refuses the rest without a read', async () => {
      const wf = await rule({ suggestedReviewers: ['tom'] }, { maxRunsPerDay: 2 });
      await insertRun(wf.id, 'old-1');
      for (const id of ['rep-1', 'rep-2', 'rep-3']) {
        report(id);
        posthog.reviewers.set(id, ['tom']);
      }
      let artefactReads = 0;
      beforeAnswer = async (url) => {
        if (!url.pathname.endsWith('/rep-1/artefacts/')) return;
        artefactReads += 1;
        // Another run spends the last slot between the cap check and the engine.
        if (artefactReads === 2) await insertRun(wf.id, 'old-2');
      };
      const res = await run(wf, ['rep-1', 'rep-2', 'rep-3']);
      expect(res.results.map((r) => r.outcome)).toEqual(['daily_cap', 'daily_cap', 'daily_cap']);
      expect(reads('rep-2')).toBe(0);
      expect(reads('rep-3')).toBe(0);
      expect((await runs()).filter((r) => r.status === 'skipped')).toEqual([]);
    });

    it('runs without a cap when the rule has none', async () => {
      const wf = { ...(await rule()), maxRunsPerDay: null };
      for (let i = 0; i < 12; i++) await insertRun(wf.id, `old-${i}`);
      report('rep-1');
      const res = await run(wf, ['rep-1']);
      expect(res).toMatchObject({ started: 1, dailyCap: null, summary: '1 of 1 started.' });
    });

    it.each<[string, Partial<FakeReport>, WorkflowConditions, string, RegExp]>([
      ['no longer matches', { priority: 'P3' }, { priorities: ['P0', 'P1'] }, 'not_eligible', /^The report no longer matches: Priority does not match\.$/],
      ['is no longer ready', { status: 'in_progress' }, {}, 'not_eligible', /^The report no longer matches: It is in_progress, not ready\.$/],
      ['is now addressed', { already_addressed: true }, {}, 'not_eligible', /already handles this report/],
      ['is now held back', { status: 'suppressed', suppression_source: 'safety_judge' }, {}, 'not_eligible', /safety judge held this report back/],
      ['moved to a repository not connected', { repo_slug: 'acme/other' }, {}, 'not_eligible', /repository is not connected/],
      ['has no repository', { repo_slug: null }, {}, 'not_eligible', /repository is not connected/],
      ['now has an open PR of somebody else', { implementation_pr_url: PR_URL, implementation_pr_state: 'open' }, {}, 'claimed_elsewhere', /holds this report in PostHog/],
    ])('re-reads a report that %s since the list', async (_name, overrides, conditions, outcome, message) => {
      const wf = await rule(conditions);
      report('rep-1', overrides);
      const res = await run(wf, ['rep-1']);
      expect(res.results[0]).toMatchObject({ reportId: 'rep-1', outcome, message: expect.stringMatching(message) });
      expect(reads('rep-1')).toBe(1);
      expect(posthog.claimCalls).toEqual([]);
      expect(created).toEqual([]);
      expect(await runs()).toEqual([]);
    });

    it('re-reads a report somebody claimed since the list', async () => {
      const wf = await rule();
      report('rep-1');
      posthog.claimByOther('rep-1', 'person:alice');
      const res = await run(wf, ['rep-1']);
      expect(res.results[0]).toMatchObject({ outcome: 'claimed_elsewhere', message: 'Another person or agent holds this report in PostHog.' });
      expect(posthog.claimCalls).toEqual([]);
      expect(await runs()).toEqual([]);
    });

    it.each<[string, number | null, string, RegExp]>([
      ['a missing report', null, 'not_found', /^PostHog does not have this report\.$/],
      ['a 404', 404, 'not_found', /^PostHog does not have this report\.$/],
      ['a 400', 400, 'not_found', /^PostHog does not have this report\.$/],
      ['a 500', 500, 'unreadable', /^Talyn could not read the report from PostHog \(500\)\.$/],
      ['a 503', 503, 'unreadable', /\(503\)/],
      ['a 403', 403, 'unreadable', /\(403\)/],
    ])('answers %s, and runs the next report', async (_name, status, outcome, message) => {
      const wf = await rule();
      report('rep-2');
      if (status !== null) {
        report('rep-1');
        posthog.readFailures.set('rep-1', status);
      }
      const res = await run(wf, ['rep-1', 'rep-2']);
      expect(res.results[0]).toMatchObject({ reportId: 'rep-1', outcome, message: expect.stringMatching(message), runId: null, workbenchId: null });
      expect(res.results[1].outcome).toBe('started');
    });

    it('answers unreadable when PostHog sends a report with no updated_at', async () => {
      const wf = await rule();
      report('rep-1', { updated_at: '' });
      const res = await run(wf, ['rep-1']);
      expect(res.results[0]).toMatchObject({ outcome: 'unreadable', message: 'PostHog answered without a report.' });
    });

    it('runs at most 20 reports', async () => {
      const wf = await rule({}, { maxRunsPerDay: 50 });
      const ids = Array.from({ length: 22 }, (_, i) => `rep-${i}`);
      const res = await run(wf, ids);
      expect(res.requested).toBe(20);
      expect(res.results).toHaveLength(20);
      expect(res.results.map((r) => r.reportId)).toEqual(ids.slice(0, 20));
      expect(reads('rep-20')).toBe(0);
    });
  });

  // ---- The engine's manual run --------------------------------------------------

  describe('runWorkflowManually', () => {
    async function input(reportId = 'rep-1') {
      const c = await connection();
      const facts = reportToFacts(await c.client.getReport(reportId), c);
      if (!facts) throw new Error('no facts');
      return { connection: c, facts };
    }

    it('acts once, then answers duplicate for the same version', async () => {
      const wf = await rule();
      report('rep-1');
      const first = await runWorkflowManually(posthogInboxWorkflowSource, await input(), wf, MANUAL);
      expect(first).toMatchObject({ kind: 'acted', status: 'succeeded', workbenchId: 'wb-1' });
      expect(first.kind === 'acted' && first.run?.id).toBeTruthy();
      const second = await runWorkflowManually(posthogInboxWorkflowSource, await input(), wf, MANUAL);
      expect(second).toEqual({ kind: 'duplicate' });
      expect(await runs()).toHaveLength(1);
    });

    it('refuses at the daily cap with no skipped row, so the poller can still run that version later', async () => {
      const wf = await rule({}, { maxRunsPerDay: 1 });
      const blocker = await insertRun(wf.id, 'old-1');
      report('rep-1');
      expect(await runWorkflowManually(posthogInboxWorkflowSource, await input(), wf, MANUAL)).toEqual({ kind: 'daily_capped' });
      expect((await runs()).map((r) => r.id)).toEqual([blocker]);

      // The cap frees up: the event path runs the same version.
      await testDb.db.delete(workflowRuns).where(eq(workflowRuns.id, blocker));
      await ingestPostHogReport(await connection(), 'rep-1');
      const rows = await runs();
      expect(rows.map((r) => [r.deliveryId, r.status, r.triggerSource])).toEqual([
        [posthogInboxDeliveryId({ reportId: 'rep-1', updatedAt: VERSION }), 'succeeded', 'event'],
      ]);
    });

    it('the event path still records a skipped row at the cap', async () => {
      const wf = await rule({}, { maxRunsPerDay: 1 });
      await insertRun(wf.id, 'old-1');
      report('rep-1');
      await ingestPostHogReport(await connection(), 'rep-1');
      expect((await runs()).map((r) => r.status)).toEqual(['succeeded', 'skipped']);
    });

    it('refuses at the hourly cap of one report with no skipped row', async () => {
      const wf = await rule({}, { maxRunsPerPrPerHour: 1 });
      report('rep-1');
      await testDb.db.insert(workflowRuns).values({
        id: randomUUID(),
        workflowId: wf.id,
        workspaceId: 'ws1',
        integration: 'posthog_inbox',
        event: 'report_ready',
        deliveryId: 'posthog_inbox:rep-1:older',
        subjectKey: 'posthog_inbox:rep-1',
        status: 'succeeded',
      });
      expect(await runWorkflowManually(posthogInboxWorkflowSource, await input(), wf, MANUAL)).toEqual({ kind: 'rate_capped' });
      expect(await runs()).toHaveLength(1);
    });

    it.each<[string, Partial<FakeReport>, WorkflowConditions]>([
      ['a report that is not ready', { status: 'in_progress' }, {}],
      ['a report held back', { status: 'suppressed', suppression_source: 'safety_judge' }, {}],
      ['a report that fails a condition', { priority: 'P3' }, { priorities: ['P0'] }],
    ])('answers not matching for %s', async (_name, overrides, conditions) => {
      const wf = await rule(conditions);
      report('rep-1', overrides);
      expect(await runWorkflowManually(posthogInboxWorkflowSource, await input(), wf, MANUAL)).toEqual({ kind: 'not_matching' });
      expect(await runs()).toEqual([]);
    });

    it('answers unavailable for a disabled rule', async () => {
      const wf = await rule({}, { enabled: false });
      report('rep-1');
      expect(await runWorkflowManually(posthogInboxWorkflowSource, await input(), wf, MANUAL)).toEqual({ kind: 'unavailable' });
    });

    it('answers unavailable for a rule of another integration', async () => {
      const wf = await rule();
      report('rep-1');
      const github = { ...wf, integration: 'github' } as WorkflowDefinition;
      expect(await runWorkflowManually(posthogInboxWorkflowSource, await input(), github, MANUAL)).toEqual({ kind: 'unavailable' });
    });

    it('answers unavailable when the PostHog Inbox flag is off', async () => {
      const wf = await rule();
      report('rep-1');
      const i = await input();
      vi.stubEnv('POSTHOG_INBOX_RULES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      expect(await runWorkflowManually(posthogInboxWorkflowSource, i, wf, MANUAL)).toEqual({ kind: 'unavailable' });
    });

    it("answers no target for a rule of another workspace", async () => {
      const wf = await rule();
      report('rep-1');
      const elsewhere = { ...wf, workspaceId: 'ws-other' } as WorkflowDefinition;
      expect(await runWorkflowManually(posthogInboxWorkflowSource, await input(), elsewhere, MANUAL)).toEqual({ kind: 'no_target' });
    });
  });
});
