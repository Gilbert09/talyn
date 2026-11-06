import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { fleetAccounts, users, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import { claimOrEnqueue, getChat } from '../services/workbenches/store.js';
import { handleChatLimit, limitResumeMessage } from '../services/workbenches/limitResume.js';
import { heldBackAgents } from '../services/selfHosted/exhaustedQuota.js';
import { sendMessage } from '../services/workbenches/turns.js';
import { existingBoxRefusal } from '../services/workbenches/boxGate.js';

/**
 * A teammate's turn that hits the teammate's limit (Teams and Spaces): the
 * hold lands on the teammate's workspace, the agent choice reads their
 * accounts, the box gate asks their budget, and the resumed turn runs as them.
 */

vi.mock('../services/githubIdentity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/githubIdentity.js')>()),
  ensureGithubUserId: async () => null,
}));
vi.mock('../services/workbenches/turns.js', () => ({
  sendMessage: vi.fn(async (id, input, options) => {
    await claimOrEnqueue(id, {
      id: 'resume', text: input.text, origin: options.origin, queuedAt: new Date().toISOString(),
      ...(options.payer ? { payer: options.payer } : {}),
    }, true, options.resumeVersion);
    return { queued: false };
  }),
  startQueuedIfIdle: vi.fn(async () => false),
  cancelTurn: vi.fn(), endCapacityWait: vi.fn(),
}));
vi.mock('../services/workbenches/boxGate.js', () => ({ existingBoxRefusal: vi.fn(async () => null) }));
vi.mock('../services/selfHosted/quotaProbe.js', () => ({ verifyAgentQuota: vi.fn(async () => 'unknown') }));
vi.mock('../services/workbenches/emit.js', () => ({ emitWorkbenchChat: vi.fn(), emitWorkbenchEvents: vi.fn() }));

const reason = "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.";
let testDb: Awaited<ReturnType<typeof createTestDb>>;

async function account(id: string, workspaceId: string, agent: 'claude' | 'codex') {
  await testDb.db.insert(fleetAccounts).values({
    id, workspaceId, agent, kind: agent === 'claude' ? 'anthropic_key' : 'openai_key',
    label: id, priority: 1, credential: { keyEnc: 'unused' },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(existingBoxRefusal).mockResolvedValue(null);
  testDb = await createTestDb();
  await testDb.db.insert(users).values([
    { id: 'owner', email: 'o@x.test', githubUserId: 100, githubUsername: 'ana' },
    { id: 'ben', email: 'b@x.test', githubUserId: 200, githubUsername: 'ben' },
  ]);
  await testDb.db.insert(workspaces).values([
    { id: 'ws', name: 'Owner', ownerId: 'owner' },
    { id: 'ws-ben', name: 'Ben', ownerId: 'ben' },
  ]);
  await testDb.db.insert(workbenches).values({
    id: 'wb', workspaceId: 'ws', repoFullName: '', branch: '', baseBranch: '', kind: 'thread', name: 'Session',
    runtime: 'sandbox', agent: 'claude', status: 'ready', sandboxId: 'box',
    settings: { sandboxAgents: { box: ['claude', 'codex'] }, payerFleetAccounts: { ben: { claude: 'ben-claude' } } },
  });
  await testDb.db.insert(workbenchChats).values({
    id: 'chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Chat', agent: 'claude',
    status: 'error', statusMessage: reason, turnCount: 1, payerUserId: 'ben', payerWorkspaceId: 'ws-ben',
  });
  await account('owner-claude', 'ws', 'claude');
  await account('owner-codex', 'ws', 'codex');
  await account('ben-claude', 'ws-ben', 'claude');
});
afterEach(async () => { await testDb.cleanup(); });

it("resumes a teammate's turn as the teammate, with the hold on the teammate's account", async () => {
  await account('ben-codex', 'ws-ben', 'codex');
  await handleChatLimit((await getChat('chat'))!, reason);
  const payer = { userId: 'ben', workspaceId: 'ws-ben', githubLogin: 'ben', avatarUrl: expect.stringContaining('200') };
  expect(sendMessage).toHaveBeenCalledWith('chat', { text: limitResumeMessage(reason) }, {
    origin: 'talyn', resumeVersion: 0, payer,
  });
  expect(existingBoxRefusal).toHaveBeenCalledWith(expect.objectContaining({ id: 'wb' }), true, { userId: 'ben', workspaceId: 'ws-ben' });
  expect(await getChat('chat')).toMatchObject({ agent: 'codex', status: 'running', payerUserId: 'ben', payerWorkspaceId: 'ws-ben' });
  expect((await heldBackAgents('ws-ben')).claude?.kind).toBe('rate_limit');
  expect((await heldBackAgents('ws')).claude).toBeUndefined();
});

it("waits for the teammate's own usage when only the owner has the other agent", async () => {
  await handleChatLimit((await getChat('chat'))!, reason);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(await getChat('chat')).toMatchObject({ agent: 'claude', status: 'error' });
  expect((await getChat('chat'))!.resumeAt).toBeInstanceOf(Date);
  expect((await heldBackAgents('ws')).claude).toBeUndefined();
});
