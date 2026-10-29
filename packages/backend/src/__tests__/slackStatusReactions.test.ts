import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Workbench } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { FakeSlack } from './helpers/fakeSlack.js';
import { repositories, slackInstallations, slackThreads, workbenches, workspaces } from '../db/schema.js';
import { encryptString } from '../services/tokenCrypto.js';
import {
  moveStatusToMessage,
  registerSlackStatusReactions,
  resetSlackStatusForTests,
  scheduleSlackStatus,
  setThreadStatus,
  stateForWorkbench,
} from '../services/slack/statusReactions.js';
import { getThreadById } from '../services/slack/threads.js';
import { callSlackAsBot, resetSlackTokenStateForTests } from '../services/slack/tokens.js';
import { slackStatusFor } from '../services/slack/store.js';
import { emitWorkbenchChat } from '../services/workbenches/emit.js';
import { SlackApiError } from '../services/slack/api.js';

/**
 * The one status reaction on a Slack-started session's trigger message: the
 * state machine, remove-then-add, never touching a reaction Talyn did not set,
 * the debounce, and a dead token marking the installation for reinstall.
 */

type WbState = Parameters<typeof stateForWorkbench>[0];
const chat = (status: string, queued = 0) => ({ status, queuedMessages: Array.from({ length: queued }, () => ({})) }) as never;

describe('stateForWorkbench', () => {
  const base: WbState = { status: 'ready', sandboxState: 'running', archivedAt: null, pr: null, chats: [chat('idle')] };
  const pr = (state: 'open' | 'merged' | 'closed') => ({ number: 1, url: 'u', state, mergeable: 'unknown', ciStatus: 'none' }) as Workbench['pr'];
  it.each([
    ['provisioning', { status: 'provisioning', sandboxState: 'creating', chats: [chat('idle', 1)] }, 'starting'],
    ['moving', { status: 'moving' }, 'starting'],
    ['ready with the first message queued', { chats: [chat('idle', 1)] }, 'starting'],
    ['a running turn', { chats: [chat('running')] }, 'working'],
    ['a running turn beats an open PR', { chats: [chat('running')], pr: pr('open') }, 'working'],
    ['waiting for an answer', { chats: [chat('awaiting_input')] }, 'needs_input'],
    ['turn done', {}, 'done'],
    ['a PR open', { pr: pr('open') }, 'pr_open'],
    ['a PR merged', { pr: pr('merged') }, 'merged'],
    ['merged and archived', { pr: pr('merged'), archivedAt: '2026-01-01' }, 'merged'],
    ['a PR closed', { pr: pr('closed') }, 'done'],
    ['failed to start', { status: 'error' }, 'failed'],
    ['sandbox error', { sandboxState: 'error' }, 'failed'],
    ['a chat failed', { chats: [chat('error')] }, 'failed'],
  ] as Array<[string, Partial<WbState>, string]>)('%s', (_n, patch, expected) => {
    expect(stateForWorkbench({ ...base, ...patch })).toBe(expected);
  });
});

describe('status reactions', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let slack: FakeSlack;
  const prior = process.env.TALYN_TOKEN_KEY;

  beforeEach(async () => {
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    resetSlackTokenStateForTests();
    resetSlackStatusForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'u1' });
    await testDb.db.insert(workspaces).values({ id: 'ws1', ownerId: 'u1', name: 'W' });
    await testDb.db.insert(repositories).values({ id: 'r1', workspaceId: 'ws1', name: 'app', url: 'https://github.com/acme/app' });
    await testDb.db.insert(slackInstallations).values({ teamId: 'T1', appId: 'A1', botUserId: 'UBOT', accessTokenEnc: encryptString('xoxb-secret') });
    slack = new FakeSlack().install();
  });

  afterEach(async () => {
    slack.uninstall();
    resetSlackStatusForTests();
    await testDb.cleanup();
    if (prior === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = prior;
  });

  async function seedThread(extra: Partial<typeof slackThreads.$inferInsert> = {}) {
    await testDb.db.insert(slackThreads).values({
      id: 'th1',
      teamId: 'T1',
      channelId: 'C1',
      threadTs: '100.1',
      userId: 'u1',
      workspaceId: 'ws1',
      phase: 'started',
      triggerMessageTs: '100.1',
      ...extra,
    });
    return (await getThreadById('th1'))!;
  }

  async function seedWorkbench(extra: Partial<typeof workbenches.$inferInsert> = {}) {
    await testDb.db.insert(workbenches).values({
      id: 'wb1',
      workspaceId: 'ws1',
      repositoryId: 'r1',
      repoFullName: 'acme/app',
      name: 'n',
      branch: 'b',
      baseBranch: 'main',
      runtime: 'sandbox',
      agent: 'claude',
      status: 'ready',
      source: { kind: 'slack', teamId: 'T1', teamName: null, channelId: 'C1', channelName: null, messageTs: '100.1', threadTs: '100.1', permalink: null },
      ...extra,
    });
  }

  it('removes the reaction it set, then adds the new one, as the bot', async () => {
    const thread = await seedThread({ statusReaction: 'eyes', lastState: 'starting' });
    expect(await setThreadStatus(thread, 'working')).toBe(true);
    expect(slack.reactionLog()).toEqual(['remove:eyes@100.1', 'add:hourglass_flowing_sand@100.1']);
    expect(slack.calls.every((c) => c.token === 'xoxb-secret')).toBe(true);
    expect(await getThreadById('th1')).toMatchObject({ statusReaction: 'hourglass_flowing_sand', lastState: 'working' });
  });

  it('with nothing set, only adds: the user’s own trigger emoji is never removed', async () => {
    const thread = await seedThread();
    await setThreadStatus(thread, 'starting');
    expect(slack.reactionLog()).toEqual(['add:eyes@100.1']);
    expect(slack.of('reactions.remove')).toHaveLength(0);
  });

  it('does nothing when the state is already shown', async () => {
    const thread = await seedThread({ statusReaction: 'white_check_mark', lastState: 'done' });
    expect(await setThreadStatus(thread, 'done')).toBe(false);
    expect(slack.calls).toHaveLength(0);
  });

  it.each([
    ['already_reacted on add', 'reactions.add', 'already_reacted'],
    ['no_reaction on remove', 'reactions.remove', 'no_reaction'],
    ['message_not_found on remove', 'reactions.remove', 'message_not_found'],
  ])('treats %s as success', async (_n, method, error) => {
    slack.handlers[method] = () => ({ ok: false, error });
    const thread = await seedThread({ statusReaction: 'eyes' });
    expect(await setThreadStatus(thread, 'done')).toBe(true);
    expect((await getThreadById('th1'))?.statusReaction).toBe('white_check_mark');
  });

  it('never throws on a Slack failure', async () => {
    slack.handlers['reactions.add'] = () => ({ ok: false, error: 'ratelimited' });
    const thread = await seedThread();
    await expect(setThreadStatus(thread, 'failed')).resolves.toBe(false);
  });

  it('a stale row loses the swap and removes what is really there, not what it thought', async () => {
    const stale = await seedThread({ statusReaction: 'eyes' });
    await testDb.db.update(slackThreads).set({ statusReaction: 'hourglass_flowing_sand' }).where(eq(slackThreads.id, 'th1'));
    await setThreadStatus(stale, 'done');
    expect(slack.reactionLog()).toEqual(['remove:hourglass_flowing_sand@100.1', 'add:white_check_mark@100.1']);
  });

  it('two concurrent swaps leave exactly one of our reactions, the one the row records', async () => {
    const row = await seedThread({ statusReaction: 'eyes' });
    await Promise.all([setThreadStatus(row, 'working'), setThreadStatus(row, 'done')]);
    const onMessage = new Set(['eyes']);
    for (const entry of slack.reactionLog()) {
      const [op, rest] = entry.split(':');
      const name = rest.slice(0, rest.indexOf('@'));
      if (op === 'add') onMessage.add(name);
      else onMessage.delete(name);
    }
    expect([...onMessage]).toEqual([(await getThreadById('th1'))!.statusReaction]);
  });

  it('a follow-up moves the status to the new message, removing ours from the old one', async () => {
    const thread = await seedThread({ statusReaction: 'white_check_mark', lastState: 'done' });
    const moved = await moveStatusToMessage(thread, '200.2');
    expect(moved).toMatchObject({ triggerMessageTs: '200.2', statusReaction: null });
    await setThreadStatus(moved, 'working');
    expect(slack.reactionLog()).toEqual(['remove:white_check_mark@100.1', 'add:hourglass_flowing_sand@200.2']);
  });

  it('debounces rapid flips into one update with the latest state', async () => {
    await seedWorkbench();
    await seedThread({ workbenchId: 'wb1' });
    scheduleSlackStatus('wb1', 40);
    scheduleSlackStatus('wb1', 40);
    scheduleSlackStatus('wb1', 40);
    await vi.waitFor(() => expect(slack.of('reactions.add')).toHaveLength(1), { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 120));
    expect(slack.reactionLog()).toEqual(['add:white_check_mark@100.1']);
  });

  it('follows chat emits for a Slack session, and ignores other sessions', async () => {
    registerSlackStatusReactions();
    await seedWorkbench();
    await seedThread({ workbenchId: 'wb1' });
    await testDb.db.insert(workbenches).values({
      id: 'wb2', workspaceId: 'ws1', repositoryId: 'r1', repoFullName: 'acme/app', name: 'm', branch: 'c', baseBranch: 'main',
      runtime: 'sandbox', agent: 'claude', status: 'ready',
    });
    const asChat = (workbenchId: string) => ({ id: 'c', workbenchId, status: 'running' }) as never;
    emitWorkbenchChat('ws1', asChat('wb2'));
    emitWorkbenchChat('ws1', asChat('wb1'));
    // The debounce is 2 s in production; wait for it.
    await vi.waitFor(() => expect(slack.of('reactions.add')).toHaveLength(1), { timeout: 4000 });
    expect(slack.reactionLog()).toEqual(['add:white_check_mark@100.1']);
  });
});

describe('a dead bot token', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let slack: FakeSlack;
  const prior = process.env.TALYN_TOKEN_KEY;

  beforeEach(async () => {
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    resetSlackTokenStateForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'u1' });
    await testDb.db.insert(slackInstallations).values({
      teamId: 'T1', appId: 'A1', botUserId: 'UBOT', accessTokenEnc: encryptString('xoxb-1'), installedByUserId: 'u1',
    });
    slack = new FakeSlack().install();
  });

  afterEach(async () => {
    slack.uninstall();
    await testDb.cleanup();
    if (prior === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = prior;
  });

  it.each(['token_revoked', 'invalid_auth', 'account_inactive'])('%s marks the installation needsReinstall', async (error) => {
    slack.handlers['reactions.add'] = () => ({ ok: false, error });
    await expect(callSlackAsBot('T1', 'reactions.add', { name: 'eyes' })).rejects.toBeInstanceOf(SlackApiError);
    const [row] = await testDb.db.select().from(slackInstallations).where(eq(slackInstallations.teamId, 'T1'));
    expect(row).toMatchObject({ tokenError: error, accessTokenEnc: null });
    expect((await slackStatusFor('u1')).installations[0].needsReinstall).toBe(true);
    // Nothing more is sent with a dead token.
    await expect(callSlackAsBot('T1', 'reactions.add', { name: 'eyes' })).rejects.toMatchObject({ code: 'no_bot_token' });
    expect(slack.calls).toHaveLength(1);
  });

  it.each(['ratelimited', 'channel_not_found', 'not_authed'])('%s leaves the installation alone', async (error) => {
    slack.handlers['reactions.add'] = () => ({ ok: false, error });
    await expect(callSlackAsBot('T1', 'reactions.add', {})).rejects.toBeInstanceOf(SlackApiError);
    const [row] = await testDb.db.select().from(slackInstallations).where(eq(slackInstallations.teamId, 'T1'));
    expect(row.tokenError).toBeNull();
  });
});
