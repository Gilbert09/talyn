import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workspaces } from '../db/schema.js';
import { FleetRunNotFoundError, type FleetClient } from '../services/selfHosted/client.js';
import { AGENT_MEMORY_RECAP_NOTE, SANDBOX_LOST_MESSAGE, SANDBOX_RESTORED_NOTE, recordRecoveredTranscript, resetLostRecoveryForTests } from '../services/workbenches/recovery.js';
import { NO_CHECKPOINT_NOTE } from '../services/workbenches/workCheckpointScripts.js';
import { runCapture, setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';
import { getChat, getWorkbench, insertChat, insertWorkbench, listEvents, updateWorkbench } from '../services/workbenches/store.js';
import { sendMessage } from '../services/workbenches/turns.js';

vi.mock('../services/workbenches/lifecycle.js', () => ({ scheduleProvision: vi.fn() }));

const { scheduleProvision } = await import('../services/workbenches/lifecycle.js');

describe('lost workbench recovery', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    resetLostRecoveryForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    await testDb.db.insert(repositories).values({ id: 'repo-a', workspaceId: 'ws-a', name: 'o/r', url: 'https://github.com/o/r' });
    await insertWorkbench({
      id: 'wb-recovery', workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'o/r', name: 'paris',
      branch: 'paris', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
      sandboxState: 'running', sandboxId: 'talyn-wb-wbrecovery',
    });
    await insertChat({ id: 'chat-recovery', workbenchId: 'wb-recovery', workspaceId: 'ws-a', title: 'Chat', agent: 'claude', agentSessionId: 'old-session' });
    setWorkbenchFleetClientForTests(async () => ({
      quietExec: vi.fn().mockRejectedValue(new FleetRunNotFoundError('this sandbox is not running on this host')),
      getDiff: vi.fn().mockResolvedValue({ supported: true, data: { files: [], mergeBase: '', headSha: '' } }),
    }) as unknown as FleetClient);
  });

  afterEach(async () => {
    setWorkbenchFleetClientForTests(null);
    vi.mocked(scheduleProvision).mockClear();
    await testDb.cleanup();
  });

  it('claims an exec loss once and starts one new sandbox', async () => {
    const old = (await getWorkbench('wb-recovery'))!;
    await expect(runCapture(old, 'true', { quiet: true })).rejects.toBeInstanceOf(FleetRunNotFoundError);
    const lost = (await getWorkbench(old.id))!;
    expect(lost).toMatchObject({
      status: 'provisioning', sandboxState: 'lost', statusMessage: SANDBOX_LOST_MESSAGE,
      sandboxId: 'talyn-wb-wbrecovery-r1',
    });
    expect(scheduleProvision).toHaveBeenCalledTimes(1);
    await expect(runCapture(old, 'true', { quiet: true })).rejects.toBeInstanceOf(FleetRunNotFoundError);
    expect(scheduleProvision).toHaveBeenCalledTimes(1);
    await updateWorkbench(old.id, { status: 'ready', sandboxState: 'running' });
    await expect(runCapture((await getWorkbench(old.id))!, 'true', { quiet: true })).rejects.toBeInstanceOf(FleetRunNotFoundError);
    expect(await getWorkbench(old.id)).toMatchObject({
      status: 'error', sandboxState: 'error', statusMessage: 'The sandbox was lost again. Retry this session.',
    });
    expect(scheduleProvision).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['suspended', { sandbox: { status: 'suspended' }, terminal: false }, false],
    ['hibernated', { sandbox: { status: 'suspended', suspendKind: 'remote' }, terminal: false }, false],
    ['stopped', { sandbox: { status: 'stopped' }, terminal: true }, true],
    ['retired', { sandbox: { status: 'stopped' }, terminal: true, retired: true }, true],
    ['failed', { sandbox: { status: 'failed' }, terminal: false }, true],
    ['live but unreachable', { sandbox: { status: 'idle' }, terminal: false }, true],
  ])('asks the fleet first: a %s box is %s', async (_label, answer, replaced) => {
    const resumeSandbox = vi.fn().mockResolvedValue(undefined);
    const getSandbox = vi.fn().mockResolvedValue(answer);
    setWorkbenchFleetClientForTests(async () => ({
      quietExec: vi.fn().mockRejectedValue(new FleetRunNotFoundError('this sandbox is not running on this host')),
      getSandbox,
      resumeSandbox,
    }) as unknown as FleetClient);
    const old = (await getWorkbench('wb-recovery'))!;
    await expect(runCapture(old, 'true', { quiet: true })).rejects.toBeInstanceOf(FleetRunNotFoundError);
    expect(getSandbox).toHaveBeenCalledWith('talyn-wb-wbrecovery');
    if (replaced) {
      expect(resumeSandbox).not.toHaveBeenCalled();
      expect(scheduleProvision).toHaveBeenCalledTimes(1);
      expect(await getWorkbench(old.id)).toMatchObject({ sandboxState: 'lost', sandboxId: 'talyn-wb-wbrecovery-r1' });
    } else {
      expect(resumeSandbox).toHaveBeenCalledWith('talyn-wb-wbrecovery');
      expect(scheduleProvision).not.toHaveBeenCalled();
      expect(await getWorkbench(old.id)).toMatchObject({ status: 'ready', sandboxState: 'running', sandboxId: 'talyn-wb-wbrecovery' });
    }
  });

  it('replaces the box when the resume itself fails', async () => {
    setWorkbenchFleetClientForTests(async () => ({
      quietExec: vi.fn().mockRejectedValue(new FleetRunNotFoundError('gone')),
      getSandbox: vi.fn().mockResolvedValue({ sandbox: { status: 'suspended' }, terminal: false }),
      resumeSandbox: vi.fn().mockRejectedValue(new Error('hibernation_unusable')),
    }) as unknown as FleetClient);
    const old = (await getWorkbench('wb-recovery'))!;
    await expect(runCapture(old, 'true', { quiet: true })).rejects.toBeInstanceOf(FleetRunNotFoundError);
    expect(scheduleProvision).toHaveBeenCalledTimes(1);
  });

  it('records the data loss note after the replacement is ready', async () => {
    const row = (await getWorkbench('wb-recovery'))!;
    await updateWorkbench(row.id, { status: 'ready', sandboxState: 'running', sandboxId: 'talyn-wb-wbrecovery-r1' });
    await recordRecoveredTranscript((await getWorkbench(row.id))!);
    const events = await listEvents('chat-recovery', 0, 20);
    expect(events.events.map((event) => event.event)).toEqual([
      expect.objectContaining({ type: 'system', subtype: 'sandbox_recovered', text: `${SANDBOX_RESTORED_NOTE} ${AGENT_MEMORY_RECAP_NOTE}` }),
    ]);
    // Without a checkpoint the note says so, rather than implying one was tried.
    expect(SANDBOX_RESTORED_NOTE).toBe(NO_CHECKPOINT_NOTE);
    expect(NO_CHECKPOINT_NOTE).toContain('had no checkpoint');
  });

  it('uses the checkpoint outcome as the note when one is given', async () => {
    await recordRecoveredTranscript((await getWorkbench('wb-recovery'))!, false, 'Restored from a checkpoint.');
    const events = await listEvents('chat-recovery', 0, 20);
    expect(events.events.map((event) => event.event)).toEqual([
      expect.objectContaining({ subtype: 'sandbox_recovered', text: `Restored from a checkpoint. ${AGENT_MEMORY_RECAP_NOTE}` }),
    ]);
  });

  it('ends a running turn with the plain loss message', async () => {
    await sendMessage('chat-recovery', { text: 'Fix the issue' });
    await sendMessage('chat-recovery', { text: 'Continue after recovery' });
    await vi.waitFor(async () => {
      expect(await getChat('chat-recovery')).toMatchObject({
        status: 'error', statusMessage: SANDBOX_LOST_MESSAGE,
        queuedMessages: [expect.objectContaining({ text: 'Continue after recovery' })],
      });
    });
    const events = (await listEvents('chat-recovery', 0, 20)).events;
    expect(events.some((event) => event.event.type === 'result' && event.event.result === SANDBOX_LOST_MESSAGE)).toBe(true);
  });
});
