import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Workbench, WorkflowAction, WorkflowConditions } from '@talyn/shared';
import { TALYN_REPORT_NOT_FIXED_SENTINEL, validateWorkflow } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { FakePostHog } from './helpers/fakePostHogInbox.js';
import {
  externalIssueLinks,
  integrations,
  posthogInboxPollers,
  pullRequests,
  repositories,
  workbenchChats,
  workbenchEvents,
  workbenches,
  workflowRuns,
  workspaces,
} from '../db/schema.js';
import type { CreateWorkbenchServiceInput } from '../services/workbenches/create.js';

/**
 * Step 2 of PostHog Inbox rules against a database and a fake PostHog: the
 * claim before the session, the lost race, the claim refusals and their
 * backoff, the claim id on the link, the pull request attach (idempotent and
 * retried), the release (no pull request, the agent's stop, a failed session,
 * a pull request closed without a merge), the missing scopes and the claim in
 * the run history. The session create is stubbed.
 */

vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: () => undefined,
  broadcastToUser: () => undefined,
}));

const created: Array<{ input: CreateWorkbenchServiceInput; claimCallsBefore: number }> = [];
let failCreate: Error | null = null;
let posthog: FakePostHog;

vi.mock('../services/workbenches/create.js', () => ({
  createWorkbench: async (input: CreateWorkbenchServiceInput) => {
    if (failCreate) throw failCreate;
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
const { posthogInboxPoller } = await import('../services/posthogInbox/poller.js');
const { posthogInboxStatus } = await import('../services/posthogInbox/preview.js');
const {
  _resetClaimGatesForTests,
  claimGate,
  claimReportForStart,
  MAX_SYNC_ATTEMPTS,
  posthogClaimSweep,
  SESSION_ERROR_GRACE_MS,
  syncPostHogClaim,
  syncPostHogClaimsForPullRequest,
  WATCH_INTERVAL_MS,
  dueClaimsQuery,
} = await import('../services/posthogInbox/claims.js');
const { handlePullRequestSettled } = await import('../services/inbound/onMerge.js');
const { workflowRetrySweep } = await import('../services/workflows/retrySweep.js');
const { posthogClaimsForRunsQuery, UNATTACHED_CLAIM_GRACE_MS } = await import('../services/inbound/issueLinks.js');

const MODEL = 'claude-sonnet-4-5';
const HOST = 'https://us.posthog.com';
const PR_URL = 'https://github.com/acme/web-app/pull/31';
const realFetch = globalThis.fetch;
const MIN = 60_000;

describe('PostHog Inbox claims', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('POSTHOG_INBOX_RULES_ENABLED', 'true');
    vi.stubEnv('WEB_APP_URL', 'https://app.talyn.test');
    resetFeatureFlagsForTests();
    resetWebAppUrlCacheForTests();
    _resetWorkflowStore();
    _resetClaimGatesForTests();
    created.length = 0;
    failCreate = null;

    posthog = new FakePostHog();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.origin === HOST) return posthog.handle(url, init);
      return realFetch(input, init);
    });

    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'u1', email: 'owner@example.test' });
    await testDb.db.insert(workspaces).values({ id: 'ws1', ownerId: 'u1', name: 'One' });
    await testDb.db
      .insert(repositories)
      .values({ id: 'r-web', workspaceId: 'ws1', name: 'acme/web-app', url: 'https://github.com/acme/web-app' });
    await connectWithApiKey();
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

  async function connectWithApiKey(): Promise<void> {
    await testDb.db.delete(integrations).where(eq(integrations.workspaceId, 'ws1'));
    await testDb.db.insert(integrations).values({
      id: 'int-1',
      workspaceId: 'ws1',
      type: 'posthog',
      enabled: true,
      config: { apiKeyEnc: encryptString('phx_test'), projectId: '2', host: HOST, authMethod: 'personal_api_key' },
    });
  }

  async function connectWithOAuth(scope: string): Promise<void> {
    await testDb.db.delete(integrations).where(eq(integrations.workspaceId, 'ws1'));
    await testDb.db.insert(integrations).values({
      id: 'int-1',
      workspaceId: 'ws1',
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

  const runs = () => testDb.db.select().from(workflowRuns).orderBy(workflowRuns.createdAt);
  const links = () => testDb.db.select().from(externalIssueLinks).orderBy(externalIssueLinks.createdAt);
  async function onlyLink() {
    const all = await links();
    expect(all).toHaveLength(1);
    return all[0];
  }

  /** Ingest one report with a rule, so a session and a claim exist. */
  async function started(reportId = 'rep-1') {
    if ((await testDb.db.select().from(workflowRuns)).length === 0) await rule();
    posthog.put(reportId);
    await ingestPostHogReport(await connection(), reportId);
    const link = (await links()).find((l) => l.externalId === reportId);
    if (!link?.posthogClaimId) throw new Error('no claim');
    return link;
  }

  async function openPr(state: 'open' | 'closed' | 'merged' = 'open', workbenchId = 'wb-1') {
    await testDb.db
      .insert(pullRequests)
      .values({ id: 'pr-1', workspaceId: 'ws1', repositoryId: 'r-web', owner: 'acme', repo: 'web-app', number: 31, state })
      .onConflictDoUpdate({ target: pullRequests.id, set: { state } });
    await testDb.db.update(workbenches).set({ pullRequestId: 'pr-1' }).where(eq(workbenches.id, workbenchId));
  }

  async function sessionSaid(text: string, opts: { busy?: boolean; workbenchId?: string } = {}) {
    const workbenchId = opts.workbenchId ?? 'wb-1';
    await testDb.db.update(workbenches).set({ status: 'ready' }).where(eq(workbenches.id, workbenchId));
    await testDb.db.insert(workbenchChats).values({
      id: `chat-${workbenchId}`,
      workbenchId,
      workspaceId: 'ws1',
      title: 'Chat',
      agent: 'claude',
      status: opts.busy ? 'running' : 'idle',
    });
    await testDb.db.insert(workbenchEvents).values({
      chatId: `chat-${workbenchId}`,
      seq: 1,
      turn: 1,
      event: { type: 'result', result: text },
      createdAt: new Date(Date.now() + 1_000),
    });
  }

  const claimBodies = () => posthog.claimCalls.map((c) => c.body);

  // ---- 1. The claim before the session ---------------------------------------

  describe('the claim before a session', () => {
    it('claims the report in PostHog, then starts the session, and stores the claim id', async () => {
      await rule();
      posthog.put('rep-1');
      expect(await ingestPostHogReport(await connection(), 'rep-1')).toMatchObject({ ran: 1 });

      expect(posthog.claimCalls).toEqual([{ reportId: 'rep-1', body: {} }]);
      expect(created).toHaveLength(1);
      // The claim came first.
      expect(created[0].claimCallsBefore).toBe(1);
      expect(posthog.activeClaim('rep-1')).toMatchObject({ claimId: 'claim-1', holder: 'talyn' });

      const link = await onlyLink();
      expect(link).toMatchObject({
        status: 'active',
        workbenchId: 'wb-1',
        posthogClaimId: 'claim-1',
        posthogClaimState: 'claimed',
        posthogClaimAttempts: 0,
        posthogClaimError: null,
      });
      expect(link.posthogClaimNextCheckAt).not.toBeNull();

      const [run] = await runs();
      expect(run.status).toBe('succeeded');
      const [history] = await listWorkflowRuns(run.workflowId, { limit: 10 });
      expect(history.posthogClaim).toMatchObject({ state: 'claimed', prUrl: null, pending: false });
    });

    it.each([
      ['another agent', 'some-agent'],
      ['a person', 'person:alice'],
    ])('starts no session when %s claimed the report first, and records the run as skipped', async (_who, holder) => {
      await rule();
      posthog.put('rep-1');
      posthog.claimByOther('rep-1', holder);
      await ingestPostHogReport(await connection(), 'rep-1');

      expect(created).toHaveLength(0);
      const [run] = await runs();
      expect(run.status).toBe('skipped');
      expect(run.actions).toEqual([
        expect.objectContaining({ ok: false, code: 'report_claimed_elsewhere', error: expect.stringMatching(/claimed this report in PostHog first/) }),
      ]);
      const link = await onlyLink();
      expect(link.status).toBe('failed');
      expect(link.posthogClaimId).toBeNull();
      // Never takes the claim over.
      expect(claimBodies()).toEqual([{}]);
      expect(posthog.activeClaim('rep-1')?.holder).toBe(holder);
    });

    it('does not count a lost race toward the daily cap', async () => {
      await rule({}, { maxRunsPerDay: 1 });
      posthog.put('rep-1');
      posthog.put('rep-2');
      posthog.claimByOther('rep-1');
      const c = await connection();
      await ingestPostHogReport(c, 'rep-1');
      await ingestPostHogReport(c, 'rep-2');
      expect(created).toHaveLength(1);
      expect((await runs()).map((r) => r.status)).toEqual(['skipped', 'succeeded']);
    });

    it.each([
      [401, null, 'posthog_unauthorized', 30 * MIN],
      [403, null, 'posthog_unauthorized', 30 * MIN],
      [429, 600, 'rate_gated', 10 * MIN],
      [429, null, 'rate_gated', 3 * MIN],
      [429, 30, 'rate_gated', 3 * MIN],
      [500, null, 'posthog_unavailable', 10 * MIN],
      [502, null, 'posthog_unavailable', 10 * MIN],
      [503, null, 'posthog_unavailable', 10 * MIN],
    ])('parks the run and starts nothing when PostHog answers the claim %i (Retry-After %s)', async (status, retryAfter, code, backoff) => {
      await rule();
      posthog.put('rep-1');
      // A 401 is refreshed and tried once more by the client, as PostHog Code's is.
      posthog.claimFailures = status === 401 ? [status, status] : [status];
      posthog.claimRetryAfter = retryAfter;
      const before = Date.now();
      await ingestPostHogReport(await connection(), 'rep-1');

      expect(created).toHaveLength(0);
      const [run] = await runs();
      expect(run.status).toBe('pending_retry');
      expect(run.actions).toEqual([expect.objectContaining({ ok: false, code })]);
      const wait = run.retryAfter!.getTime() - before;
      expect(wait).toBeGreaterThanOrEqual(backoff);
      expect(wait).toBeLessThan(backoff + 30_000);
      // Talyn's own link is kept for the retry; PostHog holds nothing.
      const link = await onlyLink();
      expect(link).toMatchObject({ status: 'active', posthogClaimId: null });
      expect(posthog.activeClaim('rep-1')).toBeNull();
      expect(claimGate('int-1')?.failure.status).toBe(status);
    });

    it('does not ask PostHog again while the connection is gated, and parks the next report too', async () => {
      await rule();
      posthog.put('rep-1');
      posthog.put('rep-2');
      posthog.claimFailures = [503];
      const c = await connection();
      await ingestPostHogReport(c, 'rep-1');
      await ingestPostHogReport(c, 'rep-2');
      expect(posthog.claimCalls).toHaveLength(1);
      expect((await runs()).map((r) => r.status)).toEqual(['pending_retry', 'pending_retry']);
      expect(created).toHaveLength(0);
    });

    it('claims and starts on the retry once PostHog answers again', async () => {
      await rule();
      posthog.put('rep-1');
      posthog.claimFailures = [503];
      await ingestPostHogReport(await connection(), 'rep-1');
      _resetClaimGatesForTests();
      await testDb.db.update(workflowRuns).set({ retryAfter: new Date(Date.now() - 1_000) });

      expect(await workflowRetrySweep.tick()).toBe(1);
      const [run] = await runs();
      expect(run.status).toBe('succeeded');
      expect(run.attempts).toBe(2);
      expect(created).toHaveLength(1);
      expect(await onlyLink()).toMatchObject({ status: 'active', posthogClaimId: 'claim-1', workbenchId: 'wb-1' });
    });

    it('keeps the run parked while the connection is still gated', async () => {
      await rule();
      posthog.put('rep-1');
      posthog.claimFailures = [403];
      await ingestPostHogReport(await connection(), 'rep-1');
      await testDb.db.update(workflowRuns).set({ retryAfter: new Date(Date.now() - 1_000) });
      await workflowRetrySweep.tick();
      const [run] = await runs();
      expect(run.status).toBe('pending_retry');
      expect(run.attempts).toBe(1);
      expect(posthog.claimCalls).toHaveLength(1);
    });

    it.each([
      ['a 400', () => { posthog.claimFailures = [400]; }, /PostHog refused the claim/],
      ['a 404', () => { posthog.claimFailures = [404]; }, /PostHog refused the claim/],
      ['no claim id', () => { posthog.omitClaimId = true; }, /sent no claim id/],
    ])('fails without a session or a retry on %s', async (_name, arrange, message) => {
      await rule();
      posthog.put('rep-1');
      arrange();
      await ingestPostHogReport(await connection(), 'rep-1');
      expect(created).toHaveLength(0);
      const [run] = await runs();
      expect(run.status).toBe('failed');
      expect(run.retryAfter).toBeNull();
      expect(run.actions).toEqual([expect.objectContaining({ code: 'error', error: expect.stringMatching(message) })]);
      expect((await onlyLink()).status).toBe('failed');
      expect(claimGate('int-1')).toBeNull();
    });

    it('resumes its own claim with claim_id on a retried start', async () => {
      posthog.put('rep-1');
      const c = await connection();
      const first = await claimReportForStart(c, { id: 'nope', posthogClaimId: null }, 'rep-1');
      expect(first).toEqual({ ok: true, claimId: 'claim-1' });
      const again = await claimReportForStart(c, { id: 'nope', posthogClaimId: 'claim-1' }, 'rep-1');
      expect(again).toEqual({ ok: true, claimId: 'claim-1' });
      expect(claimBodies()).toEqual([{}, { claim_id: 'claim-1' }]);
    });

    it('treats a stale claim id as a lost claim', async () => {
      posthog.put('rep-1');
      posthog.claimByOther('rep-1');
      const result = await claimReportForStart(await connection(), { id: 'nope', posthogClaimId: 'claim-9' }, 'rep-1');
      expect(result).toMatchObject({ ok: false, failure: { kind: 'conflict', status: 409 } });
    });

    it('releases the claim at once when the session cannot start', async () => {
      await rule();
      posthog.put('rep-1');
      failCreate = new Error('the agent is not connected');
      await ingestPostHogReport(await connection(), 'rep-1');
      expect(created).toHaveLength(0);
      expect((await runs())[0].status).toBe('failed');
      expect(claimBodies()).toEqual([{}, { claim_id: 'claim-1', release: true }]);
      const link = await onlyLink();
      expect(link).toMatchObject({ status: 'failed', posthogClaimState: 'released', posthogClaimNextCheckAt: null });
      expect(posthog.activeClaim('rep-1')).toBeNull();
    });
  });

  // ---- The poller and the scopes ---------------------------------------------

  describe('the poller', () => {
    async function poller() {
      const [row] = await testDb.db.select().from(posthogInboxPollers);
      return row;
    }

    it.each([
      [503, 10 * MIN, 'unknown'],
      [403, 30 * MIN, 'reconnect'],
      [401, 30 * MIN, 'reconnect'],
    ])('stops after a claim refused with %i and backs off', async (status, backoff, access) => {
      await rule();
      await posthogInboxPoller.tick(new Date('2026-11-14T00:00:00Z'));
      posthog.put('rep-1', { updated_at: '2026-11-14T00:01:00.000000Z' });
      posthog.put('rep-2', { updated_at: '2026-11-14T00:02:00.000000Z' });
      posthog.claimFailures = status === 401 ? [status, status] : [status];
      await testDb.db.update(posthogInboxPollers).set({ nextPollAt: new Date(0) });
      const now = new Date('2026-11-14T00:03:00Z');
      await posthogInboxPoller.tick(now);

      const row = await poller();
      expect(row.lastErrorStatus).toBe(status);
      expect(row.nextPollAt.getTime()).toBe(now.getTime() + backoff);
      // The refused report's run is parked, so the cursor moves past it, and no further.
      expect(row.cursorUpdatedAt).toBe('2026-11-14T00:01:00.000000Z');
      expect(posthog.requests.filter((r) => r.includes('rep-2'))).toEqual([]);
      expect((await posthogInboxStatus('ws1')).access).toBe(access);
      expect(created).toHaveLength(0);
    });

    it('lists only unclaimed reports, so a claimed report is not picked again', async () => {
      await rule();
      await posthogInboxPoller.tick(new Date('2026-11-14T00:00:00Z'));
      posthog.put('rep-1', { updated_at: '2026-11-14T00:01:00.000000Z' });
      posthog.claimByOther('rep-1');
      await testDb.db.update(posthogInboxPollers).set({ nextPollAt: new Date(0) });
      await posthogInboxPoller.tick(new Date('2026-11-14T00:03:00Z'));
      expect(posthog.claimCalls).toHaveLength(0);
      expect(await runs()).toHaveLength(0);
    });
  });

  describe('a connection without the claim permissions', () => {
    it.each([
      ['no task:write', 'openid task:read inbox:read inbox:write'],
      ['no inbox:write', 'openid task:read task:write inbox:read'],
      ['neither', 'openid task:read inbox:read'],
    ])('claims nothing and starts nothing (%s), and asks the user to reconnect', async (_name, scope) => {
      await connectWithOAuth(scope);
      await rule();
      posthog.put('rep-1', { updated_at: '2026-11-14T00:01:00.000000Z' });

      // The poller does not read or start anything without a claim-capable grant.
      await posthogInboxPoller.tick(new Date('2026-11-14T00:00:00Z'));
      await testDb.db.update(posthogInboxPollers).set({ nextPollAt: new Date(0) });
      await posthogInboxPoller.tick(new Date('2026-11-14T00:03:00Z'));
      expect(posthog.requests).toEqual([]);

      const status = await posthogInboxStatus('ws1');
      expect(status.access).toBe('reconnect');
      expect(status.reason).toMatch(/inbox:write and task:write/);
      expect(await getPostHogInboxConnection('ws1')).toBeNull();

      // The preview still reads: the grant has inbox:read.
      const reader = await getPostHogInboxConnection('ws1', 'read');
      expect(reader).not.toBeNull();

      // Even an ingest with a reading connection (a later webhook) starts nothing.
      await ingestPostHogReport(reader!, 'rep-1');
      expect(posthog.claimCalls).toHaveLength(0);
      expect(created).toHaveLength(0);
      const [run] = await runs();
      expect(run.actions).toEqual([expect.objectContaining({ code: 'posthog_claim_unavailable' })]);
      expect(run.retryAfter).toBeNull();
      expect(await links()).toHaveLength(0);
    });

    it('claims with a grant that has every Inbox permission', async () => {
      await connectWithOAuth('openid task:read task:write inbox:read inbox:write');
      await started();
      expect(created).toHaveLength(1);
    });
  });

  // ---- 2. Attach the pull request ---------------------------------------------

  describe('the pull request attach', () => {
    it('attaches the session pull request to the claim, once', async () => {
      const link = await started();
      await openPr('open');
      expect(await syncPostHogClaim(link.id)).toBe('attached');
      expect(claimBodies()).toEqual([{}, { claim_id: 'claim-1', pull_requests: [PR_URL] }]);
      expect(posthog.activeClaim('rep-1')?.pullRequests).toEqual([PR_URL]);
      expect(await onlyLink()).toMatchObject({ posthogClaimState: 'pr_attached', posthogClaimPrUrl: PR_URL, status: 'active' });

      // Idempotent: nothing more to send.
      expect(await syncPostHogClaim(link.id)).toBe('watching');
      expect(await syncPostHogClaim(link.id)).toBe('watching');
      expect(posthog.claimCalls).toHaveLength(2);

      const [history] = await listWorkflowRuns((await runs())[0].workflowId, { limit: 10 });
      expect(history.posthogClaim).toMatchObject({ state: 'pr_attached', prUrl: PR_URL, pending: false });
    });

    it('attaches from the pr:session fast path', async () => {
      await started();
      await openPr('open');
      expect(await syncPostHogClaimsForPullRequest('ws1', 'pr-1')).toBe(1);
      expect(posthog.activeClaim('rep-1')?.pullRequests).toEqual([PR_URL]);
    });

    it('attaches from the sweep, and only touches links that are due', async () => {
      const link = await started();
      await openPr('open');
      // Not due yet: the sweep leaves it.
      expect(await posthogClaimSweep.tick(new Date())).toBe(0);
      expect(posthog.claimCalls).toHaveLength(1);
      // Due.
      const later = new Date(Date.now() + WATCH_INTERVAL_MS + 1_000);
      expect(await posthogClaimSweep.tick(later)).toBe(1);
      expect(posthog.activeClaim('rep-1')?.pullRequests).toEqual([PR_URL]);
      const row = await onlyLink();
      expect(row.id).toBe(link.id);
      expect(row.posthogClaimNextCheckAt!.getTime()).toBe(later.getTime() + WATCH_INTERVAL_MS);
    });

    it.each([
      [500, 10 * MIN],
      [503, 10 * MIN],
      [429, 3 * MIN],
      [403, 30 * MIN],
    ])('retries an attach PostHog refused with %i, with the backoff', async (status, backoff) => {
      const link = await started();
      await openPr('open');
      posthog.claimFailures = [status];
      const now = new Date();
      expect(await syncPostHogClaim(link.id, now)).toBe('failed');
      let row = await onlyLink();
      expect(row).toMatchObject({ posthogClaimState: 'claimed', posthogClaimAttempts: 1, posthogClaimPrUrl: null });
      expect(row.posthogClaimError).toContain(String(status));
      expect(row.posthogClaimNextCheckAt!.getTime()).toBe(now.getTime() + backoff);
      const [history] = await listWorkflowRuns((await runs())[0].workflowId, { limit: 10 });
      expect(history.posthogClaim).toMatchObject({ state: 'claimed', pending: true });

      // While the gate holds, the sweep defers without a call.
      expect(await syncPostHogClaim(link.id)).toBe('deferred');
      expect(posthog.claimCalls).toHaveLength(2);

      _resetClaimGatesForTests();
      expect(await syncPostHogClaim(link.id)).toBe('attached');
      row = await onlyLink();
      expect(row).toMatchObject({ posthogClaimState: 'pr_attached', posthogClaimAttempts: 0, posthogClaimError: null });
    });

    it(`gives up after ${MAX_SYNC_ATTEMPTS} failed attaches`, async () => {
      const link = await started();
      await openPr('open');
      await testDb.db.update(externalIssueLinks).set({ posthogClaimAttempts: MAX_SYNC_ATTEMPTS - 1 });
      posthog.claimFailures = [500];
      expect(await syncPostHogClaim(link.id)).toBe('gave_up');
      expect((await onlyLink()).posthogClaimNextCheckAt).toBeNull();
      expect(await dueClaimsQuery(new Date(Date.now() + 365 * 24 * 60 * MIN), 10)).toEqual([]);
    });

    it('stops at once on a 400', async () => {
      const link = await started();
      await openPr('open');
      posthog.claimFailures = [400];
      expect(await syncPostHogClaim(link.id)).toBe('gave_up');
    });

    it('records a lost claim when somebody took the report over', async () => {
      const link = await started();
      await openPr('open');
      posthog.claimByOther('rep-1');
      expect(await syncPostHogClaim(link.id)).toBe('lost');
      const row = await onlyLink();
      expect(row).toMatchObject({ posthogClaimState: 'lost', posthogClaimNextCheckAt: null, status: 'active' });
      expect(row.posthogClaimReason).toMatch(/took the report over/);
    });

    it('waits while the connection cannot claim, then attaches after a reconnect', async () => {
      const link = await started();
      await openPr('open');
      await connectWithOAuth('openid inbox:read');
      expect(await syncPostHogClaim(link.id)).toBe('failed');
      expect((await onlyLink()).posthogClaimError).toMatch(/Connect PostHog again/);
      await connectWithApiKey();
      expect(await syncPostHogClaim(link.id)).toBe('attached');
    });
  });

  // ---- 3. Release ----------------------------------------------------------

  describe('the release', () => {
    async function expectReleased(reason: RegExp) {
      expect(posthog.claimCalls.at(-1)?.body).toEqual({ claim_id: 'claim-1', release: true });
      expect(posthog.activeClaim('rep-1')).toBeNull();
      const row = await onlyLink();
      expect(row).toMatchObject({ status: 'failed', posthogClaimState: 'released', posthogClaimNextCheckAt: null });
      expect(row.posthogClaimReason).toMatch(reason);
      const [history] = await listWorkflowRuns((await runs())[0].workflowId, { limit: 10 });
      expect(history.posthogClaim).toMatchObject({ state: 'released', reason: expect.stringMatching(reason) });
    }

    it('releases when the session is archived without a pull request', async () => {
      const link = await started();
      await testDb.db.update(workbenches).set({ archivedAt: new Date(), status: 'archived' }).where(eq(workbenches.id, 'wb-1'));
      expect(await syncPostHogClaim(link.id)).toBe('released');
      await expectReleased(/archived without a pull request/);
    });

    it('releases when the session is deleted, after the grace for work that never attached', async () => {
      const link = await started();
      // Deleting the session clears the link's session id (ON DELETE set null).
      await testDb.db.delete(workbenches).where(eq(workbenches.id, 'wb-1'));
      expect(await syncPostHogClaim(link.id)).toBe('watching');
      expect(await syncPostHogClaim(link.id, new Date(Date.now() + UNATTACHED_CLAIM_GRACE_MS + MIN))).toBe('released');
      await expectReleased(/work never started/);
    });

    it.each([
      ['the diagnosis is wrong', `I checked the code.\n\n${TALYN_REPORT_NOT_FIXED_SENTINEL} the diagnosis is wrong`, /diagnosis is wrong/],
      ['the problem is fixed', `Already fixed in #12.\n${TALYN_REPORT_NOT_FIXED_SENTINEL} fixed in #12\n\n`, /fixed in #12/],
      ['no reason', `Nothing to do.\n${TALYN_REPORT_NOT_FIXED_SENTINEL}`, /stopped without a fix/],
      ['a sentinel in backticks', `Done.\n\`${TALYN_REPORT_NOT_FIXED_SENTINEL} not in this repository\``, /not in this repository/],
    ])('releases when the agent stops because %s', async (_name, text, reason) => {
      const link = await started();
      await sessionSaid(text);
      expect(await syncPostHogClaim(link.id)).toBe('released');
      await expectReleased(reason);
    });

    it.each([
      ['the sentinel is not the last line', `${TALYN_REPORT_NOT_FIXED_SENTINEL} maybe\nThen I fixed it.`, {}],
      ['the agent only mentions it', `I will not write ${TALYN_REPORT_NOT_FIXED_SENTINEL} because I fixed it.`, {}],
      ['the session is still working', `${TALYN_REPORT_NOT_FIXED_SENTINEL} wrong`, { busy: true }],
    ])('keeps the claim when %s', async (_name, text, opts) => {
      const link = await started();
      await sessionSaid(text, opts);
      expect(await syncPostHogClaim(link.id)).toBe('watching');
      expect(await onlyLink()).toMatchObject({ status: 'active', posthogClaimState: 'claimed' });
      expect(posthog.claimCalls).toHaveLength(1);
    });

    it.each([
      [SESSION_ERROR_GRACE_MS + MIN, 'released'],
      [SESSION_ERROR_GRACE_MS - MIN, 'watching'],
    ])('treats a session in error for %i ms as %s', async (age, outcome) => {
      const link = await started();
      await testDb.db
        .update(workbenches)
        .set({ status: 'error', updatedAt: new Date(Date.now() - age) })
        .where(eq(workbenches.id, 'wb-1'));
      expect(await syncPostHogClaim(link.id)).toBe(outcome);
      if (outcome === 'released') await expectReleased(/session failed/);
    });

    it('releases when the pull request closes without a merge', async () => {
      const link = await started();
      await openPr('open');
      await syncPostHogClaim(link.id);
      await openPr('closed');
      expect(await handlePullRequestSettled('ws1', 'pr-1', 'closed')).toBe(1);
      await expectReleased(/closed without a merge/);
      // The pull request stays on the report; only the ownership ends.
      expect(posthog.claims.get('rep-1')?.pullRequests).toEqual([PR_URL]);
    });

    it('settles a release PostHog already ended (it suppresses a report whose pull requests all closed)', async () => {
      const link = await started();
      await openPr('open');
      await syncPostHogClaim(link.id);
      posthog.claims.get('rep-1')!.released = true;
      await openPr('closed');
      await handlePullRequestSettled('ws1', 'pr-1', 'closed');
      const row = await onlyLink();
      expect(row).toMatchObject({ posthogClaimState: 'released', posthogClaimNextCheckAt: null });
      expect(row.posthogClaimReason).toMatch(/PostHog had already ended the claim/);
    });

    it.each([500, 503, 429, 403])('retries a release PostHog refused with %i', async (status) => {
      const link = await started();
      await testDb.db.update(workbenches).set({ archivedAt: new Date() }).where(eq(workbenches.id, 'wb-1'));
      posthog.claimFailures = [status];
      expect(await syncPostHogClaim(link.id)).toBe('failed');
      expect(await onlyLink()).toMatchObject({ status: 'failed', posthogClaimState: 'claimed', posthogClaimAttempts: 1 });
      _resetClaimGatesForTests();
      expect(await syncPostHogClaim(link.id)).toBe('released');
      await expectReleased(/archived without a pull request/);
    });

    it('marks the claim merged when the pull request merges, and releases nothing', async () => {
      const link = await started();
      await openPr('open');
      await syncPostHogClaim(link.id);
      await openPr('merged');
      expect(await handlePullRequestSettled('ws1', 'pr-1', 'merged')).toBe(1);
      const row = await onlyLink();
      expect(row).toMatchObject({ status: 'done', posthogClaimState: 'merged', posthogClaimNextCheckAt: null });
      expect(claimBodies().some((b) => b.release)).toBe(false);
      expect(posthog.activeClaim('rep-1')).not.toBeNull();
    });

    it('attaches a pull request that merged before the sweep saw it open', async () => {
      await started();
      await openPr('merged');
      await handlePullRequestSettled('ws1', 'pr-1', 'merged');
      expect(claimBodies().at(-1)).toEqual({ claim_id: 'claim-1', pull_requests: [PR_URL] });
      expect(await onlyLink()).toMatchObject({ status: 'done', posthogClaimState: 'merged', posthogClaimPrUrl: PR_URL });
    });

    it('does not release a claim that a newer run for the same report took over', async () => {
      const link = await started();
      // A newer link holds the same claim (a stale link taken over).
      await testDb.db.update(externalIssueLinks).set({ status: 'failed', statusReason: 'the work never started' });
      await testDb.db.insert(externalIssueLinks).values({
        id: 'newer',
        workspaceId: 'ws1',
        integration: 'posthog_inbox',
        runId: 'run-x',
        externalId: 'rep-1',
        externalKey: 'Report rep-1',
        posthogClaimId: 'claim-1',
        posthogClaimState: 'claimed',
      });
      expect(await syncPostHogClaim(link.id)).toBe('released');
      expect(posthog.claimCalls).toHaveLength(1);
      expect(posthog.activeClaim('rep-1')).not.toBeNull();
    });

    it('keeps watching a live session with no pull request', async () => {
      const link = await started();
      const now = new Date();
      expect(await syncPostHogClaim(link.id, now)).toBe('watching');
      expect((await onlyLink()).posthogClaimNextCheckAt!.getTime()).toBe(now.getTime() + WATCH_INTERVAL_MS);
      expect(posthog.claimCalls).toHaveLength(1);
    });

    it('ignores links without a PostHog claim', async () => {
      await testDb.db.insert(externalIssueLinks).values({
        id: 'issue',
        workspaceId: 'ws1',
        integration: 'linear',
        externalId: 'iss-1',
        externalKey: 'ENG-1',
      });
      expect(await syncPostHogClaim('issue')).toBe('skipped');
      expect(await syncPostHogClaim('missing')).toBe('skipped');
    });
  });

  describe('egress', () => {
    it('reads only due PostHog claims through the partial index', () => {
      const { sql } = dueClaimsQuery(new Date(), 25).toSQL();
      expect(sql).toContain('"posthog_claim_next_check_at" <=');
      expect(sql).toContain('limit');
      expect(sql).not.toContain('"facts"');
    });

    it('reads the history claims by run id, without the link facts', () => {
      const { sql } = posthogClaimsForRunsQuery(['run-1']).toSQL();
      expect(sql).toContain('"run_id" in');
      expect(sql).not.toContain('"facts"');
    });
  });
});
