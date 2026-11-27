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
import { setUsageFetchForTests } from '../services/selfHosted/accountSelection.js';
import { encryptString } from '../services/tokenCrypto.js';
import { randomBytes } from 'node:crypto';
import { resetCodexOauthCache } from '../services/selfHosted/codexOauth.js';

const tokenFetch = vi.hoisted(() => vi.fn());
vi.mock('../services/httpTimeout.js', async (original) => ({
  ...(await original<typeof import('../services/httpTimeout.js')>()), fetchWithTimeout: tokenFetch,
}));

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
const usageFetch = vi.fn<typeof fetch>();
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
  usageFetch.mockReset();
  tokenFetch.mockReset();
  resetCodexOauthCache();
  setUsageFetchForTests(usageFetch);
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
afterEach(async () => {
  setUsageFetchForTests(undefined);
  vi.unstubAllEnvs();
  vi.useRealTimers();
  resetFeatureFlagsForTests();
  await testDb.cleanup();
});

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

it.each([
  ['claude', 'credential'], ['codex', 'credential'],
  ['claude', 'rate limit'], ['codex', 'rate limit'],
] as const)('refreshes stale %s usage during a %s resume', async (agent, failure) => {
  vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
  if (agent === 'codex') await account('codex');
  await testDb.db.update(fleetAccounts).set({
    kind: agent === 'claude' ? 'claude_oauth' : 'codex_oauth',
    credential: {
      accessTokenEnc: encryptString('test-token'), refreshTokenEnc: encryptString('test-refresh'),
      expiresAt: future(60), ...(agent === 'codex' ? { accountId: 'test-account' } : {}),
    },
  }).where(eq(fleetAccounts.id, agent));
  for (const id of agent === 'codex' ? ['claude', 'codex'] : ['claude']) {
    await setFleetAccountUsage(id, { fetchedAt: new Date().toISOString(),
      windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt: future(90) }] });
  }
  if (failure === 'credential') await fail();
  else await handleChatLimit(await chat(), reason);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(usageFetch).not.toHaveBeenCalled();

  await setFleetAccountUsage(agent, { fetchedAt: future(-10),
    windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt: future(-1) }] });
  if (failure === 'rate limit') await testDb.db.update(fleetAccounts).set({
    quotaExhausted: { at: future(-10), kind: 'rate_limit' },
  }).where(eq(fleetAccounts.id, 'claude'));
  usageFetch.mockResolvedValue(new Response(JSON.stringify(agent === 'claude'
    ? { limits: [{ kind: 'session', group: 'session', percent: 10, resets_at: null, scope: null }] }
    : { rate_limit: { limit_reached: false, primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }),
  { status: 200 }));
  await updateChat('chat', { resumeAt: new Date(Date.now() - 1000) });
  await sweepChatLimits();
  expect(usageFetch).toHaveBeenCalledOnce();
  expect(sendMessage).toHaveBeenCalledOnce();
  expect(await chat()).toMatchObject({ agent, status: 'running', resumeAt: null });
});

it.each(['usage', 'hold', 'unknown'] as const)('schedules the earlier Codex retry from %s', async (source) => {
  await account('codex');
  await updateChat('chat', { model: 'claude-opus-5-5' });
  await setFleetAccountUsage('claude', { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: future(3 * 24 * 60) }] });
  const at = future(60);
  if (source === 'hold') await testDb.db.update(fleetAccounts).set({
    quotaExhausted: { at: new Date().toISOString(), kind: 'rate_limit', resetsAt: at },
  }).where(eq(fleetAccounts.id, 'codex'));
  else await setFleetAccountUsage('codex', { fetchedAt: new Date().toISOString(), windows: [{
    key: 'model', label: 'Astra', scopeModel: 'Astra', usedPercent: 100, resetsAt: source === 'unknown' ? null : at,
  }] });
  const start = Date.now();
  await fail();
  const waiting = await chat();
  expect(sendMessage).not.toHaveBeenCalled();
  if (source === 'unknown') {
    expect(waiting.resumeAt!.getTime()).toBeGreaterThanOrEqual(start + limitRetryDelay(1));
    expect(waiting.resumeAt!.getTime()).toBeLessThanOrEqual(Date.now() + limitRetryDelay(1));
  } else expect(waiting.resumeAt?.toISOString()).toBe(at);
  await testDb.db.update(fleetAccounts).set({ quotaExhausted: null, usage: null }).where(eq(fleetAccounts.id, 'codex'));
  await sweepChatLimits(waiting.resumeAt!);
  expect(await chat()).toMatchObject({ agent: 'codex', status: 'running', resumeAt: null });
});

it.each(['unsupported', 'reauth'] as const)('ignores the earlier Codex reset when Codex is %s', async (condition) => {
  await account('codex');
  const at = future(3 * 24 * 60);
  await setFleetAccountUsage('claude', { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: at }] });
  await setFleetAccountUsage('codex', { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt: future(60) }] });
  if (condition === 'unsupported') await recordSandboxAgents((await getWorkbench('wb'))!, 'box', ['claude']);
  else await setFleetAccountReauth('codex');
  await fail();
  expect((await chat()).resumeAt?.toISOString()).toBe(at);
});

it('bounds concurrent usage reads for a workspace with many stale subscriptions', async () => {
  vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
  await setFleetAccountUsage('claude', { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: future(3 * 24 * 60) }] });
  for (let i = 0; i < 19; i++) {
    const added = await addFleetAccount('ws', { kind: 'codex_oauth', credential: {
      accessTokenEnc: encryptString(`test-token-${i}`), refreshTokenEnc: encryptString('test-refresh'),
      expiresAt: future(60), accountId: `test-account-${i}`,
    } });
    await setFleetAccountUsage(added.id, { fetchedAt: future(-10),
      windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt: future(90) }] });
  }
  let active = 0;
  let peak = 0;
  usageFetch.mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active--;
    return new Response(JSON.stringify({ rate_limit: { limit_reached: true,
      primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 3600 },
    } }), { status: 200 });
  });
  await fail();
  expect(usageFetch).toHaveBeenCalledTimes(19);
  expect(peak).toBe(1);
  expect(sendMessage).not.toHaveBeenCalled();
});

it('keeps a recoverable usage wait when refreshing Codex revokes its sign-in', async () => {
  vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
  const at = future(3 * 24 * 60);
  await setFleetAccountUsage('claude', { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: at }] });
  const codex = await addFleetAccount('ws', { kind: 'codex_oauth', credential: {
    accessTokenEnc: encryptString('test-token'), refreshTokenEnc: encryptString('test-refresh'),
    expiresAt: future(-60), accountId: 'test-account',
  } });
  await setFleetAccountUsage(codex.id, { fetchedAt: future(-10), windows: [] });
  tokenFetch.mockResolvedValue({ ok: false, status: 400, bodyText: JSON.stringify({ error: 'invalid_grant' }) });
  await fail();
  expect((await fleetAgentStatus('ws')).reauthAgents).toEqual(['codex']);
  expect(await chat()).toMatchObject({ agent: 'claude', status: 'error', resumeAt: new Date(at) });
  expect(sendMessage).not.toHaveBeenCalled();
  expect(usageFetch).not.toHaveBeenCalled();
  await setFleetAccountUsage('claude', { fetchedAt: new Date().toISOString(), windows: [] });
  await sweepChatLimits(new Date(at));
  expect(await chat()).toMatchObject({ agent: 'claude', status: 'running', resumeAt: null });
  expect(tokenFetch).toHaveBeenCalledOnce();
});

it.each(['usage', 'unknown'] as const)('checks the earlier Codex %s reset after a runtime rate limit', async (source) => {
  await account('codex');
  await updateChat('chat', { model: 'claude-opus-5-5' });
  const at = future(60);
  await setFleetAccountUsage('codex', { fetchedAt: new Date().toISOString(), windows: [{
    key: 'model', label: 'Astra', scopeModel: 'Astra', usedPercent: 100, resetsAt: source === 'unknown' ? null : at,
  }] });
  const start = Date.now();
  await handleChatLimit(await chat(), `${reason} resetsAt: "${future(3 * 24 * 60)}"`);
  const waiting = await chat();
  expect(sendMessage).not.toHaveBeenCalled();
  if (source === 'unknown') {
    expect(waiting.resumeAt!.getTime()).toBeGreaterThanOrEqual(start + limitRetryDelay(1));
    expect(waiting.resumeAt!.getTime()).toBeLessThanOrEqual(Date.now() + limitRetryDelay(1));
  } else expect(waiting.resumeAt?.toISOString()).toBe(at);
  await setFleetAccountUsage('codex', { fetchedAt: new Date().toISOString(), windows: [] });
  await sweepChatLimits(waiting.resumeAt!);
  expect(await chat()).toMatchObject({ agent: 'codex', status: 'running', resumeAt: null });
});

it.each([1, MAX_CREDENTIAL_RETRIES])('preserves a usage wait at count %i through availability checks and recovery', async (count) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  await account('codex');
  await updateChat('chat', { limitCount: count - 1 });
  const reset = future(3 * 24 * 60);
  await setFleetAccountUsage('claude', { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: reset }] });
  await setFleetAccountUsage('codex', { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt: null }] });
  await fail();
  for (let i = 0; i <= MAX_CREDENTIAL_RETRIES; i++) {
    const waiting = await chat();
    expect(waiting.resumeAt).toBeInstanceOf(Date);
    vi.setSystemTime(waiting.resumeAt!);
    await sweepChatLimits();
    expect((await chat()).limitCount).toBe(count);
  }
  expect(sendMessage).not.toHaveBeenCalled();
  await updateChat('chat', { resumeAt: null });
  expect(await backfillChatLimits()).toBe(1);
  await sweepChatLimits();
  expect((await chat()).resumeAt).toBeInstanceOf(Date);
  vi.setSystemTime(new Date(reset));
  await setFleetAccountUsage('claude', { fetchedAt: new Date().toISOString(), windows: [] });
  await sweepChatLimits();
  expect(await chat()).toMatchObject({ agent: 'claude', status: 'running', resumeAt: null });
});

it('does not restart a new usage failure after the failed turn allowance is spent', async () => {
  await setFleetAccountUsage('claude', { fetchedAt: new Date().toISOString(),
    windows: [{ key: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: future(3 * 24 * 60) }] });
  await updateChat('chat', { limitCount: MAX_CREDENTIAL_RETRIES });
  await fail();
  expect((await chat()).resumeAt).toBeNull();
  expect(await backfillChatLimits()).toBe(0);
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
