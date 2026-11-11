import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { SlackEventFacts, Workbench } from '@talyn/shared';
import { defaultFleetModelForAgent, validateWorkflow } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { FakeSlack } from './helpers/fakeSlack.js';
import {
  repositories,
  slackInstallations,
  slackThreads,
  slackTriggerMessages,
  slackUserLinks,
  workflowRuns,
  workspaces,
} from '../db/schema.js';
import type { CreateWorkbenchServiceInput } from '../services/workbenches/create.js';
import type { WebhookDelivery } from '../services/webhookPayload.js';
import type { PRSummary } from '../services/githubGraphql.js';

/**
 * Slack channel rules end to end against a fake Slack: the source adapter's
 * facts and drops, the target lookup, the author link, the claim, the
 * per-channel cap, and the three actions a Slack rule runs (start a session,
 * reply, react), plus `start_session` on a GitHub rule and the retry of a
 * parked Slack run.
 *
 * The session is stubbed at `createWorkbench` (its own tests cover it); what
 * is pinned here is what a rule hands it.
 */

vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: () => undefined,
  broadcastToUser: () => undefined,
}));

vi.mock('../services/workbenches/readiness.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/workbenches/readiness.js')>()),
  workbenchReadiness: async () => ({
    sandbox: { ok: true, reasons: [], agents: { claude: { ok: true }, codex: { ok: true } } },
  }),
}));

const created: Array<{ input: CreateWorkbenchServiceInput; actor: { id: string } }> = [];
let createRefusal: Error | null = null;
vi.mock('../services/workbenches/create.js', () => ({
  createWorkbench: async (input: CreateWorkbenchServiceInput, actor: { id: string }) => {
    if (createRefusal) throw createRefusal;
    created.push({ input, actor });
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

let prSummary: { rowId: string; summary: Partial<PRSummary> } | null = null;
vi.mock('../services/prCache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/prCache.js')>()),
  getOrFetchPRSummary: async () => prSummary,
}));

const { ingestSlackEvent, processSlackEvent } = await import('../services/slack/events.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { encryptString } = await import('../services/tokenCrypto.js');
const { resetSlackTokenStateForTests } = await import('../services/slack/tokens.js');
const { resetSlackNameCacheForTests } = await import('../services/slack/context.js');
const { resetSlackStatusForTests } = await import('../services/slack/statusReactions.js');
const { resetWebAppUrlCacheForTests } = await import('../services/webApp.js');
const { WorkbenchError } = await import('../services/workbenches/errors.js');
const { ConcurrentBoxLimitError, UsageExhaustedError } = await import('../services/billing/entitlements.js');
const { createWorkflow, _resetWorkflowStore } = await import('../services/workflows/store.js');
const { evaluateWorkflows, evaluateWorkflowsForDelivery } = await import('../services/workflows/engine.js');
const { workflowRetrySweep } = await import('../services/workflows/retrySweep.js');
const { slackFactsFromEvent, slackTargetsQuery, slackWorkflowSource } = await import(
  '../services/workflows/sources/slack.js'
);

const BOT = 'UBOT';
const FULL_SCOPE = 'app_mentions:read,chat:write,reactions:write,channels:history,channels:read';
type Event = Record<string, unknown>;

function message(over: Event = {}): Event {
  return {
    type: 'message',
    channel_type: 'channel',
    channel: 'C1',
    user: 'US1',
    text: 'checkout is broken on acme/web-app',
    ts: '100.0',
    ...over,
  };
}

describe('Slack channel rules', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let slack: FakeSlack;
  let eventSeq = 0;

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    vi.stubEnv('SLACK_CHANNEL_RULES_ENABLED', 'true');
    vi.stubEnv('WEB_APP_URL', 'https://app.talyn.test');
    resetFeatureFlagsForTests();
    resetWebAppUrlCacheForTests();
    resetSlackTokenStateForTests();
    resetSlackNameCacheForTests();
    resetSlackStatusForTests();
    _resetWorkflowStore();
    created.length = 0;
    createRefusal = null;
    prSummary = null;

    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'u1', email: 'owner@example.test' });
    await seedUser(testDb.db, { id: 'u2' });
    await seedUser(testDb.db, { id: 'u3' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws1', ownerId: 'u1', name: 'One' },
      { id: 'ws2', ownerId: 'u2', name: 'Two' },
      { id: 'ws3', ownerId: 'u3', name: 'Three' },
    ]);
    await testDb.db.insert(repositories).values([
      { id: 'r-web', workspaceId: 'ws1', name: 'web-app', url: 'https://github.com/acme/web-app' },
      { id: 'r-api', workspaceId: 'ws1', name: 'billing-api', url: 'https://github.com/acme/billing-api' },
    ]);
    await testDb.db.insert(slackInstallations).values({
      teamId: 'T1',
      teamName: 'Acme',
      appId: 'A1',
      botUserId: BOT,
      scope: FULL_SCOPE,
      accessTokenEnc: encryptString('xoxb-secret'),
      installedByUserId: 'u1',
    });
    // US1 is linked (u1). u2 is linked in T1 under another Slack user, so its
    // workspace may watch the team. u3 has no part in the team.
    await testDb.db.insert(slackUserLinks).values([
      { id: 'l1', teamId: 'T1', slackUserId: 'US1', userId: 'u1', workspaceId: 'ws1' },
      { id: 'l2', teamId: 'T1', slackUserId: 'US2', userId: 'u2', workspaceId: 'ws2' },
    ]);

    slack = new FakeSlack();
    slack.handlers['conversations.replies'] = (form) => ({
      ok: true,
      messages: [{ ts: form.ts, user: 'US1', text: 'checkout is broken on acme/web-app' }],
      has_more: false,
    });
    slack.handlers['users.info'] = (form) => ({
      ok: true,
      user: { profile: { display_name: { US1: 'Tom', US9: 'Stranger' }[form.user] ?? '' } },
    });
    slack.handlers['conversations.info'] = () => ({ ok: true, channel: { name: 'eng-bugs' } });
    slack.handlers['chat.getPermalink'] = (form) => ({
      ok: true,
      permalink: `https://acme.slack.com/archives/${form.channel}/p${form.message_ts}`,
    });
    slack.install();
  });

  afterEach(async () => {
    slack.uninstall();
    resetSlackStatusForTests();
    _resetWorkflowStore();
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
    resetWebAppUrlCacheForTests();
  });

  async function addRule(workspaceId = 'ws1', over: Record<string, unknown> = {}) {
    return createWorkflow(
      workspaceId,
      validateWorkflow({
        integration: 'slack',
        name: 'Bugs channel',
        events: ['slack_message'],
        conditions: { slackTeamId: 'T1', channels: ['C1', 'C2'] },
        actions: [{ type: 'slack_react', emoji: 'eyes' }],
        ...over,
      })
    );
  }

  async function deliver(event: Event, eventId = `Ev${++eventSeq}`) {
    await ingestSlackEvent({ type: 'event_callback', team_id: 'T1', event_id: eventId, event });
    return { eventId, outcome: await processSlackEvent(eventId) };
  }

  async function runs() {
    return testDb.db.select().from(workflowRuns);
  }

  function input(event: Event, eventId = 'Ev1') {
    return { eventId, teamId: 'T1', event, botUserId: BOT };
  }

  // -------------------------------------------------------------------------
  // The adapter's facts (pure)
  // -------------------------------------------------------------------------

  describe('facts', () => {
    it.each<[string, Event, Partial<SlackEventFacts> | null]>([
      ['a top-level message in a channel', {}, { channelId: 'C1', userId: 'US1', ts: '100.0', threadTs: null }],
      ['a message in a private channel', { channel_type: 'group', channel: 'G1' }, { channelId: 'G1' }],
      ['a thread reply', { thread_ts: '99.0' }, { threadTs: '99.0' }],
      ['a file share', { subtype: 'file_share' }, { ts: '100.0' }],
      ['a thread broadcast', { subtype: 'thread_broadcast', thread_ts: '99.0' }, { threadTs: '99.0' }],
      ['a mention of someone else', { text: 'ping <@US2>' }, { text: 'ping <@US2>' }],
      ['a DM', { channel_type: 'im', channel: 'D1' }, null],
      ['a group DM', { channel_type: 'mpim' }, null],
      ['a bot message', { bot_id: 'B1' }, null],
      ['an edit (subtype)', { subtype: 'message_changed' }, null],
      ['an edit (edited)', { edited: { user: 'US1', ts: '101.0' } }, null],
      ['a delete', { subtype: 'message_deleted' }, null],
      ['a channel join', { subtype: 'channel_join' }, null],
      ['Talyn’s own bot user', { user: BOT }, null],
      ['a mention of Talyn', { text: '<@UBOT> fix this' }, null],
      ['a labelled mention of Talyn', { text: 'hey <@UBOT|talyn> look' }, null],
      ['a message with no ts', { ts: undefined }, null],
      ['another event type', { type: 'app_mention' }, null],
    ])('%s', (_label, over, expected) => {
      const facts = slackFactsFromEvent(input(message(over)));
      if (expected === null) {
        expect(facts).toEqual([]);
        return;
      }
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        integration: 'slack',
        event: 'slack_message',
        teamId: 'T1',
        authorLinked: false,
        ...expected,
      });
    });

    it('keys the delivery on the Slack event id', () => {
      expect(slackWorkflowSource.deliveryId(input(message(), 'Ev42'))).toBe('slack:Ev42');
    });
  });

  // -------------------------------------------------------------------------
  // Targets
  // -------------------------------------------------------------------------

  describe('targets', () => {
    it('selects explicit columns and repeats the partial index, never a blob', () => {
      const query = slackTargetsQuery('T1').toSQL();
      expect(query.sql).toContain(`"workflows"."integration" = 'slack'`);
      expect(query.sql).toContain(`("workflows"."conditions" ->> 'slackTeamId')`);
      expect(query.params).toContain('T1');
      for (const blob of ['"config"', '"actions"', '"events"', '"settings"', 'access_token_enc', 'refresh_token_enc', '"logo"']) {
        expect(query.sql).not.toContain(blob);
      }
      expect(query.sql).not.toMatch(/select\s+\*/i);
    });

    it.each([
      ['an installer’s workspace', 'ws1', {}, true],
      ['a linked owner’s workspace', 'ws2', {}, true],
      ['a workspace whose owner has no part in the team', 'ws3', {}, false],
      ['a disabled rule', 'ws1', { enabled: false }, false],
      ['a rule on another team', 'ws1', { conditions: { slackTeamId: 'T2', channels: ['C1'] } }, false],
    ])('%s', async (_label, workspaceId, over, expected) => {
      await addRule(workspaceId, over);
      const targets = await slackWorkflowSource.targets(input(message()), []);
      expect(targets.map((t) => t.workspaceId)).toEqual(expected ? [workspaceId] : []);
    });

    it('never targets a GitHub rule', async () => {
      await createWorkflow(
        'ws1',
        validateWorkflow({ name: 'gh', events: ['pr_opened'], actions: [{ type: 'watch_pr' }] })
      );
      expect(await slackWorkflowSource.targets(input(message()), [])).toEqual([]);
    });

    it('names a workspace once, however many of its rules watch the team', async () => {
      await addRule('ws1');
      await addRule('ws1', { name: 'Second' });
      expect(await slackWorkflowSource.targets(input(message()), [])).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // The wiring, the author link, the claim and the cap
  // -------------------------------------------------------------------------

  describe('from a Slack event', () => {
    it('runs a rule on a channel message, with the channel name and permalink filled in', async () => {
      const wf = await addRule();
      const { outcome } = await deliver(message());
      expect(outcome).toBe('handled');
      const [run] = await runs();
      expect(run).toMatchObject({
        workflowId: wf.id,
        integration: 'slack',
        deliveryId: expect.stringMatching(/^slack:Ev/),
        subjectKey: 'slack:T1:C1',
        subjectLabel: '#eng-bugs',
        status: 'succeeded',
      });
      expect(run.facts).toMatchObject({
        authorLinked: true,
        channelName: 'eng-bugs',
        permalink: 'https://acme.slack.com/archives/C1/p100.0',
      });
      expect(slack.reactionLog()).toEqual(['add:eyes@100.0']);
    });

    it.each([
      ['a bot message', message({ bot_id: 'B1' })],
      ['a mention of Talyn', message({ text: '<@UBOT> please fix' })],
      ['a channel no rule watches', message({ channel: 'C9' })],
    ])('runs nothing for %s', async (_label, event) => {
      await addRule();
      await deliver(event);
      expect(await runs()).toHaveLength(0);
      expect(slack.of('reactions.add')).toHaveLength(0);
    });

    it('reads no Slack name or permalink for a channel no rule watches', async () => {
      await addRule();
      await deliver(message({ channel: 'C9' }));
      expect(slack.of('conversations.info')).toHaveLength(0);
      expect(slack.of('chat.getPermalink')).toHaveLength(0);
    });

    it('does nothing while the Slack rules flag is off', async () => {
      vi.stubEnv('SLACK_CHANNEL_RULES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      await addRule();
      const { outcome } = await deliver(message());
      expect(outcome).toBe('ignored');
      expect(await runs()).toHaveLength(0);
    });

    it.each([
      ['a linked author, default rule', 'US1', undefined, true],
      ['an unlinked author, default rule', 'US9', undefined, true],
      ['an unlinked author, linked-only rule', 'US9', { kind: 'linked' }, false],
      ['an unlinked author, any author', 'US9', { kind: 'any' }, true],
      ['a listed user', 'US9', { kind: 'users', userIds: ['US9'] }, true],
      ['an unlisted linked user', 'US1', { kind: 'users', userIds: ['US9'] }, false],
    ])('authors: %s', async (_label, user, slackAuthors, runsExpected) => {
      await addRule('ws1', {
        conditions: { slackTeamId: 'T1', channels: ['C1'], ...(slackAuthors ? { slackAuthors } : {}) },
      });
      await deliver(message({ user }));
      expect(await runs()).toHaveLength(runsExpected ? 1 : 0);
    });

    it.each([
      [false, 0],
      [true, 1],
    ])('a thread reply with includeThreadReplies=%s runs %i rule(s)', async (include, expected) => {
      await addRule('ws1', { conditions: { slackTeamId: 'T1', channels: ['C1'], includeThreadReplies: include } });
      await deliver(message({ ts: '105.0', thread_ts: '100.0' }));
      expect(await runs()).toHaveLength(expected);
    });

    it('claims a redelivered event once', async () => {
      await addRule();
      const event = message();
      expect(await evaluateWorkflows(slackWorkflowSource, input(event, 'EvSame'))).toBe(1);
      expect(await evaluateWorkflows(slackWorkflowSource, input(event, 'EvSame'))).toBe(0);
      // Slack's own redelivery of the stored event is a no-op too.
      await deliver(event, 'EvTwice');
      await deliver(event, 'EvTwice');
      expect((await runs()).map((r) => r.deliveryId).sort()).toEqual(['slack:EvSame', 'slack:EvTwice']);
    });

    it.each([
      ['a second message in the same channel', 'C1', 'skipped'],
      ['a message in another watched channel', 'C2', 'succeeded'],
    ])('caps per channel: %s', async (_label, channel, status) => {
      await addRule('ws1', { maxRunsPerPrPerHour: 1 });
      await deliver(message(), 'EvA');
      await deliver(message({ channel, ts: '101.0' }), 'EvB');
      const second = (await runs()).find((r) => r.deliveryId === 'slack:EvB');
      expect(second?.status).toBe(status);
    });
  });

  // -------------------------------------------------------------------------
  // start_session
  // -------------------------------------------------------------------------

  describe('start_session on a Slack rule', () => {
    const startAction = (over: Record<string, unknown> = {}) => ({
      type: 'start_session',
      repositoryId: 'r-web',
      prompt: 'Investigate and fix the bug this message reports.',
      ...over,
    });

    it('creates the session as the owner, registers the thread, and links the run', async () => {
      const wf = await addRule('ws1', { actions: [startAction()] });
      await deliver(message());

      expect(created).toHaveLength(1);
      const [{ input: body, actor }] = created;
      const [run] = await runs();
      expect(actor.id).toBe('u1');
      expect(body).toMatchObject({
        workspaceId: 'ws1',
        repositoryId: 'r-web',
        runtime: 'sandbox',
        autoCreatePr: true,
        internetAccess: false,
        source: { kind: 'workflow', workflowId: wf.id, runId: run.id, integration: 'slack' },
      });
      // The rule's prompt first; the message after it, quoted as untrusted.
      expect(body.prompt!.startsWith('Investigate and fix the bug this message reports.')).toBe(true);
      expect(body.prompt).toContain('UNTRUSTED');
      expect(body.prompt).toContain('Tom: checkout is broken on acme/web-app');
      expect(body.prompt).toContain('https://acme.slack.com/archives/C1/p100.0');

      expect(run).toMatchObject({ status: 'succeeded', workbenchId: 'wb-1' });
      const [thread] = await testDb.db.select().from(slackThreads);
      expect(thread).toMatchObject({
        teamId: 'T1',
        channelId: 'C1',
        threadTs: '100.0',
        userId: 'u1',
        workspaceId: 'ws1',
        workbenchId: 'wb-1',
        phase: 'started',
        triggerMessageTs: '100.0',
      });
      const [claim] = await testDb.db.select().from(slackTriggerMessages);
      expect(claim).toMatchObject({ channelId: 'C1', messageTs: '100.0', eventId: `workflow:${run.id}` });
      // The "starting" status reaction is on the trigger message.
      expect(slack.reactionLog()).toEqual(['add:eyes@100.0']);
    });

    it('registers a thread reply under its thread', async () => {
      await addRule('ws1', {
        conditions: { slackTeamId: 'T1', channels: ['C1'], includeThreadReplies: true },
        actions: [startAction()],
      });
      await deliver(message({ ts: '105.0', thread_ts: '100.0' }));
      const [thread] = await testDb.db.select().from(slackThreads);
      expect(thread).toMatchObject({ threadTs: '100.0', triggerMessageTs: '105.0' });
    });

    it.each([
      ['the model’s agent', { model: defaultFleetModelForAgent('codex'), internetAccess: true }, 'codex', true],
      ['the workspace default', {}, 'claude', false],
    ])('runs with %s', async (_label, over, agent, internet) => {
      await addRule('ws1', { actions: [startAction(over)] });
      await deliver(message());
      expect(created[0].input).toMatchObject({ agent, internetAccess: internet });
    });

    it('lets Talyn choose the repository from the message', async () => {
      slack.handlers['conversations.replies'] = (form) => ({
        ok: true,
        messages: [{ ts: form.ts, user: 'US1', text: 'the acme/billing-api invoices 500' }],
      });
      await addRule('ws1', { actions: [startAction({ repositoryId: null })] });
      await deliver(message({ text: 'the acme/billing-api invoices 500' }));
      expect(created[0].input.repositoryId).toBe('r-api');
      const [thread] = await testDb.db.select().from(slackThreads);
      expect(thread.repoReason).toBe('explicit');
    });

    it('fails, not parks, when Talyn cannot choose the repository, and asks nobody', async () => {
      slack.handlers['conversations.replies'] = (form) => ({
        ok: true,
        messages: [{ ts: form.ts, user: 'US1', text: 'something is slow' }],
      });
      await addRule('ws1', { actions: [startAction({ repositoryId: null })] });
      await deliver(message({ text: 'something is slow' }));
      expect(created).toHaveLength(0);
      const [run] = await runs();
      expect(run.status).toBe('failed');
      expect(run.retryAfter).toBeNull();
      expect((run.actions as Array<{ code?: string }>)[0].code).toBe('repository_unresolved');
      expect(await testDb.db.select().from(slackThreads)).toHaveLength(0);
    });

    it.each([
      ['out of hours', () => new UsageExhaustedError({ tier: 'free', periodEnd: new Date(Date.now() + 86_400_000) }), 'usage_exhausted'],
      ['at the box cap', () => new ConcurrentBoxLimitError(2, 2), 'box_limit_reached'],
    ])('parks a box refusal (%s) and the retry starts the session', async (_label, refusal, code) => {
      createRefusal = refusal();
      await addRule('ws1', { actions: [startAction(), { type: 'slack_reply', text: 'Session: {{session.url}}' }] });
      await deliver(message());

      let [run] = await runs();
      // The session is owed, so the run is parked, not partial.
      expect(run.status).toBe('pending_retry');
      // The reply ran, but the session did not, so it has no link yet.
      expect(slack.of('chat.postMessage')[0].form.text).toBe('Session: {{session.url}}');
      expect((run.actions as Array<{ code?: string }>)[0].code).toBe(code);
      expect(run.retryAfter).not.toBeNull();
      const [failed] = await testDb.db.select().from(slackThreads);
      expect(failed.phase).toBe('failed');

      createRefusal = null;
      await testDb.db
        .update(workflowRuns)
        .set({ retryAfter: new Date(Date.now() - 1000) })
        .where(eq(workflowRuns.id, run.id));
      expect(await workflowRetrySweep.tick()).toBe(1);

      [run] = await runs();
      expect(run).toMatchObject({ status: 'succeeded', attempts: 2, workbenchId: 'wb-1' });
      // Only the owed action ran again: the reply is not posted twice.
      expect(slack.of('chat.postMessage')).toHaveLength(1);
      const [thread] = await testDb.db.select().from(slackThreads);
      expect(thread).toMatchObject({ phase: 'started', workbenchId: 'wb-1' });
    });

    it('parks the whole run as pending_retry when the session is its only action', async () => {
      createRefusal = new ConcurrentBoxLimitError(2, 2);
      await addRule('ws1', { actions: [startAction()] });
      await deliver(message());
      const [run] = await runs();
      expect(run.status).toBe('pending_retry');
      // A parked start keeps its "starting" reaction: the session is owed.
      expect(slack.reactionLog()).toEqual(['add:eyes@100.0']);
    });

    it('fails a refused start with session_unavailable and shows the failure', async () => {
      createRefusal = new WorkbenchError('Connect Claude to start a session.', 409, 'agent_not_connected');
      await addRule('ws1', { actions: [startAction()] });
      await deliver(message());
      const [run] = await runs();
      expect(run.status).toBe('failed');
      expect(run.actions).toEqual([
        expect.objectContaining({ code: 'session_unavailable', error: 'Connect Claude to start a session.' }),
      ]);
      expect(slack.reactionLog()).toEqual(['add:eyes@100.0', 'remove:eyes@100.0', 'add:x@100.0']);
    });

    it('starts one session per thread: a second rule on the same message stands down', async () => {
      await addRule('ws1', { actions: [startAction()] });
      await addRule('ws1', { name: 'Second', actions: [startAction()] });
      await deliver(message());
      expect(created).toHaveLength(1);
      const codes = (await runs()).map((r) => (r.actions as Array<{ code?: string }>)[0].code ?? 'ok').sort();
      expect(codes).toEqual(['ok', 'session_active']);
    });

    it('makes {{session.url}} available to a later reply in the same run', async () => {
      await addRule('ws1', { actions: [startAction(), { type: 'slack_reply', text: 'On it: {{session.url}}' }] });
      await deliver(message());
      expect(slack.of('chat.postMessage')[0].form.text).toBe('On it: https://app.talyn.test/open/session/wb-1');
    });
  });

  describe('start_session on a GitHub rule', () => {
    const target = { workspaceId: 'ws1', repositoryId: 'r-web', owner: 'acme', repo: 'web-app' };
    const delivery: WebhookDelivery = {
      deliveryId: 'gh-1',
      eventType: 'pull_request',
      action: 'opened',
      repoFullName: 'acme/web-app',
      enqueuedAtMs: 0,
      payload: {
        pull_request: {
          number: 7,
          title: 'Fix login',
          html_url: 'https://github.com/acme/web-app/pull/7',
          draft: false,
          user: { login: 'alice', type: 'User' },
          base: { ref: 'main' },
          head: { ref: 'alice/login' },
          labels: [],
        },
        sender: { login: 'alice', type: 'User' },
      },
    };

    it.each([
      ['an open PR', 'open', 'pr-7'],
      ['a merged PR', 'merged', undefined],
    ])('starts on the PR’s repository; on its branch only for %s', async (_label, state, fromPullRequestId) => {
      prSummary = { rowId: 'pr-7', summary: { state: state as PRSummary['state'], headBranch: 'alice/login' } };
      const wf = await createWorkflow(
        'ws1',
        validateWorkflow({
          name: 'Session per PR',
          events: ['pr_opened'],
          actions: [{ type: 'start_session', repositoryId: null, prompt: 'Review this.' }],
        })
      );
      expect(await evaluateWorkflowsForDelivery(delivery, [target])).toBe(1);
      const [run] = await runs();
      expect(created[0].input).toMatchObject({
        repositoryId: 'r-web',
        source: { kind: 'workflow', workflowId: wf.id, runId: run.id, integration: 'github' },
      });
      expect(created[0].input.fromPullRequestId).toBe(fromPullRequestId);
      expect(created[0].input.prompt).toContain('acme/web-app#7');
      // No `pull_requests` row behind the stubbed cache: the PR link fails its
      // foreign key, and the session link must still land.
      expect(run).toMatchObject({ status: 'succeeded', workbenchId: 'wb-1', pullRequestId: null });
      expect(await testDb.db.select().from(slackThreads)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // slack_reply and slack_react
  // -------------------------------------------------------------------------

  describe('slack_reply', () => {
    it.each([
      ['a top-level message, in a new thread under it', {}, '100.0'],
      ['a thread reply, in its thread', { ts: '105.0', thread_ts: '100.0' }, '100.0'],
    ])('posts for %s', async (_label, over, threadTs) => {
      await addRule('ws1', {
        conditions: { slackTeamId: 'T1', channels: ['C1'], includeThreadReplies: true },
        actions: [{ type: 'slack_reply', text: 'Seen in {{channel}}: {{message.text}}' }],
      });
      await deliver(message(over));
      const [post] = slack.of('chat.postMessage');
      expect(post.form).toEqual({
        channel: 'C1',
        thread_ts: threadTs,
        text: 'Seen in #eng-bugs: checkout is broken on acme/web-app',
      });
      expect(post.token).toBe('xoxb-secret');
      expect((await runs())[0].status).toBe('succeeded');
    });

    it.each([
      ['the stored scope lacks chat:write', 'reactions:write,channels:history', undefined],
      ['Slack answers missing_scope', FULL_SCOPE, { ok: false, error: 'missing_scope', needed: 'chat:write' }],
    ])('fails with slack_scope_missing, not retried, when %s', async (_label, scope, answer) => {
      await testDb.db.update(slackInstallations).set({ scope }).where(eq(slackInstallations.teamId, 'T1'));
      if (answer) slack.handlers['chat.postMessage'] = () => answer;
      await addRule('ws1', { actions: [{ type: 'slack_reply', text: 'hi' }] });
      await deliver(message());
      const [run] = await runs();
      expect(run.status).toBe('failed');
      expect(run.retryAfter).toBeNull();
      expect(run.actions).toEqual([expect.objectContaining({ code: 'slack_scope_missing' })]);
      expect(slack.of('chat.postMessage')).toHaveLength(answer ? 1 : 0);
    });

    it('parks a 429 as rate_gated until Slack’s Retry-After', async () => {
      slack.handlers['chat.postMessage'] = () =>
        new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
          status: 429,
          headers: { 'retry-after': '30' },
        });
      await addRule('ws1', { actions: [{ type: 'slack_reply', text: 'hi' }] });
      const before = Date.now();
      await deliver(message());
      const [run] = await runs();
      expect(run.status).toBe('pending_retry');
      expect(run.actions).toEqual([expect.objectContaining({ code: 'rate_gated' })]);
      const due = run.retryAfter!.getTime() - before;
      expect(due).toBeGreaterThanOrEqual(30_000);
      expect(due).toBeLessThan(45_000);

      // When it clears, the sweep posts it and nothing else.
      slack.handlers['chat.postMessage'] = () => ({ ok: true });
      await testDb.db.update(workflowRuns).set({ retryAfter: new Date(Date.now() - 1000) });
      expect(await workflowRetrySweep.tick()).toBe(1);
      expect((await runs())[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
      expect(slack.of('chat.postMessage')).toHaveLength(2);
    });
  });

  describe('slack_react', () => {
    it.each([
      ['adds the reaction', { ok: true }, 'succeeded', undefined],
      ['treats already_reacted as done', { ok: false, error: 'already_reacted' }, 'succeeded', undefined],
      ['fails on another Slack error', { ok: false, error: 'invalid_name' }, 'failed', 'slack_error'],
    ])('%s', async (_label, answer, status, code) => {
      slack.handlers['reactions.add'] = () => answer;
      await addRule('ws1', { actions: [{ type: 'slack_react', emoji: ':white_check_mark:' }] });
      await deliver(message());
      const [run] = await runs();
      expect(run.status).toBe(status);
      if (code) expect(run.actions).toEqual([expect.objectContaining({ code })]);
      expect(slack.of('reactions.add')[0].form).toEqual({ channel: 'C1', timestamp: '100.0', name: 'white_check_mark' });
    });
  });

  it('keeps the DM path a personal trigger: a DM never reaches a rule', async () => {
    await addRule();
    await deliver(message({ channel_type: 'im', channel: 'D1', text: 'fix it' }));
    expect(await runs()).toHaveLength(0);
  });
});
