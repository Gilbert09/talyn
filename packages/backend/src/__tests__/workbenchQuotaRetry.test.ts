import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn } from './helpers/fakeFleet.js';
import { repositories, workbenchChats, workbenchEvents, workbenches, workspaces } from '../db/schema.js';

vi.mock('../services/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/github.js')>();
  return { ...actual, githubService: { ...actual.githubService, getVerifiedAccessToken: vi.fn(async () => 'gh-token') } };
});
vi.mock('../services/mcpServers/dispatch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mcpServers/dispatch.js')>()),
  mcpIntegrationSecrets: vi.fn(async () => ({})),
}));

const { addFleetAccount, getFleetAccount, setFleetAccountUsage } = await import('../services/selfHosted/accounts.js');
const { encryptString } = await import('../services/tokenCrypto.js');
const { setWorkbenchFleetClientForTests } = await import('../services/workbenches/sandboxRuntime.js');
const { getChat, getWorkbench } = await import('../services/workbenches/store.js');
const store = await import('../services/workbenches/store.js');
const { durablePaths } = await import('../services/workbenches/durableExec.js');
const { sendMessage, sweepOrphanedTurns, turnLogKey } = await import('../services/workbenches/turns.js');

describe('workbench quota retry', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner' });
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'owner', name: 'Workspace' });
    await testDb.db.insert(repositories).values({
      id: 'repo', workspaceId: 'ws', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main',
    });
    fleet = new FakeFleet();
    fleet.handler = (script) => script.includes('git commit-tree')
      ? { stdout: `${'c'.repeat(40)}\n` }
      : { exitCode: 0, stdout: '' };
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
  });

  afterEach(async () => {
    setWorkbenchFleetClientForTests(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await testDb.cleanup();
  });

  async function addAccount(agent: 'claude' | 'codex', label: string) {
    const account = await addFleetAccount('ws', {
      kind: agent === 'claude' ? 'anthropic_key' : 'openai_key',
      label,
      credential: { keyEnc: encryptString(`token-${label}`) },
    });
    await setFleetAccountUsage(account.id, {
      fetchedAt: new Date().toISOString(),
      windows: [{ key: 'session', label: '5-hour', usedPercent: 1, resetsAt: null }],
    });
    return account;
  }

  async function seedChat(agent: 'claude' | 'codex') {
    await testDb.db.insert(workbenches).values({
      id: 'wb', workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'acme/app', name: 'wb',
      branch: 'tom/test', baseBranch: 'main', runtime: 'sandbox', agent,
      sandboxId: 'talyn-wb-test', sandboxState: 'running', status: 'ready',
      settings: { autoCreatePr: false },
    });
    await testDb.db.insert(workbenchChats).values({
      id: 'chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Test', agent, turnCount: 1,
    });
  }

  it.each([
    ['Claude rate limit', 'claude', "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.", true, false, 'idle', 'hit its rate limit'],
    ['Claude exhausted quota', 'claude', "You're out of extra usage.", true, false, 'idle', 'ran out of usage'],
    ['no second account', 'claude', "API Error: Request rejected (429) · This request would exceed your account's rate limit.", false, false, 'error', null],
    ['retry also fails', 'claude', "API Error: Request rejected (429) · This request would exceed your account's rate limit.", true, true, 'error', 'hit its rate limit'],
    ['unrelated error', 'claude', 'Error: invalid API key', true, false, 'error', null],
    ['Codex rate limit', 'codex', 'You have hit your ChatGPT usage limit. Try again later.', true, false, 'idle', 'hit its rate limit'],
  ] as const)('%s', async (_name, agent, failure, second, retryFails, status, note) => {
    const first = await addAccount(agent, 'First');
    const other = second ? await addAccount(agent, 'Second') : null;
    await seedChat(agent);
    if (failure.includes('out of extra usage')) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: { message: failure } }), { status: 400 }),
      );
    }
    let runs = 0;
    fleet.handler = (script) => {
      if (!isAgentTurn(script, agent)) {
        return script.includes('git commit-tree') ? { stdout: `${'c'.repeat(40)}\n` } : { exitCode: 0, stdout: '' };
      }
      runs++;
      const failed = runs === 1 || retryFails;
      const text = failed ? failure : 'done';
      if (agent === 'codex') {
        return {
          stdout: [JSON.stringify(failed
            ? { type: 'turn.failed', error: { message: text } }
            : { type: 'turn.completed', usage: {} })],
          exitCode: failed ? 1 : 0,
        };
      }
      return {
        stdout: claudeTurnLines('sess', text).map((line) => failed
          ? line.replace('"subtype":"success"', '"subtype":"error_during_execution"').replace('"is_error":false', '"is_error":true')
          : line),
        exitCode: failed ? 1 : 0,
      };
    };

    await sendMessage('chat', { text: 'go' });
    await vi.waitFor(async () => expect((await getChat('chat'))?.status).toBe(status), { timeout: 5000 });
    expect(runs).toBe(note ? 2 : 1);
    const scripts = fleet.execs.filter((entry) => isAgentTurn(entry.script, agent)).map((entry) => entry.script);
    if (note) expect(scripts[1]).toBe(scripts[0]);
    const rows = await testDb.db.select().from(workbenchEvents).where(eq(workbenchEvents.chatId, 'chat'));
    const events = rows.map((row) => row.event);
    expect(events.filter((e) => e.type === 'user' && (e.talyn as { kind?: string } | undefined)?.kind === 'user_message')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'result')).toHaveLength(runs);
    const notes = events.filter((e) => e.subtype === 'fleet_account_switched');
    expect(notes).toHaveLength(note ? 1 : 0);
    if (note) {
      expect(notes[0].text).toContain(note);
      expect(notes[0].text).toContain('First');
      expect(notes[0].text).toContain('Second');
      expect((await getWorkbench('wb'))?.settings?.fleetAccountId).toBe(other?.id);
      expect(fleet.credentialPushes.at(-1)?.creds).toMatchObject(agent === 'codex'
        ? { openaiKey: 'token-Second' }
        : { anthropicKey: 'token-Second' });
    } else {
      expect((await getWorkbench('wb'))?.settings?.fleetAccountId).toBe(first.id);
    }
    expect((await getFleetAccount(first.id))?.quotaExhausted).toEqual(
      failure.includes('out of extra usage')
        ? expect.any(Object)
        : /rate limit|usage limit/.test(failure) ? expect.objectContaining({ kind: 'rate_limit' }) : null,
    );
  });

  it('starts the next turn on another account after a rate limit it could not move', async () => {
    const first = await addAccount('claude', 'First');
    await seedChat('claude');
    let runs = 0;
    fleet.handler = (script) => {
      if (!isAgentTurn(script, 'claude')) {
        return script.includes('git commit-tree') ? { stdout: `${'c'.repeat(40)}\n` } : { exitCode: 0, stdout: '' };
      }
      runs++;
      const failed = runs === 1;
      return {
        stdout: claudeTurnLines('sess', failed ? "API Error: Request rejected (429) · This request would exceed your account's rate limit." : 'done').map((line) => failed
          ? line.replace('"subtype":"success"', '"subtype":"error_during_execution"').replace('"is_error":false', '"is_error":true')
          : line),
        exitCode: failed ? 1 : 0,
      };
    };
    await sendMessage('chat', { text: 'go' });
    await vi.waitFor(async () => expect((await getChat('chat'))?.status).toBe('error'), { timeout: 5000 });
    expect((await getFleetAccount(first.id))?.quotaExhausted).toMatchObject({ kind: 'rate_limit' });

    const other = await addAccount('claude', 'Second');
    await sendMessage('chat', { text: 'again' });
    await vi.waitFor(async () => expect((await getChat('chat'))?.status).toBe('idle'), { timeout: 5000 });
    const rows = await testDb.db.select().from(workbenchEvents).where(eq(workbenchEvents.chatId, 'chat'));
    const notes = rows.map((row) => row.event).filter((e) => e.subtype === 'fleet_account_switched');
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('Switched to Second because First hit its rate limit.');
    expect((await getWorkbench('wb'))?.settings?.fleetAccountId).toBe(other.id);
  });

  it.each([
    ['no reset named', { at: '2026-11-01T10:00:00.000Z' }, '2026-11-01T10:04:59.000Z', true],
    ['no reset named, after the window', { at: '2026-11-01T10:00:00.000Z' }, '2026-11-01T10:05:01.000Z', false],
    ['vendor reset later than the window', { at: '2026-11-01T10:00:00.000Z', resetsAt: '2026-11-01T12:00:00.000Z' }, '2026-11-01T11:59:00.000Z', true],
    ['vendor reset passed', { at: '2026-11-01T10:00:00.000Z', resetsAt: '2026-11-01T10:02:00.000Z' }, '2026-11-01T10:03:00.000Z', false],
  ] as const)('a rate limit hold: %s', async (_name, record, now, held) => {
    const { isHeldBack } = await import('../services/selfHosted/exhaustedQuota.js');
    expect(isHeldBack({ ...record, kind: 'rate_limit' }, new Date(now))).toBe(held);
  });
  it.each([
    ['rate limit', "API Error: Request rejected (429) · This request would exceed your account's rate limit.", 'hit its rate limit', true],
    ['unrelated error', 'Error: invalid API key', null, true],
    ['rate limit, no second account', "API Error: Request rejected (429) · This request would exceed your account's rate limit.", null, false],
  ] as const)('a turn adopted after a handoff: %s', async (_name, failure, note, second) => {
    const first = await addAccount('claude', 'First');
    const other = second ? await addAccount('claude', 'Second') : null;
    await seedChat('claude');
    await testDb.db.update(workbenches).set({ settings: { autoCreatePr: false, fleetAccountId: first.id } });
    await testDb.db.update(workbenchChats).set({ turnCount: 0 });
    await store.claimOrEnqueue('chat', { id: 'msg', text: 'work', queuedAt: new Date().toISOString() }, true);
    await testDb.db.update(workbenchChats).set({ turnOwner: 'instance-a', turnHeartbeatAt: new Date(0) });
    const failedLines = claudeTurnLines('sess', failure).map((line) =>
      line.replace('"subtype":"success"', '"subtype":"error_during_execution"').replace('"is_error":false', '"is_error":true'));
    // The old instance's agent already ran and ended on the limit.
    fleet.durableLogs.set(durablePaths(turnLogKey('chat', 1, 0)).log, { stdout: failedLines, exitCode: 1 });
    let runs = 0;
    const handler = fleet.handler;
    fleet.handler = (script, req) => {
      if (!isAgentTurn(script, 'claude')) return handler(script, req);
      runs++;
      return { stdout: claudeTurnLines('sess', 'done'), exitCode: 0 };
    };

    expect(await sweepOrphanedTurns()).toBe(1);
    await vi.waitFor(async () => expect((await getChat('chat'))?.status).toBe(note ? 'idle' : 'error'), { timeout: 5000 });
    expect(runs).toBe(note ? 1 : 0);
    const events = (await testDb.db.select().from(workbenchEvents).where(eq(workbenchEvents.chatId, 'chat'))).map((row) => row.event);
    const notes = events.filter((e) => e.subtype === 'fleet_account_switched');
    expect(notes).toHaveLength(note ? 1 : 0);
    if (note) {
      expect(notes[0].text).toContain(note);
      expect(notes[0].text).toContain('Second');
      expect((await getWorkbench('wb'))?.settings?.fleetAccountId).toBe(other?.id);
      expect(fleet.credentialPushes.at(-1)?.creds).toMatchObject({ anthropicKey: 'token-Second' });
    } else {
      expect((await getWorkbench('wb'))?.settings?.fleetAccountId).toBe(first.id);
    }
  });
});
