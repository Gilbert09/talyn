import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { workbenchTurnPrompt } from '@talyn/shared';
import { claudeTurnLines, FakeFleet } from './helpers/fakeFleet.js';
import * as moves from '../services/workbenches/move.js';
import * as changes from '../services/workbenches/changes.js';
import * as prLink from '../services/workbenches/prLink.js';
import * as instructions from '../services/workbenches/instructions.js';
import * as title from '../services/workbenches/title.js';
import { LAUNCH_FAILED_MESSAGE, sendMessage, setTurnRetryDelaysForTests } from '../services/workbenches/turns.js';
import * as turns from '../services/workbenches/turns.js';
import * as sandboxRun from '../services/selfHosted/sandboxRun.js';
import { FleetRunNotFoundError } from '../services/selfHosted/client.js';
import { beginWorkbenchDrain, resetWorkbenchDrainForTests } from '../services/workbenches/ownership.js';
import * as scriptRunner from '../services/workbenches/scripts.js';
import { provisionWorkbench, restoreWorkbench } from '../services/workbenches/lifecycle.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workbenchAgentBackups as backups, workbenchChats as chats, workbenches, workspaces } from '../db/schema.js';
import { debugBus } from '../services/debugBus.js';
import {
  BACKUP_CHUNK_BYTES, BACKUP_METADATA_COLUMNS, backupAgentSession, backupLocateScript,
  backupTotalsQuery, restoreAgentSession, scheduleAgentBackup, settleAgentBackupsForTests, claimPendingBackup, sweepAgentBackups,
} from '../services/workbenches/agentBackups.js';
import { clearRecoveryRecap, MAX_RECAP_BYTES, recoveryRecap } from '../services/workbenches/agentRecap.js';
import { MAX_IMPORTED_SESSION_BYTES, boxSessionPath } from '../services/workbenches/claudeImport.js';
import { AGENT_MEMORY_RECAP_NOTE, AGENT_MEMORY_RESTORED_NOTE, recordRecoveredTranscript, recoverLostSandbox } from '../services/workbenches/recovery.js';
import * as durable from '../services/workbenches/durableExec.js';
import * as runtime from '../services/workbenches/sandboxRuntime.js';
import { appendEvents, CHAT_COLUMNS, getChat, getWorkbench, insertChat, insertWorkbench, listEvents, updateChat, updateWorkbench } from '../services/workbenches/store.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const digest = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
const message = (role: string, text: string) => ({ type: role, message: { role, content: [{ type: 'text', text }] } });

describe('agent memory backups', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let source: Buffer;
  let reportedSize: number | undefined;
  let sourcePath: string;
  let wrongSha: boolean;
  let ranges: Array<{ offset: number; length: number }>;
  let restored: Buffer[];
  let scripts: string[];
  let envs: Array<Record<string, string> | undefined>;

  beforeAll(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Test' });
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'o/r', url: 'https://github.com/o/r' });
  });

  afterAll(async () => { await testDb.cleanup(); });

  beforeEach(async () => {
    await testDb.db.delete(workbenches);
    await insertWorkbench({ id: 'wb', workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', name: 'test',
      branch: 'test', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
      sandboxId: 'box', sandboxState: 'running' });
    await insertChat({ id: 'chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Chat', agent: 'claude', agentSessionId: SESSION });
    source = Buffer.from('{"message":"hello"}\n');
    sourcePath = '/root/.claude/projects/-workspace-r/' + SESSION + '.jsonl';
    reportedSize = undefined;
    wrongSha = false;
    ranges = [];
    restored = [];
    scripts = [];
    envs = [];
    vi.spyOn(runtime, 'runCapture').mockImplementation(async (_wb, script, opts) => {
      scripts.push(script);
      envs.push(opts?.env);
      let stdout = '';
      if (script.includes('stat -c %s -- "$f"')) stdout = `${sourcePath}\n${reportedSize ?? source.length}\n`;
      else if (script.includes('git commit-tree')) stdout = 'a'.repeat(40);
      else if (script.includes('tail -c +')) {
        const [, offset, length] = /tail -c \+(\d+)[^\n]+head -c (\d+)/.exec(script)!;
        const start = Number(offset) - 1;
        ranges.push({ offset: start, length: Number(length) });
        const raw = source.subarray(start, start + Number(length));
        stdout = `${wrongSha ? '0'.repeat(64) : digest(raw)}\n${gzipSync(raw).toString('base64')}\n`;
      }
      for (const [name, data] of Object.entries(opts?.env ?? {})) {
        if (name.startsWith('TALYN_F')) restored.push(Buffer.from(data, 'base64'));
      }
      return { exitCode: 0, stdout, stderr: '', stdoutBytes: Buffer.from(stdout) };
    });
    vi.spyOn(debugBus, 'recordEvent');
  });

  afterEach(async () => {
    await settleAgentBackupsForTests();
    resetWorkbenchDrainForTests();
    vi.restoreAllMocks();
  });

  const rows = () => testDb.db.select({ ...BACKUP_METADATA_COLUMNS, data: backups.data }).from(backups).orderBy(backups.seq);
  const state = async () => (await testDb.db.select({ backup: chats.agentBackup, pending: chats.recapPending })
    .from(chats).where(eq(chats.id, 'chat')))[0];

  it('appends only new bytes and computes the stored size in SQL', async () => {
    const first = source.length;
    await backupAgentSession('chat');
    source = Buffer.concat([source, Buffer.from('{"message":"next"}\n')]);
    await backupAgentSession('chat');
    await backupAgentSession('chat');
    expect(ranges).toEqual([{ offset: 0, length: first }, { offset: first, length: source.length - first }]);
    expect(Buffer.concat((await rows()).map((row) => gunzipSync(row.data)))).toEqual(source);
    expect(await backupTotalsQuery('chat', SESSION)).toEqual([{ bytes: source.length, nextSeq: 2 }]);
    expect(envs.every((env) => env?.TMPDIR === '/dev/shm')).toBe(true);
  });

  it('backs up a second turn that finishes while a backup is active', async () => {
    const capture = vi.mocked(runtime.runCapture).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reading = false;
    vi.mocked(runtime.runCapture).mockImplementation(async (...args) => {
      const result = await capture(...args);
      if (!reading && args[1].includes('tail -c +')) {
        reading = true;
        await gate;
      }
      return result;
    });
    const first = backupAgentSession('chat');
    await vi.waitFor(() => expect(reading).toBe(true));
    source = Buffer.concat([source, Buffer.from('next turn\n')]);
    const second = backupAgentSession('chat');
    release();
    await Promise.all([first, second]);
    expect(Buffer.concat((await rows()).map((row) => gunzipSync(row.data)))).toEqual(source);
  });

  it('keeps the recap when the agent cannot start', async () => {
    await updateChat('chat', { agentSessionId: null, recapPending: true, turnCount: 1 });
    vi.spyOn(moves, 'needsFreshGolden').mockResolvedValue(false);
    vi.spyOn(runtime, 'refreshSandboxCredentials').mockResolvedValue({ accountId: null, note: null });
    vi.spyOn(runtime, 'startAccountWatch').mockReturnValue(() => undefined);
    vi.spyOn(instructions, 'syncInstructionFiles').mockResolvedValue(undefined);
    vi.spyOn(changes, 'refreshDiffStat').mockImplementation(async (row) => row);
    vi.spyOn(prLink, 'linkPullRequest').mockImplementation(async (row) => row);
    vi.spyOn(durable, 'startDurableExec').mockRejectedValue(new Error('The agent did not start.'));
    setTurnRetryDelaysForTests([0]);
    try {
      await sendMessage('chat', { text: 'continue' });
      await vi.waitFor(async () => expect((await getChat('chat'))?.status).toBe('error'), { timeout: 5000 });
      expect((await getChat('chat'))?.statusMessage).toContain(LAUNCH_FAILED_MESSAGE);
      expect((await state()).pending).toBe(true);
    } finally { setTurnRetryDelaysForTests(null); }
  });

  it('starts backups after real turns without waiting, and sends the recap only once', async () => {
    await updateChat('chat', { agentSessionId: null, recapPending: true, turnCount: 1 });
    await appendEvents('chat', [{ turn: 1, event: message('user', 'EARLIER REQUEST') }]);
    vi.spyOn(moves, 'needsFreshGolden').mockResolvedValue(false);
    vi.spyOn(runtime, 'refreshSandboxCredentials').mockResolvedValue({ accountId: null, note: null });
    vi.spyOn(runtime, 'startAccountWatch').mockReturnValue(() => undefined);
    vi.spyOn(instructions, 'syncInstructionFiles').mockResolvedValue(undefined);
    vi.spyOn(title, 'startTitleGeneration').mockReturnValue(undefined);
    vi.spyOn(changes, 'refreshDiffStat').mockImplementation(async (row) => row);
    vi.spyOn(prLink, 'linkPullRequest').mockImplementation(async (row) => row);
    const prompts: string[] = [];
    vi.spyOn(durable, 'startDurableExec').mockImplementation(async (_row, _key, _marker, script) => { prompts.push(script); });
    vi.spyOn(durable, 'followDurableBatches').mockImplementation(async (_row, _key, _marker, _offset, onRecord) => {
      let offset = 0;
      for (const line of claudeTurnLines(SESSION, 'done')) {
        const record = { stream: 'stdout' as const, line };
        offset += Buffer.byteLength(JSON.stringify(record) + '\n');
        await onRecord([{ record, offset }]);
      }
      return { exitCode: 0, stderrTail: '' };
    });
    const capture = vi.mocked(runtime.runCapture).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reading = false;
    vi.mocked(runtime.runCapture).mockImplementation(async (...args) => {
      if (args[1].includes('stat -c %s -- "$f"')) {
        reading = true;
        await gate;
      }
      return capture(...args);
    });
    try {
      await sendMessage('chat', { text: 'continue' });
      await vi.waitFor(async () => {
        expect((await getChat('chat'))?.status).toBe('idle');
        expect(reading).toBe(true);
      });
      expect(await rows()).toHaveLength(0);
      expect(prompts[0]).toContain('EARLIER REQUEST');
      expect((await state()).pending).toBe(false);
      await sendMessage('chat', { text: 'next' });
      await vi.waitFor(async () => {
        expect((await getChat('chat'))?.status).toBe('idle');
        expect(prompts).toHaveLength(2);
      });
      expect(prompts[1]).not.toContain('EARLIER REQUEST');
      expect((await listEvents('chat', 0, 50)).events.filter((event) => event.turn > 1)
        .some((event) => JSON.stringify(event.event).includes('EARLIER REQUEST'))).toBe(false);
    } finally {
      release();
      await settleAgentBackupsForTests();
    }
    expect(await rows()).toHaveLength(1);
  });

  it('resets the ranges when the file shrinks', async () => {
    await backupAgentSession('chat');
    source = Buffer.from('short\n');
    await backupAgentSession('chat');
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ seq: 0, startOffset: 0, byteLen: source.length });
    expect(gunzipSync((await rows())[0].data)).toEqual(source);
  });

  it('rejects a checksum mismatch without storing bytes', async () => {
    wrongSha = true;
    await expect(backupAgentSession('chat')).rejects.toThrow('checksum');
    expect(await rows()).toHaveLength(0);
  });

  it('stops above the cap and records that once', async () => {
    await backupAgentSession('chat');
    reportedSize = MAX_IMPORTED_SESSION_BYTES + 1;
    await backupAgentSession('chat');
    await backupAgentSession('chat');
    expect(ranges).toHaveLength(1);
    expect(vi.mocked(debugBus.recordEvent).mock.calls.filter(([event]) => event.action === 'agent_backup_limit')).toHaveLength(1);
    expect((await state()).backup?.capped).toBe(true);
    expect(await restoreAgentSession((await getWorkbench('wb'))!, (await getChat('chat'))!)).toBe(false);
  });

  it('resumes after compaction reduces a capped conversation', async () => {
    await backupAgentSession('chat');
    reportedSize = MAX_IMPORTED_SESSION_BYTES + 1;
    await backupAgentSession('chat');
    source = Buffer.from('small\n');
    reportedSize = undefined;
    await backupAgentSession('chat');
    expect((await state()).backup?.capped).toBe(false);
    expect(await rows()).toHaveLength(1);
    expect(gunzipSync((await rows())[0].data)).toEqual(source);
  });

  it('does not store late chunks from a replaced sandbox', async () => {
    const capture = vi.mocked(runtime.runCapture).getMockImplementation()!;
    vi.mocked(runtime.runCapture).mockImplementation(async (...args) => {
      const result = await capture(...args);
      if (args[1].includes('tail -c +')) await updateWorkbench('wb', { sandboxId: 'replacement', status: 'provisioning' });
      return result;
    });
    await backupAgentSession('chat');
    expect(await rows()).toHaveLength(0);
  });

  it('detaches failures and gives the debug bus the error object', async () => {
    const error = new Error('box offline', { cause: new Error('connection reset') });
    vi.mocked(runtime.runCapture).mockRejectedValue(error);
    await testDb.db.update(chats).set({ agentBackupPending: true });
    expect(scheduleAgentBackup('chat')).toBeUndefined();
    await settleAgentBackupsForTests();
    await vi.waitFor(() => expect(debugBus.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ error })));
  });

  it.each(['claude', 'codex'])('restores exact bytes and keeps the %s session ID', async (agent) => {
    await updateChat('chat', { agent });
    if (agent === 'codex') sourcePath = `/root/.codex/sessions/2026/10/27/rollout-date-${SESSION}.jsonl`;
    source = Buffer.concat([Buffer.alloc(BACKUP_CHUNK_BYTES, 0x61), Buffer.from('🙂 final\n')]);
    await backupAgentSession('chat');
    await recordRecoveredTranscript((await getWorkbench('wb'))!);
    expect(Buffer.concat(restored)).toEqual(source);
    expect((await getChat('chat'))?.agentSessionId).toBe(SESSION);
    expect((await state()).pending).toBe(false);
    const note = (await listEvents('chat', 0, 10)).events[0].event.text;
    expect(note).toContain(AGENT_MEMORY_RESTORED_NOTE);
    const install = scripts.find((script) => script.includes('\ncp '));
    expect(install).toContain(agent === 'codex' ? sourcePath : boxSessionPath(runtime.repoDirFor((await getWorkbench('wb'))!), SESSION).slice(2));
    expect(scripts.filter((script) => script.includes('cat ') && script.includes('/part') && script.includes('>>'))).toHaveLength(2);
  });

  it.each(['missing', 'checksum', 'gap', 'incomplete', 'gzip'])('clears an unusable %s backup and enables the recap', async (failure) => {
    if (failure !== 'missing') {
      await backupAgentSession('chat');
      if (failure === 'checksum') await testDb.db.update(backups).set({ sha256: '0'.repeat(64) });
      if (failure === 'gap') await testDb.db.update(backups).set({ startOffset: 1 });
      if (failure === 'incomplete') await testDb.db.update(backups).set({ byteLen: source.length - 1 });
      if (failure === 'gzip') await testDb.db.update(backups).set({ data: Buffer.from('invalid') });
    }
    await recordRecoveredTranscript((await getWorkbench('wb'))!);
    expect((await getChat('chat'))?.agentSessionId).toBeNull();
    expect((await state()).pending).toBe(true);
    expect((await listEvents('chat', 0, 10)).events[0].event.text).toContain(AGENT_MEMORY_RECAP_NOTE);
    expect(scripts.some((script) => script.includes('\ncp '))).toBe(false);
  });

  it.each(['lost', 'archive'])('restores through the %s lifecycle before queued turns start', async (kind) => {
    await backupAgentSession('chat');
    await updateChat('chat', { queuedMessages: [{ id: 'queued', text: 'continue', queuedAt: new Date().toISOString() }] });
    const fleet = new FakeFleet();
    vi.spyOn(sandboxRun, 'resolveSandboxCredentials').mockResolvedValue({ ok: true, creds: { claudeToken: 'test' }, githubToken: 'test' });
    vi.spyOn(sandboxRun, 'resolveRepository').mockResolvedValue({ slug: 'o/r', defaultBranch: 'main' });
    vi.spyOn(sandboxRun, 'buildSandboxCreateBody').mockImplementation(async (input) => ({ ok: true, body: { id: input.id, workspaceId: input.workspaceId } }));
    vi.spyOn(runtime, 'fleetCreateTarget').mockResolvedValue({ client: fleet.asClient() });
    vi.spyOn(runtime, 'loadWorkbenchConfig').mockResolvedValue(null);
    vi.spyOn(changes, 'refreshDiffStat').mockImplementation(async (row) => row);
    vi.spyOn(prLink, 'linkPullRequest').mockImplementation(async (row) => row);
    const start = vi.spyOn(turns, 'startQueuedIfIdle').mockImplementation(async () => {
      expect(Buffer.concat(restored)).toEqual(source);
      expect(scripts.some((script) => script.includes('\ncp '))).toBe(true);
      expect((await getChat('chat'))?.agentSessionId).toBe(SESSION);
      return true;
    });
    if (kind === 'lost') await recoverLostSandbox((await getWorkbench('wb'))!, new FleetRunNotFoundError('gone'));
    else {
      await updateWorkbench('wb', { archivedAt: new Date(), status: 'archived' });
      await restoreWorkbench('wb');
    }
    await vi.waitFor(async () => {
      expect((await getWorkbench('wb'))?.status).toBe('ready');
      expect(start).toHaveBeenCalledOnce();
    });
    expect((await getWorkbench('wb'))?.memoryRestorePending).toBeNull();
    expect((await getChat('chat'))?.agentSessionId).toBe(SESSION);
  });

  it('adds the memory outcome for an archived session', async () => {
    await backupAgentSession('chat');
    await recordRecoveredTranscript((await getWorkbench('wb'))!, true);
    expect((await listEvents('chat', 0, 10)).events[0].event).toMatchObject({
      subtype: 'sandbox_restored', text: `This session was restored onto a new sandbox. ${AGENT_MEMORY_RESTORED_NOTE}`,
    });
  });

  it.each(['changed', 'cleared', 'deleted'])('removes rows when the session is %s, including direct database writes', async (change) => {
    await backupAgentSession('chat');
    if (change === 'deleted') await testDb.db.delete(chats).where(eq(chats.id, 'chat'));
    else await testDb.db.update(chats).set({ agentSessionId: change === 'cleared' ? null : 'different' }).where(eq(chats.id, 'chat'));
    expect(await rows()).toHaveLength(0);
    if (change !== 'deleted') expect((await state()).backup).toBeNull();
  });

  it('rejects late chunks after a session ID changes', async () => {
    const capture = vi.mocked(runtime.runCapture).getMockImplementation()!;
    vi.mocked(runtime.runCapture).mockImplementation(async (...args) => {
      const result = await capture(...args);
      if (args[1].includes('tail -c +')) await updateChat('chat', { agentSessionId: 'different' });
      return result;
    });
    await backupAgentSession('chat');
    expect(await rows()).toHaveLength(0);
  });

  it('keeps listing and turn projections free of backup data', () => {
    const queries = [
      testDb.db.select(CHAT_COLUMNS).from(chats),
      testDb.db.select(BACKUP_METADATA_COLUMNS).from(backups),
      backupTotalsQuery('chat', SESSION),
    ];
    for (const query of queries) expect(query.toSQL().sql).not.toContain('"data"');
    expect(backupTotalsQuery('chat', SESSION).toSQL().sql).toContain('sum(');
    expect(testDb.db.select(CHAT_COLUMNS).from(chats).toSQL().sql).not.toContain('agent_backup');
  });

  it('finds Codex rollouts under CODEX_HOME and rejects invalid session IDs', async () => {
    const wb = (await getWorkbench('wb'))!;
    const chat = (await getChat('chat'))!;
    expect(backupLocateScript(wb, { ...chat, agent: 'codex' })).toContain('${CODEX_HOME:-$HOME/.codex}/sessions');
    expect(() => backupLocateScript(wb, { ...chat, agentSessionId: '../bad' })).toThrow('Invalid');
  });

  it('keeps the newest whole messages, excludes tools, and consumes the recap once', async () => {
    await updateChat('chat', { recapPending: true });
    await appendEvents('chat', [
      { turn: 1, event: message('user', 'oldest '.repeat(3000)) },
      { turn: 1, event: message('assistant', 'middle '.repeat(1000)) },
      { turn: 2, event: { type: 'assistant', message: { content: [{ type: 'tool_use', input: 'SECRET TOOL INPUT' }, { type: 'text', text: 'recent answer' }] } } },
      { turn: 2, event: { type: 'user', message: { content: [{ type: 'tool_result', content: 'SECRET TOOL OUTPUT' }] } } },
      { turn: 2, event: message('user', 'newest 🙂') },
      { turn: 3, event: message('user', 'CURRENT TURN') },
    ]);
    const recap = (await recoveryRecap('chat', 3))!;
    expect(Buffer.byteLength(recap)).toBeLessThanOrEqual(MAX_RECAP_BYTES);
    expect(recap).not.toMatch(/oldest|SECRET|CURRENT TURN/);
    expect(recap).toContain('middle');
    expect(recap.indexOf('middle')).toBeLessThan(recap.indexOf('recent answer'));
    expect(recap.endsWith('User: newest 🙂')).toBe(true);
    for (const agent of ['claude', 'codex'] as const) {
      const prompt = workbenchTurnPrompt({ agent, text: 'continue', planMode: false,
        createPr: { branch: 'b', baseBranch: 'main' }, autoCreatePr: false, recap });
      expect(agent === 'claude' ? prompt.appendSystemPrompt : prompt.prompt).toContain(recap);
      if (agent === 'claude') expect(prompt.prompt).toBe('continue');
    }
    await clearRecoveryRecap('chat');
    expect(await recoveryRecap('chat', 4)).toBeUndefined();
  });

  it('bounds an oversized newest message without cutting it', async () => {
    await updateChat('chat', { recapPending: true });
    await appendEvents('chat', [{ turn: 1, event: message('user', '🙂'.repeat(MAX_RECAP_BYTES)) }]);
    const recap = (await recoveryRecap('chat', 2))!;
    expect(Buffer.byteLength(recap)).toBeLessThan(MAX_RECAP_BYTES);
    expect(recap).not.toContain('🙂');
  });

  it('does not mix chats in a recap', async () => {
    await insertChat({ id: 'other', workbenchId: 'wb', workspaceId: 'ws', title: 'Other', agent: 'claude' });
    await appendEvents('other', [{ turn: 1, event: message('user', 'OTHER CHAT') }]);
    await updateChat('chat', { recapPending: true });
    expect(await recoveryRecap('chat', 2)).not.toContain('OTHER CHAT');
    expect(await testDb.db.select({ seq: backups.seq }).from(backups)
      .where(and(eq(backups.chatId, 'other'), eq(backups.sessionId, SESSION)))).toEqual([]);
  });
  it('claims backups once and skips a leased row', async () => {
    await testDb.db.update(chats).set({ agentBackupPending: true });
    const claims = await Promise.all([claimPendingBackup(), claimPendingBackup()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimPendingBackup()).toBeNull();
  });
  it('backs off failed rows and clears the flag after a successful post-turn backup', async () => {
    await testDb.db.update(chats).set({ agentBackupPending: true });
    scheduleAgentBackup('chat');
    await settleAgentBackupsForTests();
    const pending = async () => (await testDb.db.select({ pending: chats.agentBackupPending, retry: chats.backupRetryAt,
      failures: chats.backupFailures, lease: chats.backupLeaseUntil }).from(chats))[0];
    expect((await pending()).pending).toBe(false);
    const count = scripts.length;
    await sweepAgentBackups();
    expect(scripts).toHaveLength(count);
    await testDb.db.update(chats).set({ agentBackupPending: true });
    vi.mocked(runtime.runCapture).mockRejectedValue(new Error('offline'));
    await sweepAgentBackups();
    expect(await pending()).toMatchObject({ pending: true, retry: expect.any(Date), failures: 1, lease: null });
    expect(await claimPendingBackup()).toBeNull();
  });

  it('leaves a draining provision for the next instance to resume', async () => {
    await updateWorkbench('wb', { status: 'provisioning' });
    const fleet = new FakeFleet();
    vi.spyOn(sandboxRun, 'resolveSandboxCredentials').mockResolvedValue({ ok: true, creds: { claudeToken: 'test' }, githubToken: 'test' });
    vi.spyOn(sandboxRun, 'resolveRepository').mockResolvedValue({ slug: 'o/r', defaultBranch: 'main' });
    vi.spyOn(sandboxRun, 'buildSandboxCreateBody').mockImplementation(async (input) => ({ ok: true, body: { id: input.id, workspaceId: input.workspaceId } }));
    vi.spyOn(runtime, 'fleetCreateTarget').mockResolvedValue({ client: fleet.asClient() });
    vi.spyOn(changes, 'refreshDiffStat').mockImplementation(async (row) => row);
    vi.spyOn(prLink, 'linkPullRequest').mockImplementation(async (row) => row);
    const config = { setup: { command: 'setup' }, run: [], runMode: 'nonconcurrent' as const, source: 'none' as const, filesToCopy: [], errors: [] };
    const load = vi.spyOn(runtime, 'loadWorkbenchConfig').mockImplementation(async () => { beginWorkbenchDrain(); return config; });
    const setup = vi.spyOn(scriptRunner, 'startScript').mockResolvedValue({ done: Promise.resolve(0) });
    await provisionWorkbench('wb');
    expect((await getWorkbench('wb'))?.status).toBe('provisioning');
    expect(setup).not.toHaveBeenCalled();
    const generation = (await getWorkbench('wb'))?.sandboxGeneration;
    resetWorkbenchDrainForTests();
    load.mockResolvedValue(config);
    await provisionWorkbench('wb');
    expect((await getWorkbench('wb'))?.status).toBe('ready');
    expect((await getWorkbench('wb'))?.sandboxGeneration).toBe(generation);
    expect(setup).toHaveBeenCalledTimes(1);
  });

});
