import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workspaces } from '../db/schema.js';
import {
  FleetCapacityError,
  FleetClient,
  FleetHibernationLostError,
  FleetHttpError,
  FleetRunNotFoundError,
  resetFleetOptionalSupport,
} from '../services/selfHosted/client.js';
import { SANDBOX_WAKING_MESSAGE, userFacingError } from '../services/workbenches/errors.js';
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

  describe('a hibernated copy the fleet cannot restore', () => {
    const json = (body: unknown, status: number) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const RAW = "this sandbox's hibernated copy cannot be restored: rootfs.img.data is truncated";
    let paths: string[];

    /** A real client: `answer` is what the fleet says to the exec (`via: exec`) or to the resume it asks for. */
    function fleetAnswers(via: 'exec' | 'resume', answer: () => Response): void {
      paths = [];
      resetFleetOptionalSupport();
      setWorkbenchFleetClientForTests(async () => new FleetClient('https://fleet.test', 'tok'));
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        const path = url.replace('https://fleet.test', '');
        paths.push(`${init?.method ?? 'GET'} ${path}`);
        if (path.endsWith('/resume')) return answer();
        if (via === 'exec') return answer();
        return json({ error: 'remote_resume_required', message: "this sandbox's only copy is in object storage" }, 409);
      });
    }

    afterEach(() => vi.unstubAllGlobals());

    it.each([
      ['exec', '409 hibernation_unusable', () => json({ error: 'hibernation_unusable', message: RAW, localCopy: false }, 409)],
      ['resume', '409 hibernation_unusable', () => json({ error: 'hibernation_unusable', message: RAW, localCopy: false }, 409)],
      ['exec', 'hibernation_lost', () => json({ error: 'hibernation_lost', message: 'the copy is gone' }, 409)],
      ['resume', 'hibernation_lost', () => json({ error: 'hibernation_lost', message: 'the copy is gone' }, 409)],
      ['exec', 'the message only', () => json({ message: RAW }, 500)],
      ['resume', 'the message only', () => json({ message: RAW }, 500)],
    ] as const)('treats the box as lost and keeps it (via %s, %s)', async (via, _label, answer) => {
      fleetAnswers(via, answer);
      const old = (await getWorkbench('wb-recovery'))!;
      const err = await runCapture(old, 'true', { quiet: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FleetHibernationLostError);
      expect(userFacingError(err)).toBe(SANDBOX_LOST_MESSAGE);
      const lost = (await getWorkbench(old.id))!;
      expect(lost).toMatchObject({
        status: 'provisioning', sandboxState: 'lost', statusMessage: SANDBOX_LOST_MESSAGE,
        memoryRestorePending: 'lost', sandboxId: 'talyn-wb-wbrecovery-r1',
      });
      // Kept for an operator: the reaper reads this list.
      expect(lost.settings.keptSandboxIds).toEqual(['talyn-wb-wbrecovery']);
      expect(scheduleProvision).toHaveBeenCalledTimes(1);
      // No second resume: it would fetch the copy again. No delete either.
      expect(paths.filter((p) => p.endsWith('/resume'))).toHaveLength(via === 'resume' ? 1 : 0);
      expect(paths).not.toContain('GET /v1/sandboxes/talyn-wb-wbrecovery');
      expect(paths.some((p) => p.startsWith('DELETE'))).toBe(false);
    });

    it('keeps the fleet id of the old box as well', async () => {
      await updateWorkbench('wb-recovery', { settings: { fleetSandboxId: 'fleet-abc', internetAccess: false } });
      fleetAnswers('resume', () => json({ error: 'hibernation_unusable', message: RAW }, 409));
      await runCapture((await getWorkbench('wb-recovery'))!, 'true', { quiet: true }).catch(() => undefined);
      expect((await getWorkbench('wb-recovery'))!.settings).toMatchObject({
        keptSandboxIds: ['talyn-wb-wbrecovery', 'fleet-abc'], internetAccess: false,
      });
    });

    it.each(['exec', 'resume'] as const)('does not recover on a failed fetch (via %s), and says Talyn will try again', async (via) => {
      fleetAnswers(via, () => json({ error: 'hibernation_fetch_failed', message: RAW, retryable: true }, 503));
      const old = (await getWorkbench('wb-recovery'))!;
      const err = await runCapture(old, 'true', { quiet: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FleetCapacityError);
      expect(userFacingError(err)).toBe(SANDBOX_WAKING_MESSAGE);
      expect(await getWorkbench(old.id)).toMatchObject({ status: 'ready', sandboxState: 'running', sandboxId: 'talyn-wb-wbrecovery' });
      expect(scheduleProvision).not.toHaveBeenCalled();
    });

    it('does not recover on an unrelated refusal', async () => {
      fleetAnswers('exec', () => json({ error: 'guest_too_old', message: 'too old' }, 409));
      const old = (await getWorkbench('wb-recovery'))!;
      const err = await runCapture(old, 'true', { quiet: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FleetHttpError);
      expect(userFacingError(err)).toBe('Talyn Fleet refused the request: too old');
      expect(await getWorkbench(old.id)).toMatchObject({ status: 'ready', sandboxId: 'talyn-wb-wbrecovery' });
      expect(scheduleProvision).not.toHaveBeenCalled();
    });
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
