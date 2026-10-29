import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { SlackNoticeEvent, Workbench } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { FakeSlack } from './helpers/fakeSlack.js';
import {
  repositories,
  slackInstallations,
  slackRepoMemory,
  slackThreads,
  slackUserLinks,
  workbenches,
  workspaces,
} from '../db/schema.js';
import type { CreateWorkbenchServiceInput } from '../services/workbenches/create.js';

/**
 * Slack triggers end to end against a fake Slack: who may trigger, which
 * events are ignored, idempotency, a follow-up into the same session, the
 * repository question and the pending-start route.
 *
 * The session itself is stubbed at `createWorkbench` (its own route tests
 * cover it); what is pinned here is what Slack hands it.
 */

const notices: Array<{ userId: string; notice: SlackNoticeEvent }> = [];
vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: () => undefined,
  broadcastToUser: (userId: string, event: { type: string; payload: unknown }) => {
    if (event.type === 'slack:notice') notices.push({ userId, notice: event.payload as SlackNoticeEvent });
  },
}));

vi.mock('../services/workbenches/readiness.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/workbenches/readiness.js')>()),
  workbenchReadiness: async () => ({
    sandbox: { ok: true, reasons: [], agents: { claude: { ok: true }, codex: { ok: true } } },
  }),
}));

const created: CreateWorkbenchServiceInput[] = [];
let createRefusal: Error | null = null;
vi.mock('../services/workbenches/create.js', () => ({
  createWorkbench: async (input: CreateWorkbenchServiceInput) => {
    if (createRefusal) throw createRefusal;
    created.push(input);
    const { insertWorkbench, insertChat, rowToWorkbench } = await import('../services/workbenches/store.js');
    const id = `wb-${created.length}`;
    const row = await insertWorkbench({
      id,
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      repoFullName: 'acme/x',
      name: id,
      branch: id,
      baseBranch: 'main',
      runtime: 'sandbox',
      agent: input.agent,
      model: input.model ?? null,
      status: 'provisioning',
      source: input.source ?? null,
    });
    await insertChat({ id: `chat-${id}`, workbenchId: id, workspaceId: input.workspaceId, title: 't', agent: input.agent, model: null, queuedMessages: [] });
    return rowToWorkbench(row) as Workbench;
  },
}));

const sent: Array<{ chatId: string; text: string }> = [];
let busy = false;
vi.mock('../services/workbenches/turns.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/workbenches/turns.js')>()),
  sendMessage: async (chatId: string, input: { text: string }) => {
    sent.push({ chatId, text: input.text });
    return { queued: busy };
  },
}));

const restored: string[] = [];
vi.mock('../services/workbenches/lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/workbenches/lifecycle.js')>()),
  restoreWorkbench: async (id: string) => {
    restored.push(id);
    const { updateWorkbench } = await import('../services/workbenches/store.js');
    return updateWorkbench(id, { archivedAt: null, status: 'provisioning' });
  },
}));

const { ingestSlackEvent, processSlackEvent } = await import('../services/slack/events.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { encryptString } = await import('../services/tokenCrypto.js');
const { resetSlackTokenStateForTests } = await import('../services/slack/tokens.js');
const { resetSlackNameCacheForTests } = await import('../services/slack/context.js');
const { resetSlackStatusForTests } = await import('../services/slack/statusReactions.js');
const { WorkbenchError } = await import('../services/workbenches/errors.js');
const { slackRoutes } = await import('../routes/slack.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');

const BOT_TOKEN = 'xoxb-very-secret';

describe('Slack triggers', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let slack: FakeSlack;
  /** Messages per thread, parent first, keyed by `channel:thread_ts`. */
  let threads: Record<string, Array<Record<string, unknown>>>;
  let eventSeq = 0;

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    resetFeatureFlagsForTests();
    resetSlackTokenStateForTests();
    resetSlackNameCacheForTests();
    resetSlackStatusForTests();
    notices.length = 0;
    created.length = 0;
    sent.length = 0;
    restored.length = 0;
    busy = false;
    createRefusal = null;

    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'u1' });
    await seedUser(testDb.db, { id: 'u2' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws1', ownerId: 'u1', name: 'One' },
      { id: 'ws2', ownerId: 'u2', name: 'Two' },
    ]);
    await testDb.db.insert(repositories).values([
      { id: 'r-web', workspaceId: 'ws1', name: 'web-app', url: 'https://github.com/acme/web-app' },
      { id: 'r-api', workspaceId: 'ws1', name: 'billing-api', url: 'https://github.com/acme/billing-api' },
      { id: 'r-two', workspaceId: 'ws2', name: 'other', url: 'https://github.com/acme/other' },
    ]);
    await testDb.db.insert(slackInstallations).values({
      teamId: 'T1', teamName: 'Acme', appId: 'A1', botUserId: 'UBOT', accessTokenEnc: encryptString(BOT_TOKEN), installedByUserId: 'u1',
    });
    await testDb.db.insert(slackUserLinks).values([
      { id: 'l1', teamId: 'T1', slackUserId: 'US1', userId: 'u1', workspaceId: 'ws1', triggerEmojis: ['robot_face', 'thumbsup'] },
      { id: 'l2', teamId: 'T1', slackUserId: 'US2', userId: 'u2', workspaceId: 'ws2', triggerEmojis: ['robot_face'] },
    ]);

    threads = {
      'C1:100.0': [
        { ts: '100.0', user: 'UALICE', text: 'the web-app login is broken since the deploy' },
        { ts: '101.0', user: 'UBOB', text: 'confirmed, <@UALICE> it loops' },
      ],
      'C1:300.0': [{ ts: '300.0', user: 'UALICE', text: 'something is slow' }],
    };
    slack = new FakeSlack();
    slack.handlers['conversations.replies'] = (form) => {
      const key = Object.keys(threads).find((k) => k.startsWith(`${form.channel}:`) && threads[k].some((m) => m.ts === form.ts));
      if (!key) return { ok: false, error: 'thread_not_found' };
      const [, threadTs] = key.split(':');
      return {
        ok: true,
        messages: threads[key].map((m) => (m.ts === threadTs ? m : { ...m, thread_ts: threadTs })),
        has_more: false,
      };
    };
    slack.handlers['users.info'] = (form) => ({ ok: true, user: { profile: { display_name: { US1: 'Tom', UALICE: 'Alice', UBOB: 'Bob' }[form.user] ?? '' } } });
    slack.handlers['conversations.info'] = () => ({ ok: true, channel: { name: 'eng' } });
    slack.handlers['chat.getPermalink'] = (form) => ({ ok: true, permalink: `https://acme.slack.com/archives/${form.channel}/p${form.message_ts}` });
    slack.install();
  });

  afterEach(async () => {
    slack.uninstall();
    resetSlackStatusForTests();
    await testDb.cleanup();
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
  });

  async function deliver(event: Record<string, unknown>, eventId = `Ev${++eventSeq}`) {
    await ingestSlackEvent({ type: 'event_callback', team_id: 'T1', event_id: eventId, event });
    return { eventId, outcome: await processSlackEvent(eventId) };
  }

  const reaction = (user: string, name: string, ts = '100.0', channel = 'C1') => ({
    type: 'reaction_added', user, reaction: name, item: { type: 'message', channel, ts }, item_user: 'UALICE',
  });
  const mention = (user: string, text: string, ts: string, threadTs?: string, extra: Record<string, unknown> = {}) => ({
    type: 'app_mention', user, text, ts, channel: 'C1', ...(threadTs ? { thread_ts: threadTs } : {}), ...extra,
  });
  const dm = (user: string, text: string, ts: string, threadTs?: string, extra: Record<string, unknown> = {}) => ({
    type: 'message', channel_type: 'im', channel: 'D1', user, text, ts, ...(threadTs ? { thread_ts: threadTs } : {}), ...extra,
  });

  async function threadRows() {
    return testDb.db.select().from(slackThreads);
  }

  describe('who and what triggers', () => {
    it.each([
      ['the trigger emoji', 'robot_face'],
      ['the trigger emoji with a skin tone', 'thumbsup::skin-tone-2'],
    ])('a linked user reacting with %s starts a session', async (_n, name) => {
      expect((await deliver(reaction('US1', name))).outcome).toBe('handled');
      expect(created).toHaveLength(1);
      const input = created[0];
      expect(input).toMatchObject({ workspaceId: 'ws1', repositoryId: 'r-web', runtime: 'sandbox', agent: 'claude', internetAccess: true, autoCreatePr: true });
      expect(input.source).toEqual({
        kind: 'slack', teamId: 'T1', teamName: 'Acme', channelId: 'C1', channelName: 'eng', messageTs: '100.0', threadTs: '100.0',
        permalink: 'https://acme.slack.com/archives/C1/p100.0',
      });
      expect(input.prompt).toContain('Tom asked you, from Slack');
      expect(input.prompt).toContain('Alice: the web-app login is broken');
      expect(input.prompt).toContain('Bob: confirmed, @Alice it loops');
      expect(input.prompt).not.toContain(BOT_TOKEN);
      expect(input.namingText).toBe('the web-app login is broken since the deploy');
      const [row] = await threadRows();
      expect(row).toMatchObject({ phase: 'started', workbenchId: 'wb-1', repoReason: 'name', userId: 'u1', statusReaction: 'eyes' });
      expect(slack.reactionLog()).toEqual(['add:eyes@100.0']);
    });

    it.each([
      ['a wrong emoji', reaction('US1', 'tada')],
      ['an unlinked user', reaction('UNOBODY', 'robot_face')],
      ['the bot itself', reaction('UBOT', 'robot_face')],
      ['a reaction on a file', { ...reaction('US1', 'robot_face'), item: { type: 'file', file: 'F1' } }],
    ])('%s reacting is ignored without a word', async (_n, event) => {
      expect((await deliver(event)).outcome).toBe('ignored');
      expect(created).toHaveLength(0);
      expect(slack.of('reactions.add')).toHaveLength(0);
    });

    it.each([
      ['a bot message', mention('US1', '<@UBOT> fix web-app', '400.0', undefined, { bot_id: 'B1' })],
      ['an edit', dm('US1', 'fix web-app', '400.0', undefined, { subtype: 'message_changed' })],
      ['an edited mention', mention('US1', '<@UBOT> fix web-app', '400.0', undefined, { edited: { ts: '401.0' } })],
      ['the bot mentioning itself', mention('UBOT', '<@UBOT> fix web-app', '400.0')],
      ['a channel message (not a DM)', { ...dm('US1', 'fix web-app', '400.0'), channel_type: 'channel' }],
    ])('%s is ignored', async (_n, event) => {
      expect((await deliver(event)).outcome).toBe('ignored');
      expect(created).toHaveLength(0);
      expect(slack.calls).toHaveLength(0);
    });

    it('an unlinked person mentioning the bot gets ❌ and nothing starts', async () => {
      expect((await deliver(mention('UNOBODY', '<@UBOT> fix web-app', '400.0'))).outcome).toBe('ignored');
      expect(slack.reactionLog()).toEqual(['add:x@400.0']);
      expect(created).toHaveLength(0);
    });

    it('a linked person outside the flag gets ❌ on a mention and silence on a reaction', async () => {
      vi.stubEnv('WORKBENCHES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      await deliver(mention('US1', '<@UBOT> fix web-app', '400.0'));
      await deliver(reaction('US1', 'robot_face'));
      expect(slack.reactionLog()).toEqual(['add:x@400.0']);
      expect(created).toHaveLength(0);
    });

    it('a mention: the text minus the mention is the instruction, the thread is context', async () => {
      await deliver(mention('US1', '<@UBOT> please fix the redirect in web-app', '101.0', '100.0'));
      expect(created[0].prompt.split('\n\n')[0]).toBe('please fix the redirect in web-app');
      expect(created[0].prompt).toContain('Alice: the web-app login is broken');
      expect(created[0].prompt).not.toContain('Bob: confirmed');
      expect(created[0].source).toMatchObject({ messageTs: '101.0', threadTs: '100.0' });
    });

    it('a bare mention uses the parent message as the request', async () => {
      threads['C1:100.0'].push({ ts: '102.0', user: 'US1', text: '<@UBOT>' });
      await deliver(mention('US1', '<@UBOT>', '102.0', '100.0'));
      expect(created[0].prompt).toContain('~~~~ slack-request\n[');
      expect(created[0].prompt).toContain('Alice: the web-app login is broken');
      expect(created[0].repositoryId).toBe('r-web');
    });

    it('a top-level DM starts a session; a reply in its thread is a follow-up', async () => {
      threads['D1:500.0'] = [{ ts: '500.0', user: 'US1', text: 'bump the web-app timeout' }];
      await deliver(dm('US1', 'bump the web-app timeout', '500.0'));
      expect(created).toHaveLength(1);
      expect(created[0].source).toMatchObject({ channelId: 'D1', channelName: null });
      await deliver(dm('US1', 'also log it', '501.0', '500.0'));
      expect(created).toHaveLength(1);
      expect(sent).toEqual([{ chatId: 'chat-wb-1', text: 'also log it' }]);
    });
  });

  describe('idempotency', () => {
    it('the same event twice acts once', async () => {
      const { eventId } = await deliver(reaction('US1', 'robot_face'), 'EvSame');
      expect(await processSlackEvent(eventId)).toBe('skipped');
      await ingestSlackEvent({ type: 'event_callback', team_id: 'T1', event_id: 'EvSame', event: reaction('US1', 'robot_face') });
      expect(created).toHaveLength(1);
    });

    it('a reaction removed and added again (a new event) does not start twice', async () => {
      await deliver(reaction('US1', 'robot_face'));
      expect((await deliver(reaction('US1', 'robot_face'))).outcome).toBe('ignored');
      expect((await deliver(reaction('US1', 'thumbsup'))).outcome).toBe('ignored');
      expect(created).toHaveLength(1);
      expect(sent).toHaveLength(0);
    });

    it('a retry of the same event after a transient failure goes through', async () => {
      let failures = 1;
      const original = slack.handlers['conversations.replies'];
      slack.handlers['conversations.replies'] = (form) => (failures-- > 0 ? { ok: false, error: 'internal_error' } : original(form));
      const { eventId, outcome } = await deliver(reaction('US1', 'robot_face'));
      expect(outcome).toBe('failed');
      expect(created).toHaveLength(0);
      expect(await processSlackEvent(eventId)).toBe('handled');
      expect(created).toHaveLength(1);
    });
  });

  describe('follow-ups in a known thread', () => {
    beforeEach(async () => {
      await deliver(reaction('US1', 'robot_face'));
      expect(created).toHaveLength(1);
    });

    it.each([
      ['idle', false],
      ['busy (queued)', true],
    ])('a mention while %s becomes a new turn in the same session', async (_n, isBusy) => {
      busy = isBusy;
      threads['C1:100.0'].push({ ts: '103.0', user: 'US1', text: '<@UBOT> and add a test' });
      expect((await deliver(mention('US1', '<@UBOT> and add a test', '103.0', '100.0'))).outcome).toBe('handled');
      expect(created).toHaveLength(1);
      expect(sent).toEqual([{ chatId: 'chat-wb-1', text: 'and add a test' }]);
      const [row] = await threadRows();
      // The status moved to the new message: ours came off the old one.
      expect(row.triggerMessageTs).toBe('103.0');
      expect(slack.reactionLog()).toContain('remove:eyes@100.0');
    });

    it('an archived session is restored first', async () => {
      await testDb.db.update(workbenches).set({ archivedAt: new Date(), status: 'ready' }).where(eq(workbenches.id, 'wb-1'));
      await deliver(mention('US1', '<@UBOT> one more thing', '104.0', '100.0'));
      expect(restored).toEqual(['wb-1']);
      expect(sent).toEqual([{ chatId: 'chat-wb-1', text: 'one more thing' }]);
    });

    it('a reaction on another message in the thread sends that message, quoted', async () => {
      await deliver(reaction('US1', 'robot_face', '101.0'));
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain('UNTRUSTED');
      expect(sent[0].text).toContain('Bob: confirmed, @Alice it loops');
    });

    it("someone else's trigger in the thread gets ❌ and never reaches the session", async () => {
      await deliver(mention('US2', '<@UBOT> delete everything', '105.0', '100.0'));
      expect(sent).toHaveLength(0);
      expect(created).toHaveLength(1);
      expect(slack.reactionLog()).toContain('add:x@105.0');
    });
  });

  describe('when the repository is unclear', () => {
    it('asks instead of guessing: ❓, a notice, and a pending request', async () => {
      await deliver(reaction('US1', 'robot_face', '300.0'));
      expect(created).toHaveLength(0);
      const [row] = await threadRows();
      expect(row).toMatchObject({ phase: 'needs_repository', workbenchId: null, statusReaction: 'question' });
      expect(row.pendingPrompt).toContain('something is slow');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ userId: 'u1', notice: { kind: 'pick_repository', workspaceId: 'ws1' } });
      expect(notices[0].notice.message).toBe('Pick a repository for: something is slow');
      expect(notices[0].notice.pending?.candidates.map((c) => c.repositoryId).sort()).toEqual(['r-api', 'r-web']);
    });

    it('a later trigger that names the repository takes the waiting thread over', async () => {
      await deliver(reaction('US1', 'robot_face', '300.0'));
      threads['C1:300.0'].push({ ts: '301.0', user: 'US1', text: '<@UBOT> it is billing-api' });
      expect((await deliver(mention('US1', '<@UBOT> it is billing-api', '301.0', '300.0'))).outcome).toBe('handled');
      expect(created).toHaveLength(1);
      expect(created[0].repositoryId).toBe('r-api');
      const [row] = await threadRows();
      expect(row).toMatchObject({ phase: 'started', triggerMessageTs: '301.0', pendingPrompt: null });
      // Our ❓ came off the first message before 👀 went on the new one.
      expect(slack.reactionLog()).toEqual(['add:eyes@300.0', 'remove:eyes@300.0', 'add:question@300.0', 'remove:question@300.0', 'add:eyes@301.0']);
    });

    it('a refused start says why: ❌ and a start_failed notice', async () => {
      createRefusal = new WorkbenchError('No Claude subscription is connected.', 409, 'agent_not_connected');
      expect((await deliver(reaction('US1', 'robot_face'))).outcome).toBe('handled');
      const [row] = await threadRows();
      expect(row).toMatchObject({ phase: 'failed', statusReaction: 'x' });
      expect(notices[0].notice).toMatchObject({ kind: 'start_failed' });
      expect(notices[0].notice.message).toContain('No Claude subscription is connected.');
    });
  });

  describe('POST /slack/pending/:id/start', () => {
    let server: Server;
    let base: string;

    beforeEach(async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const id = req.headers['x-user'] as string;
        req.user = { id, email: `${id}@example.test`, isAdmin: false };
        next();
      });
      app.use('/slack', wrapAsyncRoutes(slackRoutes()));
      app.use(apiErrorHandler);
      server = createServer(app);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await deliver(reaction('US1', 'robot_face', '300.0'));
    });

    afterEach(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });

    async function call(method: string, path: string, user: string, body?: unknown) {
      // Not a Slack URL, so the fake passes it to the real fetch.
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { 'x-user': user, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: (await r.json()) as { success: boolean; data?: unknown; error?: string } };
    }

    it('lists only the caller’s pending requests', async () => {
      const mine = await call('GET', '/slack/pending', 'u1');
      expect((mine.body.data as unknown[]).length).toBe(1);
      expect((await call('GET', '/slack/pending', 'u2')).body.data).toEqual([]);
    });

    it("refuses someone else's request with 404", async () => {
      const [row] = await threadRows();
      expect((await call('POST', `/slack/pending/${row.id}/start`, 'u2', { repositoryId: 'r-two' })).status).toBe(404);
      expect(created).toHaveLength(0);
    });

    it('refuses a missing repositoryId with 400', async () => {
      const [row] = await threadRows();
      expect((await call('POST', `/slack/pending/${row.id}/start`, 'u1', {})).status).toBe(400);
    });

    it('starts the session with the stored prompt and remembers the pick as a correction', async () => {
      const [row] = await threadRows();
      const res = await call('POST', `/slack/pending/${row.id}/start`, 'u1', { repositoryId: 'r-api' });
      expect(res.status).toBe(200);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ workspaceId: 'ws1', repositoryId: 'r-api', namingText: 'something is slow' });
      expect(created[0].prompt).toContain('something is slow');
      expect(created[0].source).toMatchObject({ kind: 'slack', messageTs: '300.0' });
      const [after] = await threadRows();
      expect(after).toMatchObject({ phase: 'started', workbenchId: 'wb-1', repoReason: 'picked' });
      const memory = await testDb.db.select().from(slackRepoMemory);
      expect(memory).toEqual([expect.objectContaining({ channelId: 'C1', repositoryId: 'r-api', uses: 1, corrections: 1, corrected: true })]);
      // Started once: a second press finds nothing waiting.
      expect((await call('POST', `/slack/pending/${row.id}/start`, 'u1', { repositoryId: 'r-api' })).status).toBe(404);
    });

    it('a refused start puts the request back so the user can pick again', async () => {
      const [row] = await threadRows();
      createRefusal = new WorkbenchError('That repository is not connected to this workspace.', 400, '');
      const res = await call('POST', `/slack/pending/${row.id}/start`, 'u1', { repositoryId: 'r-two' });
      expect(res.status).toBe(400);
      expect((await threadRows())[0].phase).toBe('needs_repository');
    });
  });
});
