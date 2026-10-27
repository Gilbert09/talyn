import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../services/workbenches/store.js';
import * as durable from '../services/workbenches/durableExec.js';
import * as scriptStore from '../services/workbenches/scriptStore.js';
import * as emit from '../services/workbenches/emit.js';
import { startScript, sweepScripts } from '../services/workbenches/scripts.js';
import { eq } from 'drizzle-orm';
import { createAgentStreamParser } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { FakeFleet, claudeTurnLines } from './helpers/fakeFleet.js';
import { workspaces, repositories, workbenchChats } from '../db/schema.js';
import { appendEvents, claimOrEnqueue, claimTurnLease, finishTurn, getChat, getTurnLease, getWorkbench,
  insertChat, insertWorkbench, listEvents, renewTurnLease, saveOwnedSessionId } from '../services/workbenches/store.js';
import { beginWorkbenchDrain, resetWorkbenchDrainForTests, TURN_OWNER } from '../services/workbenches/ownership.js';
import { setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';
import { ORPHAN_MESSAGE, LEGACY_INTERRUPTED_MESSAGE, sweepOrphanedTurns, turnLogKey, launchTurnLoopForTests, setTurnRetryDelaysForTests } from '../services/workbenches/turns.js';
import { durablePaths, followDurableExec } from '../services/workbenches/durableExec.js';
import { claimScript, appendScriptOutput, scriptSnapshots } from '../services/workbenches/scriptStore.js';
import { settleAgentBackupsForTests } from '../services/workbenches/agentBackups.js';

vi.mock('../services/github.js', async (original) => ({
  ...await original<typeof import('../services/github.js')>(),
  githubService: { getVerifiedAccessToken: vi.fn(async () => 'token') },
}));

describe('workbench deploy handoff', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;
  beforeEach(async () => {
    resetWorkbenchDrainForTests();
    setTurnRetryDelaysForTests([0]);
    db = await createTestDb();
    await seedUser(db.db, { id: 'owner' });
    await db.db.insert(workspaces).values({ id: 'ws', ownerId: 'owner', name: 'Workspace' });
    await db.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'o/r', url: 'https://github.com/o/r' });
    await insertWorkbench({ id: 'wb', workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', name: 'wb',
      branch: 'branch', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready', sandboxId: 'box', settings: { autoCreatePr: false } });
    await insertChat({ id: 'chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Chat', agent: 'claude' });
    fleet = new FakeFleet();
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
  });
  afterEach(async () => {
    await settleAgentBackupsForTests();
    setWorkbenchFleetClientForTests(null);
    resetWorkbenchDrainForTests();
    vi.restoreAllMocks();
    await db.cleanup();
  });
  async function running(owner = 'instance-a') {
    await claimOrEnqueue('chat', { id: 'msg', text: 'work', queuedAt: new Date().toISOString() }, true);
    await db.db.update(workbenchChats).set({ turnOwner: owner }).where(eq(workbenchChats.id, 'chat'));
    return (await getTurnLease('chat'))!;
  }
  it.each([false, true])('resumes without duplicates, snapshot=%s', async (snapshot) => {
    const lease = await running();
    const lines = claudeTurnLines('session', 'done');
    fleet.durableLogs.set(durablePaths(turnLogKey('chat', 1, 0)).log, { stdout: lines });
    const parser = createAgentStreamParser('claude');
    const first = parser.push(lines[0]);
    const offset = Buffer.byteLength(JSON.stringify({ stream: 'stdout', line: lines[0] }) + '\n');
    await appendEvents('chat', first.map((event) => ({ turn: 1, event })), { owner: lease.owner!, turn: 1, offset, previousOffset: 0, ...(snapshot ? { parser: parser.snapshot() } : {}) });
    expect(await sweepOrphanedTurns()).toBe(0);
    expect((await getTurnLease('chat'))?.owner).toBe('instance-a');
    expect(fleet.scripts).toHaveLength(0);
    await db.db.update(workbenchChats).set({ turnHeartbeatAt: new Date(Date.now() - 91_000) }).where(eq(workbenchChats.id, 'chat'));
    expect(await sweepOrphanedTurns()).toBe(1);
    expect(await sweepOrphanedTurns()).toBe(0);
    await vi.waitFor(async () => expect((await getChat('chat'))?.status).toBe('idle'));
    const { events: page } = await listEvents('chat', 0, 100);
    expect(page.map((e) => e.event.type)).toEqual(['system', 'assistant', 'result']);
    expect(page.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await getTurnLease('chat'))?.offset).toBeGreaterThan(offset);
    expect(fleet.durableFollowOffsets).toEqual(snapshot ? [offset] : [0, offset]);
    expect(fleet.scripts.some((s) => s.includes('pkill'))).toBe(false);
  });
  it('fences the old owner from writes, heartbeats and completion', async () => {
    const lease = await running();
    expect(await claimTurnLease(lease, 'instance-b')).toBe(true);
    expect(await claimTurnLease(lease, 'instance-c')).toBe(false);
    expect(await renewTurnLease('chat', 1, 'instance-a')).toBe(false);
    expect(await appendEvents('chat', [{ turn: 1, event: { type: 'result' } }], {
      owner: 'instance-a', turn: 1, offset: 10, previousOffset: 0,
    })).toEqual([]);
    expect(await finishTurn('chat', { finalStatus: 'idle', statusMessage: null, drain: true, owner: 'instance-a', turn: 1 })).toBeNull();
    expect((await getTurnLease('chat'))?.offset).toBe(0);
    expect(await saveOwnedSessionId('chat', 1, 'stale-session')).toBeNull();
  });
  it.each([5, 31])('does not steal a legacy turn after %i minutes while its agent lives', async (minutes) => {
    await running();
    await db.db.update(workbenchChats).set({ turnOwner: null, turnHeartbeatAt: null,
      turnStartedAt: new Date(Date.now() - minutes * 60_000) }).where(eq(workbenchChats.id, 'chat'));
    fleet.handler = () => ({ exitCode: 0 });
    expect(await sweepOrphanedTurns()).toBe(0);
    expect((await getChat('chat'))?.status).toBe('running');
  });
  it('explains a missing agent with no exit file', async () => {
    await running();
    fleet.durableLogs.set(durablePaths(turnLogKey('chat', 1, 0)).log, { killed: true });
    await db.db.update(workbenchChats).set({ turnHeartbeatAt: new Date(Date.now() - 91_000) }).where(eq(workbenchChats.id, 'chat'));
    expect(await sweepOrphanedTurns()).toBe(1);
    await vi.waitFor(async () => expect((await getChat('chat'))?.statusMessage).toBe(ORPHAN_MESSAGE));
    expect((await listEvents('chat', 0, 100)).events[0].event.result).toBe('The agent stopped unexpectedly.');
  });
  it('does not repeat a saved error result after a crash before completion', async () => {
    await running();
    await appendEvents('chat', [{ turn: 1, event: { type: 'result', is_error: true, result: ORPHAN_MESSAGE } }]);
    fleet.durableLogs.set(durablePaths(turnLogKey('chat', 1, 0)).log, { killed: true });
    await db.db.update(workbenchChats).set({ turnHeartbeatAt: new Date(Date.now() - 91_000) }).where(eq(workbenchChats.id, 'chat'));
    await sweepOrphanedTurns();
    await vi.waitFor(async () => expect((await getChat('chat'))?.status).toBe('error'));
    expect((await listEvents('chat', 0, 100)).events).toHaveLength(1);
  });
  it('leaves a draining instance queue for another instance', async () => {
    beginWorkbenchDrain();
    const claim = await claimOrEnqueue('chat', { id: 'msg', text: 'work', queuedAt: new Date().toISOString() }, true);
    expect(claim?.started).toBeNull();
    expect(await sweepOrphanedTurns()).toBe(0);
    resetWorkbenchDrainForTests();
    const next = await claimOrEnqueue('chat', null, true);
    expect(next?.started?.message.id).toBe('msg');
    expect((await getTurnLease('chat'))?.owner).toBe(TURN_OWNER);
  });
  it('hands a claimed turn to the next instance when drain starts before its loop', async () => {
    const claim = await claimOrEnqueue('chat', { id: 'pending', text: 'work', queuedAt: new Date().toISOString() }, true);
    const chats = vi.spyOn(emit, 'emitWorkbenchChat');
    beginWorkbenchDrain();
    launchTurnLoopForTests('chat', claim!.started!);
    await vi.waitFor(async () => expect((await getTurnLease('chat'))?.heartbeat).toEqual(new Date(0)));
    // Still running, with its message on the lease: no client sees the turn stop.
    expect((await getChat('chat'))?.status).toBe('running');
    expect((await getTurnLease('chat'))?.message?.id).toBe('pending');
    expect(chats).not.toHaveBeenCalled();
    expect(fleet.scripts).toEqual([]);
  });
  it('resumes script output at its stored byte offset', async () => {
    const row = (await getWorkbench('wb'))!;
    const lease = (await claimScript(row, 'run'))!;
    fleet.durableLogs.set(durablePaths(lease.generation).log, { stdout: ['first', 'second'] });
    const offset = Buffer.byteLength(JSON.stringify({ stream: 'stdout', line: 'first' }) + '\n');
    await appendScriptOutput(lease, 'first\n', offset);
    const received: string[] = [];
    await followDurableExec(row, lease.generation, 'script-marker', lease.offset, async (record, next) => {
      received.push(record.line);
      await appendScriptOutput(lease, record.line + '\n', next);
    });
    expect(received).toEqual(['second']);
    expect((await scriptSnapshots('wb'))[0].data).toBe('first\nsecond\n');
  });
  it('releases a detached lease for adoption in one sweep', async () => {
    await running(TURN_OWNER);
    fleet.durableLogs.set(durablePaths(turnLogKey('chat', 1, 0)).log, { stdout: claudeTurnLines('session', 'done') });
    await store.releaseOwnedTurnLeases();
    expect((await getTurnLease('chat'))?.heartbeat).toEqual(new Date(0));
    expect(await sweepOrphanedTurns()).toBe(1);
    await vi.waitFor(async () => expect((await getChat('chat'))?.status).toBe('idle'));
  });
  it('stores 121 turn records in three writes with their offsets and snapshots', async () => {
    await running();
    const lines = Array.from({ length: 121 }, (_, i) => JSON.stringify({ type: 'assistant', text: String(i) }));
    fleet.durableLogs.set(durablePaths(turnLogKey('chat', 1, 0)).log, { stdout: lines });
    await db.db.update(workbenchChats).set({ turnHeartbeatAt: new Date(0) });
    const writes = vi.spyOn(store, 'appendEvents');
    await sweepOrphanedTurns();
    await vi.waitFor(async () => expect((await getChat('chat'))?.status).toBe('idle'));
    const batches = writes.mock.calls.filter((c) => c[2]?.offset);
    expect(batches.map((c) => c[1].length)).toEqual([50, 50, 21]);
    expect(batches.every((c) => c[2]?.parser?.version === 1)).toBe(true);
    expect((await listEvents('chat', 0, 200)).events).toHaveLength(121);
  });
  it('retries a failed batch three times and hands off without finishing the agent', async () => {
    await running();
    fleet.durableLogs.set(durablePaths(turnLogKey('chat', 1, 0)).log, {
      stdout: claudeTurnLines('session', 'done'), hold: new Promise(() => undefined),
    });
    await db.db.update(workbenchChats).set({ turnHeartbeatAt: new Date(0) });
    const writes = vi.spyOn(store, 'appendEvents').mockRejectedValue(new Error('database unavailable'));
    await sweepOrphanedTurns();
    await vi.waitFor(async () => expect((await getTurnLease('chat'))?.heartbeat).toEqual(new Date(0)), { timeout: 3000 });
    expect(writes).toHaveBeenCalledTimes(3);
    expect((await getChat('chat'))?.status).toBe('running');
    expect((await getTurnLease('chat'))?.offset).toBe(0);
  });
  it('hands a pre-start turn on when drain starts during its adoption', async () => {
    await running();
    await db.db.update(workbenchChats).set({ turnHeartbeatAt: new Date(0) });
    const chats = vi.spyOn(emit, 'emitWorkbenchChat');
    vi.spyOn(durable, 'durableExecExists').mockImplementation(async () => { beginWorkbenchDrain(); return false; });
    expect(await sweepOrphanedTurns()).toBe(1);
    await vi.waitFor(async () => expect((await getTurnLease('chat'))?.heartbeat).toEqual(new Date(0)));
    expect((await getChat('chat'))).toMatchObject({ status: 'running', queuedMessages: [] });
    expect((await getTurnLease('chat'))?.message?.id).toBe('msg');
    expect(chats).not.toHaveBeenCalled();
    expect(fleet.launches).toEqual([]);
  });
  it('settles an owned turn when its message and start marker are missing', async () => {
    await running();
    await db.db.update(workbenchChats).set({ turnMessage: null, turnHeartbeatAt: new Date(Date.now() - 91_000) });
    const before = fleet.scripts.length;
    expect(await sweepOrphanedTurns()).toBe(1);
    await vi.waitFor(async () => expect((await getChat('chat'))).toMatchObject({ status: 'error', statusMessage: ORPHAN_MESSAGE }));
    const { events } = await listEvents('chat', 0, 100);
    expect(events.at(-1)?.event).toMatchObject({ type: 'result', is_error: true, result: ORPHAN_MESSAGE });
    expect(fleet.scripts.slice(before).some((script) => script.includes('pkill'))).toBe(false);
    expect(await sweepOrphanedTurns()).toBe(0);
  });
  it('settles a legacy turn neutrally after three minutes without events', async () => {
    await running();
    await db.db.update(workbenchChats).set({ turnOwner: null, turnHeartbeatAt: null, turnMessage: null,
      updatedAt: new Date(Date.now() - 181_000) });
    fleet.handler = () => ({ exitCode: 1 });
    expect(await sweepOrphanedTurns()).toBe(1);
    await vi.waitFor(async () => expect((await getChat('chat'))?.status).toBe('idle'));
    expect((await getChat('chat'))?.statusMessage).toBe(LEGACY_INTERRUPTED_MESSAGE);
    expect((await listEvents('chat', 0, 100)).events[0].event.type).toBe('system');
  });
  it('does not drain a cancelled queue or touch its timestamp', async () => {
    await running();
    await claimOrEnqueue('chat', { id: 'next', text: 'next', queuedAt: new Date().toISOString() }, true);
    await finishTurn('chat', { finalStatus: 'idle', statusMessage: 'Cancelled', drain: false });
    const before = (await getChat('chat'))!.updatedAt;
    await sweepOrphanedTurns();
    expect((await getChat('chat'))?.queuedMessages).toHaveLength(1);
    expect((await getChat('chat'))?.updatedAt).toEqual(before);
  });
  it('batches script output and keys setup results by sandbox generation', async () => {
    const row = (await getWorkbench('wb'))!;
    fleet.handler = () => ({ stdout: Array.from({ length: 100 }, () => 'build line') });
    const writes = vi.spyOn(scriptStore, 'appendScriptOutput');
    const frames = vi.spyOn(emit, 'emitWorkbenchScript');
    const config = { setup: { command: 'build' }, run: [], runMode: 'nonconcurrent' as const, source: 'none' as const, filesToCopy: [], errors: [] };
    await (await startScript(row, 'setup', { config })).done;
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0][1].split('\n')).toHaveLength(101);
    expect(writes.mock.calls[0][2]).toBeGreaterThan(0);
    expect(frames.mock.calls.filter((c) => c[1].stream !== 'exit')).toHaveLength(1);
    const fresh = { ...row, sandboxGeneration: 'new-generation' };
    await scriptStore.resetSetupForGeneration(fresh);
    expect(await scriptStore.existingScript(row.id, 'setup', row.sandboxId!, fresh.sandboxGeneration)).toBeNull();
    await (await startScript(fresh, 'setup', { config, resume: true })).done;
    expect(writes).toHaveBeenCalledTimes(2);
  });

  it('adopts a released script lease within one sweep', async () => {
    const row = (await getWorkbench('wb'))!;
    const lease = (await claimScript(row, 'run'))!;
    fleet.durableLogs.set(durablePaths(lease.generation).log, { stdout: ['before', 'after'] });
    await scriptStore.releaseOwnedScripts();
    expect((await scriptStore.staleScripts())[0].heartbeat).toEqual(new Date(0));
    await sweepScripts();
    await vi.waitFor(async () => expect((await scriptSnapshots('wb'))[0].running).toBe(false));
    expect((await scriptSnapshots('wb'))[0].data).toBe('before\nafter\n');
  });

});
