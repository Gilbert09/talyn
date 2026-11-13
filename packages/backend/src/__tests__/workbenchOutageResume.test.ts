import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentOutageFrom } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { fleetAccounts, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import { claimOrEnqueue, getChat, updateChat } from '../services/workbenches/store.js';
import { handleChatLimit } from '../services/workbenches/limitResume.js';
import { sweepChatLimits } from '../services/workbenches/limitResumeSweep.js';
import {
  handleChatOutage, MAX_OUTAGE_RETRIES, OUTAGE_SUSPEND_DELAY_MS, outageAgentFrom, outageResumeMessage,
  outageRetryDelay, suspendAfterOutage,
} from '../services/workbenches/outageResume.js';
import { sendMessage } from '../services/workbenches/turns.js';
import { existingBoxRefusal } from '../services/workbenches/boxGate.js';
import { fleetClientFor } from '../services/workbenches/sandboxRuntime.js';
import { meterWorkbenchSuspended } from '../services/workbenches/usageMeter.js';
import { UsageExhaustedError } from '../services/billing/entitlements.js';
import type { FleetClient } from '../services/selfHosted/client.js';

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
vi.mock('../services/workbenches/usageMeter.js', () => ({ meterWorkbenchSuspended: vi.fn(async () => undefined) }));
vi.mock('../services/workbenches/sandboxRuntime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/workbenches/sandboxRuntime.js')>()),
  fleetClientFor: vi.fn(),
}));

const OVERLOADED = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
const RATE_LIMIT = "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.";

describe('agentOutageFrom', () => {
  it.each([
    [OVERLOADED, 'claude'],
    ['API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', 'claude'],
    ['API Error: 502 Bad Gateway', 'claude'],
    ['API Error: 503 upstream connect error', 'claude'],
    ['API Error: Connection error.', 'claude'],
    ['API Error: Request timed out.', 'claude'],
    ['API Error (Connection error.)', 'claude'],
    ['unexpected status 500 Internal Server Error: {"error":"server_error"}', 'codex'],
    ['unexpected status 503 Service Unavailable', 'codex'],
    ['exceeded retry limit, last status: 502 Bad Gateway', 'codex'],
    ['stream disconnected before completion: error sending request for url', 'codex'],
    ["We're currently experiencing high demand, which may cause temporary errors.", 'codex'],
  ] as const)('names the vendor for %s', (text, agent) => {
    expect(agentOutageFrom(text)).toBe(agent);
    expect(outageAgentFrom(text)).toBe(agent);
  });

  it.each([
    [RATE_LIMIT],
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}'],
    ['API Error: 400 {"type":"error","error":{"type":"invalid_request_error"}}'],
    ['API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'],
    ['unexpected status 401 Unauthorized'],
    ['The deploy returned 503 Service Unavailable, so I stopped.'],
    ['The agent exited with code 1.'],
    [''],
  ])('is not an outage: %s', (text) => {
    expect(outageAgentFrom(text)).toBeNull();
  });

  it.each([null, undefined])('is null for %s', (text) => {
    expect(agentOutageFrom(text)).toBeNull();
  });

  it('lets a rate limit win over an outage word in the same text', () => {
    expect(agentOutageFrom(`${RATE_LIMIT} ${OVERLOADED}`)).toBe('claude');
    expect(outageAgentFrom(`${RATE_LIMIT} ${OVERLOADED}`)).toBeNull();
  });
});

describe('outageRetryDelay', () => {
  it.each([[0, 2], [1, 2], [2, 5], [3, 10], [4, 20], [5, 30], [6, 30], [20, 30]])('retry %i waits %i minutes', (count, minutes) => {
    expect(outageRetryDelay(count)).toBe(minutes * 60_000);
  });
});

let testDb: Awaited<ReturnType<typeof createTestDb>>;
const chat = async () => (await getChat('chat'))!;
const fleet = { getSandbox: vi.fn(), suspendSandbox: vi.fn(async () => undefined) };
let suspendTimers: Array<() => void> = [];

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(existingBoxRefusal).mockResolvedValue(null);
  vi.mocked(fleetClientFor).mockResolvedValue(fleet as unknown as FleetClient);
  fleet.getSandbox.mockResolvedValue({ sandbox: { id: 'box', status: 'idle' }, terminal: false });
  // Capture the delayed suspend instead of waiting 30 seconds for it.
  suspendTimers = [];
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === OUTAGE_SUSPEND_DELAY_MS) {
      suspendTimers.push(fn);
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    }
    return realSetTimeout(fn, ms, ...rest);
  }) as typeof setTimeout);
  testDb = await createTestDb();
  await seedUser(testDb.db, { id: 'owner' });
  await testDb.db.insert(workspaces).values({ id: 'ws', name: 'Workspace', ownerId: 'owner' });
  await testDb.db.insert(workbenches).values({
    id: 'wb', workspaceId: 'ws', repoFullName: '', branch: '', baseBranch: '', kind: 'thread', name: 'Session', runtime: 'sandbox', agent: 'claude',
    status: 'ready', sandboxId: 'box', sandboxState: 'running', settings: { sandboxAgents: { box: ['claude', 'codex'] } },
  });
  await testDb.db.insert(workbenchChats).values({
    id: 'chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Chat', agent: 'claude',
    status: 'error', statusMessage: OVERLOADED, turnCount: 1,
  });
  for (const agent of ['claude', 'codex'] as const) {
    await testDb.db.insert(fleetAccounts).values({
      id: agent, workspaceId: 'ws', agent, kind: agent === 'claude' ? 'anthropic_key' : 'openai_key',
      label: agent, priority: 1, credential: { keyEnc: 'unused' },
    });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await testDb.cleanup();
});

describe('a turn that ends on an outage', () => {
  it('waits on the same agent, sends nothing now, and schedules the suspend', async () => {
    const before = Date.now();
    await handleChatLimit(await chat(), OVERLOADED);
    const waiting = await chat();
    expect(waiting).toMatchObject({ agent: 'claude', status: 'error', limitCount: 1, resumeReason: OVERLOADED });
    expect(waiting.statusMessage).toMatch(/^Claude's API is failing\. Talyn suspended this box and tries again at \d\d:\d\d UTC\.$/);
    const at = Date.parse(waiting.resumeAt!);
    expect(at).toBeGreaterThanOrEqual(before + 2 * 60_000 - 1_000);
    expect(at).toBeLessThan(Date.now() + 2 * 60_000 + 1_000);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(suspendTimers).toHaveLength(1);
  });

  it('waits longer after each failed retry', async () => {
    await updateChat('chat', { limitCount: 3 });
    const before = Date.now();
    await handleChatOutage(await chat(), OVERLOADED);
    const waiting = await chat();
    expect(waiting.limitCount).toBe(4);
    expect(Date.parse(waiting.resumeAt!)).toBeGreaterThanOrEqual(before + 20 * 60_000 - 1_000);
  });

  it('stops after the last retry and leaves the error', async () => {
    await updateChat('chat', { limitCount: MAX_OUTAGE_RETRIES });
    await handleChatOutage(await chat(), OVERLOADED);
    expect(await chat()).toMatchObject({ resumeAt: null, limitCount: MAX_OUTAGE_RETRIES, statusMessage: OVERLOADED });
    expect(suspendTimers).toHaveLength(0);
  });

  it('does nothing when the workspace turned auto-resume off', async () => {
    await testDb.pglite.query(`update workspaces set settings = '{"autoResumeOnLimit": false}'::jsonb where id = 'ws'`);
    await handleChatLimit(await chat(), OVERLOADED);
    expect(await chat()).toMatchObject({ resumeAt: null, limitCount: 0 });
    expect(suspendTimers).toHaveLength(0);
  });

  it('ignores an outage of the other agent', async () => {
    await handleChatOutage(await chat(), 'unexpected status 503 Service Unavailable');
    expect(await chat()).toMatchObject({ resumeAt: null, limitCount: 0 });
  });

  it('does not claim a chat that already waits', async () => {
    await handleChatOutage(await chat(), OVERLOADED);
    await handleChatOutage(await chat(), OVERLOADED);
    expect((await chat()).limitCount).toBe(1);
    expect(suspendTimers).toHaveLength(1);
  });

  it('suspends the box when the delayed timer fires', async () => {
    await handleChatOutage(await chat(), OVERLOADED);
    suspendTimers[0]();
    await vi.waitFor(() => expect(fleet.suspendSandbox).toHaveBeenCalledWith('box'));
    await vi.waitFor(() => expect(meterWorkbenchSuspended).toHaveBeenCalledWith({ workspaceId: 'ws', sandboxId: 'box' }, expect.any(Date)));
  });
});

describe('suspendAfterOutage', () => {
  async function waitingVersion(): Promise<number> {
    await handleChatOutage(await chat(), OVERLOADED);
    return (await chat()).resumeVersion;
  }

  it('suspends an idle box and stops its meter', async () => {
    expect(await suspendAfterOutage('wb', 'chat', await waitingVersion())).toBe(true);
    expect(fleet.suspendSandbox).toHaveBeenCalledWith('box');
    expect(meterWorkbenchSuspended).toHaveBeenCalledOnce();
  });

  it.each(['busy', 'starting', 'suspended'])('leaves a %s box alone', async (status) => {
    fleet.getSandbox.mockResolvedValue({ sandbox: { id: 'box', status }, terminal: false });
    expect(await suspendAfterOutage('wb', 'chat', await waitingVersion())).toBe(false);
    expect(fleet.suspendSandbox).not.toHaveBeenCalled();
  });

  it('leaves the box alone when the person cancelled the wait', async () => {
    const version = await waitingVersion();
    await updateChat('chat', { resumeAt: null, resumeVersion: version + 1 });
    expect(await suspendAfterOutage('wb', 'chat', version)).toBe(false);
    expect(fleet.getSandbox).not.toHaveBeenCalled();
  });

  it('leaves the box alone while another chat runs a turn', async () => {
    const version = await waitingVersion();
    await testDb.db.insert(workbenchChats).values({
      id: 'other', workbenchId: 'wb', workspaceId: 'ws', title: 'Other', agent: 'claude', status: 'running', turnCount: 1,
    });
    expect(await suspendAfterOutage('wb', 'chat', version)).toBe(false);
    expect(fleet.suspendSandbox).not.toHaveBeenCalled();
  });

  it('leaves a box that already sleeps alone', async () => {
    const version = await waitingVersion();
    await testDb.pglite.query(`update workbenches set sandbox_state = 'suspended' where id = 'wb'`);
    expect(await suspendAfterOutage('wb', 'chat', version)).toBe(false);
    expect(fleet.getSandbox).not.toHaveBeenCalled();
  });
});

describe('the sweep after the wait', () => {
  it('wakes the chat on the same agent with the outage resume message', async () => {
    await handleChatOutage(await chat(), OVERLOADED);
    const version = (await chat()).resumeVersion;
    await updateChat('chat', { resumeAt: new Date(Date.now() - 1_000) });
    expect(await sweepChatLimits()).toBe(1);
    expect(sendMessage).toHaveBeenCalledWith('chat', { text: outageResumeMessage(OVERLOADED) }, { origin: 'talyn', resumeVersion: version });
    expect(await chat()).toMatchObject({ agent: 'claude', status: 'running', resumeAt: null });
  });

  it('waits again without a count when the plan refuses the box', async () => {
    vi.mocked(existingBoxRefusal).mockResolvedValue(new UsageExhaustedError({ tier: 'free', periodEnd: new Date(Date.now() + 60 * 60_000) }));
    await handleChatOutage(await chat(), OVERLOADED);
    await updateChat('chat', { resumeAt: new Date(Date.now() - 1_000) });
    await sweepChatLimits();
    expect(sendMessage).not.toHaveBeenCalled();
    const waiting = await chat();
    expect(waiting.limitCount).toBe(1);
    expect(waiting.resumeAt).not.toBeNull();
  });
});
