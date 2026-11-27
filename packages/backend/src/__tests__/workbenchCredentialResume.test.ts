import { addFleetAccount, setFleetAccountReauth, setFleetAccountUsage, updateFleetAccountCredential, upsertPrimaryFleetAccount, type FleetApiKeyCredential } from '../services/selfHosted/accounts.js';
import { missingSessionCredential } from '../services/workbenches/credentialFailure.js';
import { fleetAgentStatus } from '../services/selfHosted/credentials.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { fleetAccounts, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import { appendEvents, claimOrEnqueue, getChat, getWorkbench, updateChat } from '../services/workbenches/store.js';
import { cancelLimitResume, handleChatLimit, limitRetryDelay, MAX_CREDENTIAL_RETRIES } from '../services/workbenches/limitResume.js';
import { backfillChatLimits, sweepChatLimits } from '../services/workbenches/limitResumeSweep.js';
import { sendMessage } from '../services/workbenches/turns.js';
import { existingBoxRefusal } from '../services/workbenches/boxGate.js';
import { UsageExhaustedError } from '../services/billing/entitlements.js';
import { recordSandboxAgents } from '../services/workbenches/credentialPolicy.js';

vi.mock('../services/githubIdentity.js', async (original) => ({
  ...(await original<typeof import('../services/githubIdentity.js')>()), ensureGithubUserId: async () => null,
}));

vi.mock('../services/workbenches/turns.js', () => ({
  sendMessage: vi.fn(async (id, input, options) => {
    await claimOrEnqueue(id, { id: 'resume', text: input.text, origin: options.origin, payer: options.payer, queuedAt: new Date().toISOString() }, true, options.resumeVersion);
    return { queued: false };
  }),
  startQueuedIfIdle: vi.fn(async () => false),
  cancelTurn: vi.fn(), endCapacityWait: vi.fn(),
}));
vi.mock('../services/workbenches/boxGate.js', () => ({ existingBoxRefusal: vi.fn(async () => null) }));
vi.mock('../services/selfHosted/quotaProbe.js', () => ({ verifyAgentQuota: vi.fn(async () => 'unknown') }));
vi.mock('../services/workbenches/emit.js', () => ({ emitWorkbenchChat: vi.fn(), emitWorkbenchEvents: vi.fn() }));

const reason = "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.";
const credential: FleetApiKeyCredential = { keyEnc: { v: 1, iv: 'unused', ct: 'unused', tag: 'unused' } };
let testDb: Awaited<ReturnType<typeof createTestDb>>;
const chat = async () => (await getChat('chat'))!;
async function account(agent: 'claude' | 'codex') {
  await testDb.db.insert(fleetAccounts).values({
    id: agent, workspaceId: 'ws', agent, kind: agent === 'claude' ? 'anthropic_key' : 'openai_key',
    label: agent, priority: 1, credential,
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(existingBoxRefusal).mockResolvedValue(null);
  testDb = await createTestDb();
  await seedUser(testDb.db, { id: 'owner' });
  await seedUser(testDb.db, { id: 'payer', email: 'payer@example.test' });
  await testDb.db.insert(workspaces).values({ id: 'other', name: 'Other', ownerId: 'payer' });
  await testDb.db.insert(workspaces).values({ id: 'ws', name: 'Workspace', ownerId: 'owner' });
  await testDb.db.insert(workbenches).values({
    id: 'wb', workspaceId: 'ws', repoFullName: '', branch: '', baseBranch: '', kind: 'thread', name: 'Session', runtime: 'sandbox', agent: 'claude',
    status: 'ready', sandboxId: 'box',
  });
  await recordSandboxAgents((await getWorkbench('wb'))!, 'box', ['claude', 'codex']);
  await testDb.db.insert(workbenchChats).values({
    id: 'chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Chat', agent: 'claude',
    status: 'error', statusMessage: reason, turnCount: 1,
  });
  await account('claude');
});
afterEach(async () => { vi.unstubAllEnvs(); resetFeatureFlagsForTests(); await testDb.cleanup(); });

const future = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
async function fail() {
  const row = await chat();
  const error = await missingSessionCredential(row.payerWorkspaceId ?? row.workspaceId, row.agent as 'claude' | 'codex');
  await updateChat(row.id, { statusMessage: error.message });
  await appendEvents(row.id, [{ turn: row.turnCount, event: { type: 'result', code: error.code, ...error.details } }]);
  await handleChatLimit(await chat(), error.message);
}

it.each([
  ['claude', 'codex', 'claude-opus-5-5', 'gpt-6-astra'],
  ['codex', 'claude', 'gpt-6-astra', 'claude-fable-5-2'],
] as const)('switches from %s to %s after a credential usage refusal', async (from, to, model, switchedModel) => {
  await account('codex');
  await updateChat('chat', { agent: from, model, agentSessionId: 'old-session' });
  await setFleetAccountUsage(from, { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt: future(90) }] });
  await fail();
  expect(await chat()).toMatchObject({ agent: to, model: switchedModel, status: 'running', resumeAt: null, agentSessionId: null });
  expect(sendMessage).toHaveBeenCalledOnce();
  const saved = await testDb.pglite.query<{ recap_pending: boolean }>("select recap_pending from workbench_chats where id = 'chat'");
  expect(saved.rows[0].recap_pending).toBe(true);
  const events = await testDb.pglite.query<{ event: { subtype?: string } }>('select event from workbench_events');
  expect(events.rows.some(({ event }) => event.subtype === 'agent_limit_switch')).toBe(true);
});

it.each(['usage', 'hold'] as const)('switches a waiting chat when Codex becomes available after a %s refusal', async (source) => {
  if (source === 'usage') await setFleetAccountUsage('claude', { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt: future(90) }] });
  else await testDb.db.update(fleetAccounts).set({ quotaExhausted: { at: new Date().toISOString(), resetsAt: future(90) } })
    .where(eq(fleetAccounts.id, 'claude'));
  await fail();
  expect(sendMessage).not.toHaveBeenCalled();
  await account('codex');
  await updateChat('chat', { resumeAt: new Date(Date.now() - 1000) });
  await sweepChatLimits();
  expect(await chat()).toMatchObject({ agent: 'codex', status: 'running', resumeAt: null });
  expect(sendMessage).toHaveBeenCalledOnce();
});

it.each(['usage', 'hold', 'reauth', 'old box'] as const)('waits after a credential usage refusal when Codex has %s', async (condition) => {
  await account('codex');
  const at = future(90);
  await setFleetAccountUsage('claude', { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt: at }] });
  if (condition === 'usage') await setFleetAccountUsage('codex', { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt: future(180) }] });
  if (condition === 'hold') await testDb.db.update(fleetAccounts).set({ quotaExhausted: { at: new Date().toISOString(), resetsAt: future(180) } })
    .where(eq(fleetAccounts.id, 'codex'));
  if (condition === 'reauth') await setFleetAccountReauth('codex');
  if (condition === 'old box') await testDb.db.update(workbenches).set({ settings: {} }).where(eq(workbenches.id, 'wb'));
  await fail();
  expect(await chat()).toMatchObject({ agent: 'claude', status: 'error', resumeAt: new Date(at) });
  expect(sendMessage).not.toHaveBeenCalled();
});

it.each([false, true])('uses the full quota setting (%s) when it checks Codex', async (fullQuota) => {
  await account('codex');
  await testDb.db.update(workspaces).set({ settings: { fleetSwitchAtPercent: 90, fleetUseFullQuotaWhenAllOver: fullQuota } })
    .where(eq(workspaces.id, 'ws'));
  for (const [id, usedPercent] of [['claude', 100], ['codex', 95]] as const) {
    await setFleetAccountUsage(id, { fetchedAt: new Date().toISOString(),
      windows: [{ key: 'session', label: '5-hour', usedPercent, resetsAt: future(90) }] });
  }
  await fail();
  expect((await chat()).agent).toBe(fullQuota ? 'codex' : 'claude');
  expect(sendMessage).toHaveBeenCalledTimes(fullQuota ? 1 : 0);
});

it.each(['Astra', 'Sol'])('checks the mapped model against a %s usage window', async (scopeModel) => {
  await account('codex');
  await updateChat('chat', { model: 'claude-opus-5-5' });
  await setFleetAccountUsage('claude', { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt: future(90) }] });
  await setFleetAccountUsage('codex', { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'model', label: scopeModel, scopeModel, usedPercent: 100, resetsAt: future(90) }] });
  await fail();
  expect((await chat()).agent).toBe(scopeModel === 'Astra' ? 'claude' : 'codex');
});

it.each(['setting', 'budget'] as const)('respects the %s gate before an automatic switch', async (gate) => {
  await account('codex');
  await setFleetAccountUsage('claude', { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt: future(90) }] });
  if (gate === 'setting') await testDb.db.update(workspaces).set({ settings: { autoResumeOnLimit: false } }).where(eq(workspaces.id, 'ws'));
  else vi.mocked(existingBoxRefusal).mockResolvedValue(new UsageExhaustedError({ tier: 'free', periodEnd: new Date(future(60)) }));
  await fail();
  expect((await chat()).agent).toBe('claude');
  expect(sendMessage).not.toHaveBeenCalled();
});

it.each(['ws', 'other'] as const)('uses only the payer accounts when Codex belongs to %s', async (workspaceId) => {
  await updateChat('chat', { payerUserId: 'payer', payerWorkspaceId: 'other' });
  const payerAccount = await addFleetAccount('other', { kind: 'anthropic_key', credential });
  await setFleetAccountUsage(payerAccount.id, { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt: future(90) }] });
  await addFleetAccount(workspaceId, { kind: 'openai_key', credential });
  await fail();
  expect((await chat()).agent).toBe(workspaceId === 'other' ? 'codex' : 'claude');
  if (workspaceId === 'other') expect(sendMessage).toHaveBeenCalledWith('chat', expect.anything(), expect.objectContaining({
    payer: expect.objectContaining({ userId: 'payer', workspaceId: 'other' }),
  }));
  else expect(sendMessage).not.toHaveBeenCalled();
});

it.each(['usage', 'hold'] as const)('schedules the first known account reset from %s', async (source) => {
  const at = future(90);
  const second = await addFleetAccount('ws', { kind: 'anthropic_key', credential });
  for (const [id, resetsAt] of [['claude', at], [second.id, future(180)]]) {
    if (source === 'usage') await setFleetAccountUsage(id, { fetchedAt: new Date().toISOString(),
      windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt }] });
    else await testDb.db.update(fleetAccounts).set({ quotaExhausted: { at: new Date().toISOString(), resetsAt } }).where(eq(fleetAccounts.id, id));
  }
  await fail();
  expect((await chat()).resumeAt?.toISOString()).toBe(at);
  expect((await chat()).statusMessage).toContain('Waiting for Claude usage. Resumes at');
  expect(sendMessage).not.toHaveBeenCalled();
});

it.each([1, 2, 4])('uses backoff without a known reset, attempt %s', async (count) => {
  await updateChat('chat', { limitCount: count - 1 });
  await setFleetAccountUsage('claude', { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt: null }] });
  const start = Date.now();
  await fail();
  expect((await chat()).resumeAt!.getTime()).toBeGreaterThanOrEqual(start + limitRetryDelay(count));
  const [saved] = await testDb.db.select().from(fleetAccounts).where(eq(fleetAccounts.id, 'claude'));
  expect(saved.quotaExhausted).toBeNull();
  expect(saved.usage).toMatchObject({ windows: [{ resetsAt: null }] });
});

it.each(['update', 'add', 'upsert existing', 'upsert new'] as const)('wakes a reconnect wait after %s stores a credential', async (write) => {
  await setFleetAccountReauth('claude');
  await fail();
  const waiting = await chat();
  expect(waiting.resumeAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
  expect(waiting.statusMessage).toContain('Waiting for claude to be signed in again. Checks again at');
  expect(sendMessage).not.toHaveBeenCalled();
  const before = Date.now();
  if (write === 'update') await updateFleetAccountCredential('claude', credential);
  if (write === 'add') await addFleetAccount('ws', { kind: 'anthropic_key', credential });
  if (write === 'upsert existing') await upsertPrimaryFleetAccount('ws', 'anthropic_key', credential);
  if (write === 'upsert new') await upsertPrimaryFleetAccount('ws', 'claude_oauth', credential);
  expect((await chat()).resumeAt!.getTime()).toBeGreaterThanOrEqual(before);
  expect((await chat()).resumeAt!.getTime()).toBeLessThanOrEqual(Date.now());
  await sweepChatLimits();
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(await chat()).toMatchObject({ status: 'running', agent: 'claude', resumeAt: null });
});

it.each([['ws', 'openai_key'], ['other', 'anthropic_key']] as const)('does not wake on a credential for %s / %s', async (workspaceId, kind) => {
  await setFleetAccountReauth('claude');
  await fail();
  const at = (await chat()).resumeAt;
  await addFleetAccount(workspaceId, { kind, credential });
  expect((await chat()).resumeAt).toEqual(at);
  await sweepChatLimits();
  expect(sendMessage).not.toHaveBeenCalled();
});

it('parks a mixed set without changing what reauthAgents means', async () => {
  await setFleetAccountReauth('claude');
  const limited = await addFleetAccount('ws', { kind: 'anthropic_key', credential });
  await setFleetAccountUsage(limited.id, { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt: future(90) }] });
  expect((await fleetAgentStatus('ws')).reauthAgents).toEqual([]);
  await fail();
  expect((await chat()).statusMessage).toContain('Waiting for claude to be signed in again.');
  await updateFleetAccountCredential('claude', credential);
  await sweepChatLimits();
  expect(sendMessage).toHaveBeenCalledTimes(1);
});

it('uses the payer workspace for the wait, credential wake and resumed turn', async () => {
  await updateChat('chat', { payerUserId: 'payer', payerWorkspaceId: 'other' });
  const payerAccount = await addFleetAccount('other', { kind: 'anthropic_key', credential, label: 'Payer account' });
  await setFleetAccountReauth(payerAccount.id);
  await fail();
  const at = (await chat()).resumeAt;
  expect((await chat()).statusMessage).toContain('Payer account');
  await updateFleetAccountCredential('claude', credential);
  expect((await chat()).resumeAt).toEqual(at);
  await updateFleetAccountCredential(payerAccount.id, credential);
  await sweepChatLimits();
  expect(sendMessage).toHaveBeenCalledWith('chat', expect.anything(), expect.objectContaining({
    payer: expect.objectContaining({ userId: 'payer', workspaceId: 'other' }),
  }));
  expect(existingBoxRefusal).toHaveBeenCalledWith(expect.anything(), true, { userId: 'payer', workspaceId: 'other' });
});

it('does not schedule a missing account', async () => {
  await testDb.db.delete(fleetAccounts);
  await fail();
  expect((await chat()).resumeAt).toBeNull();
  expect(await backfillChatLimits()).toBe(0);
});

it.each(['before failure', 'before reconnect'] as const)('respects automatic resume off %s', async (when) => {
  await setFleetAccountReauth('claude');
  if (when === 'before reconnect') await fail();
  await testDb.db.update(workspaces).set({ settings: { autoResumeOnLimit: false } }).where(eq(workspaces.id, 'ws'));
  if (when === 'before failure') await fail();
  const at = (await chat()).resumeAt;
  await updateFleetAccountCredential('claude', credential);
  expect((await chat()).resumeAt).toEqual(at);
  await sweepChatLimits(new Date(Date.now() + 2 * 60 * 60_000));
  expect(sendMessage).not.toHaveBeenCalled();
  expect((await chat()).resumeAt).toBeNull();
});

it('does not wake a cancelled wait or backfill it', async () => {
  await setFleetAccountReauth('claude');
  await fail();
  await cancelLimitResume('chat');
  await updateFleetAccountCredential('claude', credential);
  expect((await chat()).resumeAt).toBeNull();
  expect(await backfillChatLimits()).toBe(0);
});

it('stops after the retry bound, including a wait with no usable account', async () => {
  await setFleetAccountReauth('claude');
  await updateChat('chat', { limitCount: MAX_CREDENTIAL_RETRIES - 1 });
  await fail();
  await sweepChatLimits(new Date(Date.now() + 2 * 60 * 60_000));
  expect((await chat()).resumeAt).toBeNull();
  expect(await backfillChatLimits()).toBe(0);
  await fail();
  expect((await chat()).resumeAt).toBeNull();
  expect(sendMessage).not.toHaveBeenCalled();
});

it('resumes a limited chat through the same sweep when usage returns', async () => {
  await setFleetAccountUsage('claude', { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt: future(90) }] });
  await fail();
  await setFleetAccountUsage('claude', { fetchedAt: new Date().toISOString(), windows: [] });
  await updateChat('chat', { resumeAt: new Date(Date.now() - 1000) });
  await sweepChatLimits();
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(await chat()).toMatchObject({ agent: 'claude', status: 'running', resumeAt: null });
});

it('does not turn an unrelated failure into a credential wait', async () => {
  await setFleetAccountReauth('claude');
  await handleChatLimit(await chat(), 'Personal needs to be signed in again.');
  expect((await chat()).resumeAt).toBeNull();
});

it('handles a reconnect between the refusal and scheduling', async () => {
  await setFleetAccountReauth('claude');
  const error = await missingSessionCredential('ws', 'claude');
  await appendEvents('chat', [{ turn: 1, event: { type: 'result', code: error.code, ...error.details } }]);
  await updateFleetAccountCredential('claude', credential);
  await handleChatLimit(await chat(), error.message);
  expect((await chat()).resumeAt!.getTime()).toBeLessThanOrEqual(Date.now());
  await sweepChatLimits();
  expect(sendMessage).toHaveBeenCalledTimes(1);
});

it('backfills a credential refusal from its saved result', async () => {
  await setFleetAccountReauth('claude');
  const error = await missingSessionCredential('ws', 'claude');
  await updateChat('chat', { statusMessage: error.message });
  await appendEvents('chat', [{ turn: 1, event: { type: 'result', code: error.code, ...error.details } }]);
  expect(await backfillChatLimits()).toBe(1);
  await sweepChatLimits();
  expect((await chat()).statusMessage).toContain('Waiting for claude to be signed in again.');
});
