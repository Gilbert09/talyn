import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { workbenchRoutes } from '../routes/workbenches.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { workspaceRoutes } from '../routes/workspaces.js';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { fleetAccounts, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import { claimOrEnqueue, getChat, getWorkbench, updateChat } from '../services/workbenches/store.js';
import { cancelLimitResume, handleChatLimit, limitResumeMessage, limitRetryDelay } from '../services/workbenches/limitResume.js';
import { backfillChatLimits, sweepChatLimits } from '../services/workbenches/limitResumeSweep.js';
import { heldBackAgents, rateLimitedAgentFrom } from '../services/selfHosted/exhaustedQuota.js';
import { switchChatAgent } from '../services/workbenches/sessionOps.js';
import { sendMessage } from '../services/workbenches/turns.js';
import { existingBoxRefusal } from '../services/workbenches/boxGate.js';
import { UsageExhaustedError } from '../services/billing/entitlements.js';

vi.mock('../services/workbenches/turns.js', () => ({
  sendMessage: vi.fn(async (id, input, options) => {
    await claimOrEnqueue(id, { id: 'resume', text: input.text, origin: options.origin, queuedAt: new Date().toISOString() }, true, options.resumeVersion);
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
const chat = async () => (await getChat('chat'))!;
async function account(agent: 'claude' | 'codex') {
  await testDb.db.insert(fleetAccounts).values({
    id: agent, workspaceId: 'ws', agent, kind: agent === 'claude' ? 'anthropic_key' : 'openai_key',
    label: agent, priority: 1, credential: { keyEnc: 'unused' },
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(existingBoxRefusal).mockResolvedValue(null);
  testDb = await createTestDb();
  await seedUser(testDb.db, { id: 'owner' });
  await testDb.db.insert(workspaces).values({ id: 'ws', name: 'Workspace', ownerId: 'owner' });
  await testDb.db.insert(workbenches).values({
    id: 'wb', workspaceId: 'ws', repoFullName: '', branch: '', baseBranch: '', kind: 'thread', name: 'Session', runtime: 'sandbox', agent: 'claude',
    status: 'ready', sandboxId: 'box', settings: { sandboxAgents: { box: ['claude', 'codex'] } },
  });
  await testDb.db.insert(workbenchChats).values({
    id: 'chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Chat', agent: 'claude',
    status: 'error', statusMessage: reason, turnCount: 1,
  });
  await account('claude');
});
afterEach(async () => { vi.unstubAllEnvs(); resetFeatureFlagsForTests(); await testDb.cleanup(); });
it('classifies the reported 429 as a Claude rate limit', () => {
  expect(rateLimitedAgentFrom(reason)).toBe('claude');
});
it('moves the chat to Codex and sends the resume message', async () => {
  await account('codex');
  await handleChatLimit(await chat(), reason);
  expect(await chat()).toMatchObject({ agent: 'codex', status: 'running', resumeAt: null, agentSessionId: null });
  expect(sendMessage).toHaveBeenCalledWith('chat', { text: limitResumeMessage(reason) }, { origin: 'talyn', resumeVersion: 0 });
  const rows = await testDb.pglite.query<{ event: { text: string } }>('select event from workbench_events');
  expect(rows.rows.some((row) => row.event.text === 'Claude reached its usage limit. Continuing with Codex.')).toBe(true);
  const saved = await testDb.pglite.query<{ recap_pending: boolean }>("select recap_pending from workbench_chats where id = 'chat'");
  expect(saved.rows[0].recap_pending).toBe(true);
  expect((await heldBackAgents('ws')).claude?.kind).toBe('rate_limit');
});
it.each(['disconnected', 'reauth', 'old box', 'held'] as const)('waits when Codex is %s', async (condition) => {
  if (condition !== 'disconnected') await account('codex');
  if (condition === 'reauth') await testDb.db.update(fleetAccounts).set({ reauthRequiredAt: new Date() }).where(eq(fleetAccounts.id, 'codex'));
  if (condition === 'old box') await testDb.db.update(workbenches).set({ settings: {} }).where(eq(workbenches.id, 'wb'));
  if (condition === 'held') await testDb.db.update(fleetAccounts).set({ quotaExhausted: { at: new Date().toISOString(), kind: 'rate_limit' } }).where(eq(fleetAccounts.id, 'codex'));
  const start = Date.now();
  await handleChatLimit(await chat(), reason);
  expect((await chat()).resumeAt!.getTime()).toBeGreaterThanOrEqual(start + 5 * 60_000);
  expect(sendMessage).not.toHaveBeenCalled();
  expect((await heldBackAgents('ws')).claude?.resetsAt).toBeUndefined();
});
it('uses the vendor reset instant', async () => {
  const at = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  await handleChatLimit(await chat(), `${reason} resetsAt: "${at}"`);
  expect((await chat()).resumeAt?.toISOString()).toBe(at);
});
it.each([[1, 5], [2, 15], [3, 30], [4, 60], [9, 60]])('backs off after limit %i', (count, minutes) => {
  expect(limitRetryDelay(count)).toBe(minutes * 60_000);
});
it('keeps the count across automatic messages', async () => {
  await handleChatLimit(await chat(), reason);
  await claimOrEnqueue('chat', { id: 'auto', text: 'Continue', origin: 'talyn', queuedAt: new Date().toISOString() }, true, 0);
  await updateChat('chat', { status: 'error', statusMessage: reason });
  const start = Date.now();
  await handleChatLimit(await chat(), reason);
  expect(await chat()).toMatchObject({ limitCount: 2 });
  expect((await chat()).resumeAt!.getTime()).toBeGreaterThanOrEqual(start + 15 * 60_000);
});
it('reprobes exhaustion after five hours without storing a reset', async () => {
  const start = Date.now();
  await handleChatLimit(await chat(), 'You are out of extra usage.');
  expect((await chat()).resumeAt!.getTime()).toBeGreaterThanOrEqual(start + 5 * 60 * 60_000);
  expect((await heldBackAgents('ws')).claude?.resetsAt).toBeUndefined();
});
it('resumes once when two sweeps run together', async () => {
  await handleChatLimit(await chat(), reason);
  await testDb.db.update(fleetAccounts).set({ quotaExhausted: null }).where(eq(fleetAccounts.id, 'claude'));
  await updateChat('chat', { resumeAt: new Date(Date.now() - 1000) });
  await Promise.all([sweepChatLimits(), sweepChatLimits()]);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(await chat()).toMatchObject({ status: 'running', resumeAt: null });
});
it.each(['message', 'cancel', 'switch'] as const)('clears the wait after a user %s', async (action) => {
  await handleChatLimit(await chat(), reason);
  if (action === 'message') await claimOrEnqueue('chat', { id: 'user', text: 'New work', queuedAt: new Date().toISOString() }, true);
  if (action === 'cancel') await cancelLimitResume('chat');
  if (action === 'switch') await switchChatAgent(await chat(), (await getWorkbench('wb'))!, 'codex', null);
  expect((await chat()).resumeAt).toBeNull();
  await backfillChatLimits();
  expect((await chat()).resumeAt).toBeNull();
});
it('rejects an automatic send after a person cancels', async () => {
  await handleChatLimit(await chat(), reason);
  const stale = await chat();
  await cancelLimitResume('chat');
  await claimOrEnqueue('chat', { id: 'auto', text: 'Continue', origin: 'talyn', queuedAt: new Date().toISOString() }, true, stale.resumeVersion);
  expect((await chat()).status).toBe('error');
  expect((await chat()).queuedMessages).toHaveLength(0);
});
it('backfills only recent limit errors', async () => {
  for (const [id, status, text, hours] of [
    ['old', 'error', reason, 49], ['other', 'error', 'Network error', 1], ['idle', 'idle', reason, 1],
  ] as const) await testDb.db.insert(workbenchChats).values({
    id, workbenchId: 'wb', workspaceId: 'ws', title: id, agent: 'claude', status, statusMessage: text,
    updatedAt: new Date(Date.now() - hours * 60 * 60_000),
  });
  expect(await backfillChatLimits()).toBe(1);
  expect(await backfillChatLimits()).toBe(0);
  expect((await chat()).resumeAt).not.toBeNull();
});
it('leaves old behaviour when the setting is off', async () => {
  await testDb.db.update(workspaces).set({ settings: { autoResumeOnLimit: false } }).where(eq(workspaces.id, 'ws'));
  await account('codex');
  await handleChatLimit(await chat(), reason);
  expect(await backfillChatLimits()).toBe(0);
  expect((await chat()).resumeAt).toBeNull();
  expect(sendMessage).not.toHaveBeenCalled();
});
it('defers an unattended turn when the box gate refuses it', async () => {
  await account('codex');
  vi.mocked(existingBoxRefusal).mockResolvedValue(new UsageExhaustedError({ tier: 'free', periodEnd: new Date(Date.now() + 60 * 60_000) }));
  await handleChatLimit(await chat(), reason);
  expect(existingBoxRefusal).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws' }), true, null);
  expect((await chat()).resumeAt).not.toBeNull();
  expect(sendMessage).not.toHaveBeenCalled();
});

it.each([true, false, 'true', null, 1])('validates autoResumeOnLimit=%s', async (value) => {
  const router = workspaceRoutes() as unknown as { stack: Array<{
    route?: { path: string; methods: { patch?: boolean }; stack: Array<{ handle: (req: Request, res: Response) => Promise<unknown> }> };
  }> };
  const handler = router.stack.find((layer) => layer.route?.path === '/:id' && layer.route.methods.patch)!.route!.stack[0].handle;
  const req = { params: { id: 'ws' }, body: { settings: { autoResumeOnLimit: value } }, user: { id: 'owner' } } as unknown as Request;
  let status = 200;
  const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
  await handler(req, res);
  expect(status).toBe(typeof value === 'boolean' ? 200 : 400);
  if (typeof value === 'boolean') {
    const [row] = await testDb.db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, 'ws'));
    expect(row.settings).toMatchObject({ autoResumeOnLimit: value });
  }
});

it('uses the earliest reset among agents that the box carries', async () => {
  await account('codex');
  const earlier = new Date(Date.now() + 60 * 60_000).toISOString();
  await testDb.db.update(fleetAccounts).set({ quotaExhausted: { at: new Date().toISOString(), kind: 'rate_limit', resetsAt: earlier } }).where(eq(fleetAccounts.id, 'codex'));
  const later = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  await handleChatLimit(await chat(), `${reason} resetsAt: "${later}"`);
  expect((await chat()).resumeAt?.toISOString()).toBe(earlier);
});

it('does not backfill an archived session', async () => {
  await testDb.db.update(workbenches).set({ archivedAt: new Date() }).where(eq(workbenches.id, 'wb'));
  expect(await backfillChatLimits()).toBe(0);
});

it('does not schedule a chat with a user message in its queue', async () => {
  await updateChat('chat', { queuedMessages: [{ id: 'user', text: 'Wait', queuedAt: new Date().toISOString() }] });
  expect(await backfillChatLimits()).toBe(0);
  await handleChatLimit(await chat(), reason);
  expect((await chat()).resumeAt).toBeNull();
});

it.each(['owner', 'other'])('scopes resume cancellation to the owner: %s', async (userId) => {
  vi.stubEnv('WORKBENCHES_ENABLED', 'true');
  resetFeatureFlagsForTests();
  await handleChatLimit(await chat(), reason);
  const router = workbenchRoutes() as unknown as { stack: Array<{
    route?: { path: string; stack: Array<{ handle: (req: Request, res: Response) => Promise<unknown> }> };
  }> };
  const handler = router.stack.find((layer) => layer.route?.path === '/chats/:chatId/resume/cancel')!.route!.stack[0].handle;
  const req = { params: { chatId: 'chat' }, user: { id: userId } } as unknown as Request;
  let status = 200;
  const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
  await handler(req, res);
  expect(status).toBe(userId === 'owner' ? 200 : 404);
  expect(Boolean((await chat()).resumeAt)).toBe(userId !== 'owner');
});

it('recovers a claimed resume if a process stops after switching agents', async () => {
  await updateChat('chat', { agent: 'codex', resumeReason: reason, limitCount: 1, resumeAt: null });
  expect(await backfillChatLimits()).toBe(1);
});
