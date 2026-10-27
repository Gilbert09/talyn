import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createAgentStreamParser } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { FakeFleet, claudeTurnLines } from './helpers/fakeFleet.js';
import { workspaces, repositories, workbenchChats } from '../db/schema.js';
import { appendEvents, claimOrEnqueue, claimTurnLease, finishTurn, getChat, getTurnLease, getWorkbench,
  insertChat, insertWorkbench, listEvents, renewTurnLease, saveOwnedSessionId } from '../services/workbenches/store.js';
import { beginWorkbenchDrain, resetWorkbenchDrainForTests, TURN_OWNER } from '../services/workbenches/ownership.js';
import { setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';
import { ORPHAN_MESSAGE, sweepOrphanedTurns, turnLogKey, launchTurnLoopForTests } from '../services/workbenches/turns.js';
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
    await db.cleanup();
  });
  async function running(owner = 'instance-a') {
    await claimOrEnqueue('chat', { id: 'msg', text: 'work', queuedAt: new Date().toISOString() }, true);
    await db.db.update(workbenchChats).set({ turnOwner: owner }).where(eq(workbenchChats.id, 'chat'));
    return (await getTurnLease('chat'))!;
  }
  it('leaves a fresh owner untouched, then claims once and resumes without duplicate events', async () => {
    const lease = await running();
    const lines = claudeTurnLines('session', 'done');
    fleet.durableLogs.set(durablePaths(turnLogKey('chat', 1, 0)).log, { stdout: lines });
    const parser = createAgentStreamParser('claude');
    const first = parser.push(lines[0]);
    const offset = Buffer.byteLength(JSON.stringify({ stream: 'stdout', line: lines[0] }) + '\n');
    await appendEvents('chat', first.map((event) => ({ turn: 1, event })), { owner: lease.owner!, turn: 1, offset, previousOffset: 0 });
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
    expect(fleet.durableFollowOffsets).toEqual([0, offset]);
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
    await db.db.update(workbenchChats).set({ turnHeartbeatAt: new Date(Date.now() - 91_000) }).where(eq(workbenchChats.id, 'chat'));
    expect(await sweepOrphanedTurns()).toBe(1);
    await vi.waitFor(async () => expect((await getChat('chat'))?.statusMessage).toBe(ORPHAN_MESSAGE));
    expect((await listEvents('chat', 0, 100)).events[0].event.result).toBe('The agent stopped unexpectedly.');
  });
  it('does not repeat a saved error result after a crash before completion', async () => {
    await running();
    await appendEvents('chat', [{ turn: 1, event: { type: 'result', is_error: true, result: ORPHAN_MESSAGE } }]);
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
  it('returns a claimed turn to the queue when drain starts before its loop', async () => {
    const claim = await claimOrEnqueue('chat', { id: 'pending', text: 'work', queuedAt: new Date().toISOString() }, true);
    beginWorkbenchDrain();
    launchTurnLoopForTests('chat', claim!.started!);
    await vi.waitFor(async () => expect((await getChat('chat'))?.status).toBe('idle'));
    expect((await getChat('chat'))?.queuedMessages[0].id).toBe('pending');
    expect(fleet.scripts).toEqual([]);
    resetWorkbenchDrainForTests();
    expect((await claimOrEnqueue('chat', null, true))?.started?.message.id).toBe('pending');
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
});
