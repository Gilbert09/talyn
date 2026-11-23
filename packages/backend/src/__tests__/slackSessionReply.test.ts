import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { FakeSlack } from './helpers/fakeSlack.js';
import { invokeRoute } from './helpers/invokeRoute.js';
import { slackInstallations, slackThreads, workbenches, workspaces } from '../db/schema.js';
import { workbenchBackgroundRoutes } from '../routes/workbenchBackground.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { resetSlackTokenStateForTests } from '../services/slack/tokens.js';
import { encryptString } from '../services/tokenCrypto.js';

type ReplyBody = {
  success: boolean;
  data?: { channelId: string; threadTs: string; ts: string };
  error?: string;
  code?: string;
  retryAfterSeconds?: number;
};

describe('session Slack reply', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let slack: FakeSlack;

  async function thread(id = 'thread-1', channelId = 'C1', threadTs = '100.0', createdAt = new Date('2026-10-01')) {
    await testDb.db.insert(slackThreads).values({
      id, teamId: 'T1', channelId, threadTs, userId: 'owner', workspaceId: 'ws',
      workbenchId: 'wb', phase: 'started', triggerMessageTs: threadTs, createdAt,
    });
  }

  async function reply(text: unknown, user = 'owner') {
    const req = { params: { id: 'wb' }, body: { text }, user: { id: user } } as unknown as Request;
    return invokeRoute<ReplyBody>(workbenchBackgroundRoutes(), 'POST', '/:id/slack-reply', req);
  }

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    resetFeatureFlagsForTests();
    resetSlackTokenStateForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner', email: 'owner@example.test' });
    await seedUser(testDb.db, { id: 'other', email: 'other@example.test' });
    await testDb.db.insert(workspaces).values({ id: 'ws', name: 'Workspace', ownerId: 'owner' });
    await testDb.db.insert(workbenches).values({
      id: 'wb', workspaceId: 'ws', repoFullName: 'acme/web', branch: 'main',
      baseBranch: 'main', name: 'Session', runtime: 'sandbox', agent: 'claude', status: 'ready',
    });
    await testDb.db.insert(slackInstallations).values({
      teamId: 'T1', appId: 'A1', botUserId: 'UBOT', scope: 'chat:write',
      accessTokenEnc: encryptString('xoxb-bot'), installedByUserId: 'owner',
    });
    slack = new FakeSlack().install();
    slack.handlers['chat.postMessage'] = () => ({ ok: true, ts: '200.123' });
  });

  afterEach(async () => {
    slack.uninstall();
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
    resetSlackTokenStateForTests();
    await testDb.cleanup();
  });

  it('posts with the bot token in the newest thread', async () => {
    await thread();
    await thread('thread-2', 'C2', '101.0', new Date('2026-10-02'));
    const { status, body } = await reply('Hello from Talyn');
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, data: { channelId: 'C2', threadTs: '101.0', ts: '200.123' } });
    expect(slack.of('chat.postMessage')).toEqual([{
      method: 'chat.postMessage', token: 'xoxb-bot',
      form: { channel: 'C2', thread_ts: '101.0', text: 'Hello from Talyn' },
    }]);
  });

  it('accepts exactly 40,000 characters', async () => {
    await thread();
    const { status } = await reply('x'.repeat(40_000));
    expect(status).toBe(200);
    expect(slack.of('chat.postMessage')).toHaveLength(1);
  });

  it('refuses a session with no Slack thread', async () => {
    const { status, body } = await reply('Hello');
    expect(status).toBe(409);
    expect(body.code).toBe('not_slack_session');
    expect(body.error).toBe('This session did not start from Slack.');
    expect(slack.calls).toHaveLength(0);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '  \n  '],
    ['missing', undefined],
    ['over 40,000 characters', 'x'.repeat(40_001)],
  ])('refuses %s text', async (_name, text) => {
    await thread();
    const { status, body } = await reply(text);
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_text');
    expect(slack.calls).toHaveLength(0);
  });

  it('asks for reinstall when chat:write is absent', async () => {
    await thread();
    await testDb.db.update(slackInstallations).set({ scope: 'channels:read' }).where(eq(slackInstallations.teamId, 'T1'));
    const { status, body } = await reply('Hello');
    expect(status).toBe(409);
    expect(body.code).toBe('slack_scope_missing');
    expect(body.error).toContain('Install the Slack app again');
    expect(slack.calls).toHaveLength(0);
  });

  it('maps Slack missing_scope to a reinstall error', async () => {
    await thread();
    slack.handlers['chat.postMessage'] = () => ({ ok: false, error: 'missing_scope', needed: 'chat:write' });
    const { status, body } = await reply('Hello');
    expect(status).toBe(409);
    expect(body.code).toBe('slack_scope_missing');
    expect(body.error).toContain('Install the Slack app again');
  });

  it('reports Slack rate limits with retry seconds', async () => {
    await thread();
    slack.handlers['chat.postMessage'] = () => Response.json({ ok: false }, {
      status: 429, headers: { 'retry-after': '7' },
    });
    const { status, body } = await reply('Hello');
    expect(status).toBe(429);
    expect(body.code).toBe('slack_rate_limited');
    expect(body.retryAfterSeconds).toBe(7);
    expect(body.error).toContain('7 seconds');
  });

  it('hides another owner’s session', async () => {
    await thread();
    const { status } = await reply('Hello', 'other');
    expect(status).toBe(404);
    expect(slack.calls).toHaveLength(0);
  });
});
