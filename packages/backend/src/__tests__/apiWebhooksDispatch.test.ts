import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import {
  apiWebhookDeliveries,
  pullRequests,
  repositories,
  workbenchChats,
  workbenches,
  workspaces,
} from '../db/schema.js';
import { debugBus } from '../services/debugBus.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import {
  dispatchWebhookSignal,
  invalidateWebhookTargets,
  resetWebhookDispatchForTests,
  settleWebhookDispatchForTests,
  swapObjectState,
} from '../services/apiWebhooks/dispatch.js';
import { webhookPullRequestQuery } from '../services/apiWebhooks/events.js';
import { sendWebhookSignal, setWebhookSignalHandler, type WebhookSignal } from '../services/apiWebhooks/signals.js';
import { insertEndpoint, listDeliveriesQuery, listEndpointsQuery } from '../services/apiWebhooks/store.js';

/**
 * The dispatcher: which endpoints get an event, which changes are events, and
 * that each fact is enqueued once. No HTTP here; the worker test sends.
 */

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('webhook dispatcher', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  async function endpoint(ownerId: string, opts: { workspaceId?: string | null; eventTypes?: string[]; enabled?: boolean } = {}) {
    const { row } = await insertEndpoint({
      ownerId,
      workspaceId: opts.workspaceId ?? null,
      url: 'https://hooks.example.com/talyn',
      description: null,
      eventTypes: opts.eventTypes ?? [],
      enabled: opts.enabled ?? true,
    });
    invalidateWebhookTargets();
    return row.id;
  }

  async function send(...signals: WebhookSignal[]): Promise<void> {
    for (const s of signals) sendWebhookSignal(s);
    await settleWebhookDispatchForTests();
  }

  async function deliveries(type?: string): Promise<Array<{ endpointId: string; eventType: string; eventId: string; payload: Loose }>> {
    const rows = await testDb.db.select().from(apiWebhookDeliveries);
    return rows.filter((r) => !type || r.eventType === type) as never;
  }

  const sessionSignal = (patch: Partial<{ status: string; archivedAt: string | null; pullRequestId: string | null }> = {}): WebhookSignal => ({
    kind: 'session',
    workspaceId: 'ws-a',
    session: { id: 'wb-1', status: 'provisioning', archivedAt: null, pullRequestId: null, ...patch },
  });

  const prSignal = (state: string, summary: Record<string, unknown> = {}, codeReview?: Record<string, unknown> | null): WebhookSignal => ({
    kind: 'pull_request',
    workspaceId: 'ws-a',
    pullRequest: { id: 'pr-1', state, lastSummary: { title: 'Fix it', draft: false, ...summary }, codeReview },
  });

  beforeEach(async () => {
    vi.stubEnv('PUBLIC_API_ENABLED', 'true');
    vi.stubEnv('TALYN_TOKEN_KEY', Buffer.from('k'.repeat(32)).toString('base64'));
    resetFeatureFlagsForTests();
    resetWebhookDispatchForTests();
    setWebhookSignalHandler(dispatchWebhookSignal);
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-a2', ownerId: 'owner-a', name: 'A2' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await testDb.db.insert(repositories).values({
      id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main',
    });
    await testDb.db.insert(workbenches).values({
      id: 'wb-1', workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'acme/app', name: 'calm-river',
      branch: 'talyn/calm-river', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'provisioning',
      sandboxId: 'sandbox-secret',
    });
    await testDb.db.insert(workbenchChats).values({
      id: 'chat-1', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Chat', agent: 'claude', status: 'running', turnCount: 2,
    });
    await testDb.db.insert(pullRequests).values({
      id: 'pr-1', workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'acme', repo: 'app', number: 7, state: 'open',
      lastSummary: { title: 'Fix it', draft: false, url: 'https://github.com/acme/app/pull/7', checks: { big: 'x'.repeat(100) } },
    });
  });

  afterEach(async () => {
    await settleWebhookDispatchForTests();
    setWebhookSignalHandler(null);
    resetWebhookDispatchForTests();
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
  });

  describe('who receives an event', () => {
    it('sends to the owner\'s endpoints for that workspace and to nobody else', async () => {
      const all = await endpoint('owner-a');
      const bound = await endpoint('owner-a', { workspaceId: 'ws-a' });
      await endpoint('owner-a', { workspaceId: 'ws-a2' });
      await endpoint('owner-b');
      await endpoint('owner-a', { enabled: false });
      await endpoint('owner-a', { eventTypes: ['pull_request.merged'] });
      const wanted = await endpoint('owner-a', { eventTypes: ['session.created', 'chat.turn_started'] });

      await send({ kind: 'session_created', workspaceId: 'ws-a', sessionId: 'wb-1' });

      const rows = await deliveries('session.created');
      expect(rows.map((r) => r.endpointId).sort()).toEqual([all, bound, wanted].sort());
      // One event, one id, for every endpoint.
      expect(new Set(rows.map((r) => r.eventId)).size).toBe(1);
    });

    it('sends nothing when the owner is outside the public-api audience', async () => {
      await endpoint('owner-a');
      vi.stubEnv('PUBLIC_API_ENABLED', 'false');
      resetFeatureFlagsForTests();
      await send({ kind: 'session_created', workspaceId: 'ws-a', sessionId: 'wb-1' });
      expect(await deliveries()).toHaveLength(0);
    });

    it('does nothing at all for a workspace with no endpoints', async () => {
      await endpoint('owner-b');
      await send(sessionSignal(), prSignal('open'));
      expect(await deliveries()).toHaveLength(0);
      expect(await testDb.pglite.query('SELECT * FROM api_webhook_object_states')).toMatchObject({ rows: [] });
    });

    it('sees a new endpoint once the cache is invalidated', async () => {
      await send({ kind: 'session_created', workspaceId: 'ws-a', sessionId: 'wb-1' });
      await endpoint('owner-a');
      await send({ kind: 'turn_started', workspaceId: 'ws-a', chatId: 'chat-1', turn: 2 });
      expect(await deliveries('chat.turn_started')).toHaveLength(1);
    });
  });

  describe('sessions', () => {
    it('builds the envelope in the public shape, with no internal field', async () => {
      await endpoint('owner-a');
      await send({ kind: 'session_created', workspaceId: 'ws-a', sessionId: 'wb-1' });
      const [row] = await deliveries('session.created');
      expect(row.payload).toMatchObject({
        id: expect.stringMatching(/^evt_[0-9a-f]{32}$/),
        type: 'session.created',
        workspace_id: 'ws-a',
        created_at: expect.any(String),
        data: { object: { object: 'session', id: 'wb-1', status: 'provisioning', repository_full_name: 'acme/app' } },
      });
      expect(JSON.stringify(row.payload)).not.toContain('sandbox-secret');
    });

    it('does not read the emit after a create as a change, then announces a status change with the old value', async () => {
      await endpoint('owner-a');
      await send({ kind: 'session_created', workspaceId: 'ws-a', sessionId: 'wb-1' }, sessionSignal());
      expect(await deliveries('session.updated')).toHaveLength(0);

      await testDb.db.update(workbenches).set({ status: 'ready' }).where(eq(workbenches.id, 'wb-1'));
      await send(sessionSignal({ status: 'ready' }), sessionSignal({ status: 'ready' }));
      const updated = await deliveries('session.updated');
      expect(updated).toHaveLength(1);
      expect(updated[0].payload.data).toMatchObject({ object: { status: 'ready' }, previous_attributes: { status: 'provisioning' } });
    });

    it('sends session.updated with no previous value the first time it sees a session', async () => {
      await endpoint('owner-a');
      await send(sessionSignal({ status: 'error' }));
      const [row] = await deliveries('session.updated');
      expect(row.payload.data.previous_attributes).toEqual({});
    });

    it('sends session.archived for the archive, once, and not session.updated', async () => {
      await endpoint('owner-a');
      await send({ kind: 'session_created', workspaceId: 'ws-a', sessionId: 'wb-1' });
      const archivedAt = new Date('2026-11-02T10:00:00Z');
      await testDb.db.update(workbenches).set({ status: 'ready', archivedAt }).where(eq(workbenches.id, 'wb-1'));
      await send(sessionSignal({ status: 'ready', archivedAt: archivedAt.toISOString() }));
      await send(sessionSignal({ status: 'ready', archivedAt: archivedAt.toISOString() }));
      expect(await deliveries('session.archived')).toHaveLength(1);
      expect(await deliveries('session.updated')).toHaveLength(0);
      const [row] = await deliveries('session.archived');
      expect(row.payload.data.object).toMatchObject({ status: 'archived', archived_at: archivedAt.toISOString() });
    });

    it('sends session.pull_request_opened when a pull request is linked', async () => {
      await endpoint('owner-a');
      await send({ kind: 'session_created', workspaceId: 'ws-a', sessionId: 'wb-1' });
      await testDb.db.update(workbenches).set({ pullRequestId: 'pr-1' }).where(eq(workbenches.id, 'wb-1'));
      await send(sessionSignal({ pullRequestId: 'pr-1' }), sessionSignal({ pullRequestId: 'pr-1' }));
      const rows = await deliveries('session.pull_request_opened');
      expect(rows).toHaveLength(1);
      expect(rows[0].payload.data).toMatchObject({
        object: { id: 'wb-1', pull_request_id: 'pr-1' },
        pull_request: { object: 'pull_request', id: 'pr-1', number: 7, repository_full_name: 'acme/app', title: 'Fix it' },
      });
    });

    it('serialises the signals for one session, so a quick pair is compared in order', async () => {
      await endpoint('owner-a');
      await testDb.db.update(workbenches).set({ status: 'ready' }).where(eq(workbenches.id, 'wb-1'));
      dispatchWebhookSignal({ kind: 'session_created', workspaceId: 'ws-a', sessionId: 'wb-1' });
      dispatchWebhookSignal(sessionSignal({ status: 'ready' }));
      await settleWebhookDispatchForTests();
      expect(await deliveries('session.created')).toHaveLength(1);
      expect(await deliveries('session.updated')).toHaveLength(0);
    });
  });

  describe('chats', () => {
    it('sends a turn start and its end once each, with the turn and the final status', async () => {
      await endpoint('owner-a');
      const started: WebhookSignal = { kind: 'turn_started', workspaceId: 'ws-a', chatId: 'chat-1', turn: 2 };
      const completed: WebhookSignal = { kind: 'turn_completed', workspaceId: 'ws-a', chatId: 'chat-1', turn: 2, finalStatus: 'awaiting_input' };
      await send(started, started, completed, completed);
      const [start] = await deliveries('chat.turn_started');
      const [end] = await deliveries('chat.turn_completed');
      expect((await deliveries()).length).toBe(2);
      expect(start.payload.data).toMatchObject({ object: { object: 'chat', id: 'chat-1', session_id: 'wb-1' }, turn: 2 });
      expect(end.payload.data).toMatchObject({ turn: 2, final_status: 'awaiting_input' });
      await send({ kind: 'turn_started', workspaceId: 'ws-a', chatId: 'chat-1', turn: 3 });
      expect(await deliveries('chat.turn_started')).toHaveLength(2);
    });
  });

  describe('pull requests', () => {
    it('records the first sight silently, then sends a change with its old values', async () => {
      await endpoint('owner-a');
      await send(prSignal('open'));
      expect(await deliveries()).toHaveLength(0);
      await testDb.db.update(pullRequests).set({ lastSummary: { title: 'Fix it properly', draft: true } }).where(eq(pullRequests.id, 'pr-1'));
      await send(prSignal('open', { title: 'Fix it properly', draft: true }));
      const [row] = await deliveries('pull_request.updated');
      expect(row.payload.data).toMatchObject({
        object: { object: 'pull_request', title: 'Fix it properly', draft: true, state: 'open' },
        previous_attributes: { title: 'Fix it', draft: false },
      });
      // The check-run emits that change nothing else are not events.
      await send(prSignal('open', { title: 'Fix it properly', draft: true, checks: { passed: 9 } }));
      expect(await deliveries()).toHaveLength(1);
    });

    it('sends pull_request.merged with merged_at, once', async () => {
      await endpoint('owner-a');
      await send(prSignal('open'));
      const mergedAt = new Date('2026-11-02T11:00:00Z');
      await testDb.db.update(pullRequests).set({ state: 'merged', mergedAt }).where(eq(pullRequests.id, 'pr-1'));
      await send(prSignal('merged'), prSignal('merged'));
      const rows = await deliveries('pull_request.merged');
      expect(rows).toHaveLength(1);
      expect(rows[0].payload.data.object).toMatchObject({ state: 'merged', merged_at: mergedAt.toISOString(), html_url: 'https://github.com/acme/app/pull/7' });
      expect(await deliveries('pull_request.updated')).toHaveLength(0);
    });

    it('sends pull_request.closed, and pull_request.updated for a reopen', async () => {
      await endpoint('owner-a');
      await send(prSignal('open'), prSignal('closed'), prSignal('open'));
      expect(await deliveries('pull_request.closed')).toHaveLength(1);
      const [reopen] = await deliveries('pull_request.updated');
      expect(reopen.payload.data.previous_attributes).toEqual({ state: 'closed' });
    });

    it('does not ship last_summary: the event reads three keys of it in SQL', () => {
      const sqlText = webhookPullRequestQuery('pr-1').toSQL().sql;
      expect(sqlText).toContain(`->> 'title'`);
      expect(sqlText).not.toMatch(/"last_summary"\s*(,|from)/i);
    });
  });

  describe('code reviews and the merge queue', () => {
    const review = (phase: string) => ({ id: 'rev-1', phase, headSha: 'abc', reviewedHeadSha: 'abc', openCount: 2, startedAt: '2026-11-02T09:00:00Z' });

    it('sends code_review.completed once per finished cycle', async () => {
      await endpoint('owner-a', { eventTypes: ['code_review.completed'] });
      await send(prSignal('open', {}, review('reviewing')));
      expect(await deliveries()).toHaveLength(0);
      await send(prSignal('open', {}, review('ready')), prSignal('open', {}, review('ready')));
      const rows = await deliveries('code_review.completed');
      expect(rows).toHaveLength(1);
      expect(rows[0].payload.data.object).toMatchObject({ object: 'code_review', id: 'rev-1', result: 'ready', open_finding_count: 2, pull_request_id: 'pr-1' });
      // A new cycle is a new event.
      await send(prSignal('open', {}, { ...review('failed'), startedAt: '2026-11-02T12:00:00Z', failureReason: 'No reviewer ran.' }));
      expect(await deliveries('code_review.completed')).toHaveLength(2);
    });

    it('sends merge_queue.blocked with the reason', async () => {
      await endpoint('owner-a');
      await send({ kind: 'merge_queue_blocked', workspaceId: 'ws-a', pullRequestId: 'pr-1', reason: 'merge conflicts', attempts: 3 });
      const [row] = await deliveries('merge_queue.blocked');
      expect(row.payload.data).toMatchObject({ object: { id: 'pr-1', number: 7 }, reason: 'merge conflicts', attempts: 3 });
    });
  });

  describe('safety', () => {
    it('never throws into the emitter, and records the fault', async () => {
      setWebhookSignalHandler(() => {
        throw new Error('boom');
      });
      expect(() => sendWebhookSignal(sessionSignal())).not.toThrow();

      setWebhookSignalHandler(dispatchWebhookSignal);
      await endpoint('owner-a');
      const record = vi.spyOn(debugBus, 'recordEvent');
      await testDb.pglite.exec('DROP TABLE api_webhook_object_states');
      expect(() => sendWebhookSignal(sessionSignal())).not.toThrow();
      await settleWebhookDispatchForTests();
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ service: 'api_webhooks', action: 'dispatch_failed', ok: false }));
    });

    it('lets one of two concurrent compare-and-sets win', async () => {
      await swapObjectState('session:x', 'a');
      const results = await Promise.all([swapObjectState('session:x', 'b'), swapObjectState('session:x', 'b')]);
      expect(results.filter((r) => r.changed)).toHaveLength(1);
      expect(results.find((r) => r.changed)?.previous).toBe('a');
    });

    it('lists without the big or secret columns', () => {
      expect(listDeliveriesQuery('e', undefined, null, 10).toSQL().sql).not.toContain('"payload"');
      expect(listEndpointsQuery('o', null, null, 10).toSQL().sql).not.toContain('secret_enc');
    });
  });
});
