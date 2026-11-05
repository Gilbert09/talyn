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

const { addFleetAccount, setFleetAccountUsage } = await import('../services/selfHosted/accounts.js');
const { encryptString } = await import('../services/tokenCrypto.js');
const { setWorkbenchFleetClientForTests } = await import('../services/workbenches/sandboxRuntime.js');
const { appendEvents, getChat } = await import('../services/workbenches/store.js');
const { sendMessage, SESSION_RESET_NOTE } = await import('../services/workbenches/turns.js');
const { isResumeFailure } = await import('../services/workbenches/resumeFailure.js');

type Agent = 'claude' | 'codex';
interface Run { stdout?: string[]; stderr?: string; exitCode: number }

const RESUME_ERROR = 'Error: thread/resume: thread/resume failed: list_turns is not supported yet (code -32601)';

function codexLines(threadId: string, opts: { text?: string; failure?: string; errorEvent?: string } = {}): string[] {
  const lines: unknown[] = [{ type: 'thread.started', thread_id: threadId }, { type: 'turn.started' }];
  if (opts.errorEvent) lines.push({ type: 'error', message: opts.errorEvent });
  if (opts.text) lines.push({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: opts.text } });
  lines.push(opts.failure ? { type: 'turn.failed', error: { message: opts.failure } } : { type: 'turn.completed', usage: {} });
  return lines.map((line) => JSON.stringify(line));
}

function claudeFailedLines(sessionId: string, text: string, synthetic = false): string[] {
  return claudeTurnLines(sessionId, text).map((line) => {
    const failed = line.replace('"subtype":"success"', '"subtype":"error_during_execution"').replace('"is_error":false', '"is_error":true');
    return synthetic ? failed.replace('"role":"assistant"', '"role":"assistant","model":"<synthetic>"') : failed;
  });
}

const resumes = (script: string, agent: Agent) =>
  agent === 'codex' ? script.startsWith('codex exec resume ') : script.includes('--resume');

describe('workbench resume fallback', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;
  let agentScripts: string[];

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner' });
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'owner', name: 'Workspace' });
    await testDb.db.insert(repositories).values({
      id: 'repo', workspaceId: 'ws', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main',
    });
    fleet = new FakeFleet();
    agentScripts = [];
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
  });

  afterEach(async () => {
    setWorkbenchFleetClientForTests(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await testDb.cleanup();
  });

  async function seedChat(agent: Agent, agentSessionId: string | null) {
    const account = await addFleetAccount('ws', {
      kind: agent === 'claude' ? 'anthropic_key' : 'openai_key',
      label: 'Only',
      credential: { keyEnc: encryptString('token-only') },
    });
    await setFleetAccountUsage(account.id, {
      fetchedAt: new Date().toISOString(),
      windows: [{ key: 'session', label: '5-hour', usedPercent: 1, resetsAt: null }],
    });
    await testDb.db.insert(workbenches).values({
      id: 'wb', workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'acme/app', name: 'wb',
      branch: 'tom/test', baseBranch: 'main', runtime: 'sandbox', agent,
      sandboxId: 'talyn-wb-test', sandboxState: 'running', status: 'ready',
      settings: { autoCreatePr: false },
    });
    await testDb.db.insert(workbenchChats).values({
      id: 'chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Test', agent, turnCount: 1, agentSessionId,
    });
  }

  /** Each agent run answers with the next entry; the last one repeats. */
  function agentRuns(agent: Agent, runs: Run[]) {
    fleet.handler = (script) => {
      if (!isAgentTurn(script, agent)) {
        return script.includes('git commit-tree') ? { stdout: `${'c'.repeat(40)}\n` } : { exitCode: 0, stdout: '' };
      }
      agentScripts.push(script);
      const run = runs[Math.min(agentScripts.length - 1, runs.length - 1)];
      return { stdout: run.stdout ?? [], ...(run.stderr ? { stderr: run.stderr } : {}), exitCode: run.exitCode };
    };
  }

  async function turnEnds(status: 'idle' | 'error') {
    await vi.waitFor(async () => expect((await getChat('chat'))?.status).toBe(status), { timeout: 5000 });
  }

  async function storedEvents() {
    return (await testDb.db.select().from(workbenchEvents).where(eq(workbenchEvents.chatId, 'chat'))).map((row) => row.event);
  }

  describe('a session that cannot be resumed', () => {
    it.each([
      ['Codex thread/resume on stderr', 'codex', 'thread-dead', { stderr: RESUME_ERROR, exitCode: 1 }, 'thread-new'],
      ['Codex thread/resume as a JSON error', 'codex', 'thread-dead',
        { stdout: codexLines('thread-dead', { errorEvent: 'thread/resume failed: list_turns is not supported yet (code -32601)', failure: 'thread/resume failed' }), exitCode: 1 },
        'thread-new'],
      ['Codex no rollout found', 'codex', 'thread-dead', { stderr: 'Error: no rollout found for thread id thread-dead', exitCode: 1 }, 'thread-new'],
      ['Codex session id not found', 'codex', 'thread-dead', { stderr: 'Error: thread thread-dead not found', exitCode: 1 }, 'thread-new'],
      ['Claude no conversation found', 'claude', 'sess-dead', { stderr: 'No conversation found with session ID: sess-dead', exitCode: 1 }, 'sess-new'],
    ] as const)('%s: clears the id and runs once more in a new session', async (_name, agent, dead, failure, fresh) => {
      await seedChat(agent, dead);
      await appendEvents('chat', [
        { turn: 0, event: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'EARLIER QUESTION' }] } } },
        { turn: 0, event: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'EARLIER ANSWER' }] } } },
      ]);
      const success: Run = agent === 'codex'
        ? { stdout: codexLines(fresh, { text: 'done' }), exitCode: 0 }
        : { stdout: claudeTurnLines(fresh, 'done'), exitCode: 0 };
      agentRuns(agent, [failure, success]);

      await sendMessage('chat', { text: 'go' });
      await turnEnds('idle');

      expect(agentScripts).toHaveLength(2);
      expect(resumes(agentScripts[0], agent)).toBe(true);
      expect(agentScripts[0]).toContain(dead);
      expect(resumes(agentScripts[1], agent)).toBe(false);
      expect(agentScripts[1]).not.toContain(dead);
      // The new session gets a recap of the chat so far.
      expect(agentScripts[1]).toContain('could not be resumed');
      expect(agentScripts[1]).toContain('EARLIER ANSWER');
      const chat = (await getChat('chat'))!;
      expect(chat.agentSessionId).toBe(fresh);
      const [row] = await testDb.db.select({ pending: workbenchChats.recapPending }).from(workbenchChats).where(eq(workbenchChats.id, 'chat'));
      expect(row.pending).toBe(false);
      const notes = (await storedEvents()).filter((e) => e.subtype === 'agent_session_reset');
      expect(notes.map((e) => e.text)).toEqual([SESSION_RESET_NOTE]);
    });

    it('falls back only once, and says so when the chat has nothing to recap', async () => {
      await seedChat('codex', 'thread-dead');
      agentRuns('codex', [{ stderr: RESUME_ERROR, exitCode: 1 }, { stderr: 'Error: thread/resume failed: again', exitCode: 1 }]);

      await sendMessage('chat', { text: 'go' });
      await turnEnds('error');

      expect(agentScripts).toHaveLength(2);
      expect(resumes(agentScripts[1], 'codex')).toBe(false);
      expect(agentScripts[1]).toContain('could not be resumed');
      expect((await getChat('chat'))?.agentSessionId).toBeNull();
    });
  });

  describe('an ordinary failure on a resumed session', () => {
    it.each([
      ['Claude rate limit', 'claude', "API Error: Request rejected (429) · This request would exceed your account's rate limit."],
      ['Claude auth', 'claude', 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'],
      ['Codex usage limit', 'codex', 'You have hit your ChatGPT usage limit. Try again later.'],
      ['Codex auth', 'codex', 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header'],
      ['Codex auth inside a resume error', 'codex', 'thread/resume failed: unexpected status 401 Unauthorized'],
      ['Codex unrelated failure', 'codex', 'stream disconnected before completion'],
    ] as const)('%s: keeps the session id and does not run again', async (_name, agent, failure) => {
      const kept = agent === 'codex' ? 'thread-kept' : 'sess-kept';
      await seedChat(agent, kept);
      agentRuns(agent, [agent === 'codex'
        ? { stdout: codexLines(kept, { failure }), stderr: failure, exitCode: 1 }
        : { stdout: claudeFailedLines(kept, failure, true), exitCode: 1 }]);

      await sendMessage('chat', { text: 'go' });
      await turnEnds('error');

      expect(agentScripts).toHaveLength(1);
      expect((await getChat('chat'))?.agentSessionId).toBe(kept);
      expect((await storedEvents()).some((e) => e.subtype === 'agent_session_reset')).toBe(false);
    });
  });

  describe('which session id a turn stores', () => {
    it.each([
      ['a Codex turn that failed before any output', 'codex',
        { stdout: codexLines('thread-x', { failure: 'unexpected status 401 Unauthorized' }), exitCode: 1 }, 'error', null],
      ['a Claude turn that failed on an API error', 'claude',
        { stdout: claudeFailedLines('sess-x', 'API Error: 401 authentication_error', true), exitCode: 1 }, 'error', null],
      ['a productive Codex turn', 'codex', { stdout: codexLines('thread-x', { text: 'done' }), exitCode: 0 }, 'idle', 'thread-x'],
      ['a productive Claude turn', 'claude', { stdout: claudeTurnLines('sess-x', 'done'), exitCode: 0 }, 'idle', 'sess-x'],
      ['a Codex turn that answered and then failed', 'codex',
        { stdout: codexLines('thread-x', { text: 'halfway', failure: 'stream disconnected' }), exitCode: 1 }, 'error', 'thread-x'],
      ['a Claude turn that answered and then failed', 'claude',
        { stdout: claudeFailedLines('sess-x', 'halfway'), exitCode: 1 }, 'error', 'sess-x'],
    ] as const)('%s', async (_name, agent, run, status, stored) => {
      await seedChat(agent, null);
      agentRuns(agent, [run]);

      await sendMessage('chat', { text: 'go' });
      await turnEnds(status);

      expect(agentScripts).toHaveLength(1);
      expect((await getChat('chat'))?.agentSessionId ?? null).toBe(stored);
    });

    it('resumes the stored session on the next turn after a productive turn that was cut short', async () => {
      await seedChat('codex', null);
      agentRuns('codex', [
        { stdout: codexLines('thread-x', { text: 'halfway', failure: 'stream disconnected' }), exitCode: 1 },
        { stdout: codexLines('thread-x', { text: 'done' }), exitCode: 0 },
      ]);
      await sendMessage('chat', { text: 'go' });
      await turnEnds('error');
      await sendMessage('chat', { text: 'again' });
      await turnEnds('idle');

      expect(agentScripts).toHaveLength(2);
      expect(resumes(agentScripts[1], 'codex')).toBe(true);
      expect(agentScripts[1]).toContain('thread-x');
    });
  });
});

describe('isResumeFailure', () => {
  it.each([
    [RESUME_ERROR, 'thread-dead', true],
    ['thread/resume: {"code":-32601,"message":"Method not found"}', 'thread-dead', true],
    ['Error: no rollout found for thread id thread-dead', 'thread-dead', true],
    ['Error: thread thread-dead not found', 'thread-dead', true],
    ['No conversation found with session ID: sess-dead', 'sess-dead', true],
    ['some log line\nNo conversation found with session ID: sess-dead\n', 'sess-dead', true],
    ['File not found: src/app.ts', 'thread-dead', false],
    ['thread other-thread not found', 'thread-dead', false],
    ['thread/resume failed: unexpected status 401 Unauthorized', 'thread-dead', false],
    ["API Error: Request rejected (429) · This request would exceed your account's rate limit.", 'sess', false],
    ['You have hit your ChatGPT usage limit. Try again later.', 'thread', false],
    ['API Error: 401 authentication_error', 'sess', false],
    ['stream disconnected before completion', 'thread', false],
    ['', 'thread', false],
    [null, 'thread', false],
    [RESUME_ERROR, '', false],
  ] as const)('%j with session %j → %s', (detail, sessionId, expected) => {
    expect(isResumeFailure(detail, sessionId)).toBe(expected);
  });
});
