import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryWorkObjectStore, setWorkObjectStoreForTests } from '../services/workbenches/workStorage.js';
import { sql } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { FakeFleet, isWorkSaveScript } from './helpers/fakeFleet.js';
import { repositories, workspaces } from '../db/schema.js';
import { FleetRunNotFoundError } from '../services/selfHosted/client.js';
import { debugBus } from '../services/debugBus.js';
import * as runtime from '../services/workbenches/sandboxRuntime.js';
import { archiveWorkbench, deleteWorkbench, processArchive, restoreWorkbench, settleArchivesForTests, sweepPendingArchives } from '../services/workbenches/lifecycle.js';
import { claimArchive, finishArchive, getWorkbench, insertWorkbench, markArchive, renewArchive, updateWorkbench } from '../services/workbenches/store.js';

vi.mock('../services/websocket.js', async (original) => ({
  ...(await original<typeof import('../services/websocket.js')>()), broadcastToWorkspace: () => undefined,
}));

const WB = 'archive-test';

describe('durable session archives', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;
  const row = async () => (await getWorkbench(WB))!;

  beforeEach(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Test' });
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'a/b', url: 'https://github.com/a/b' });
    await insertWorkbench({ id: WB, workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'a/b',
      name: 'paris', branch: 'paris', baseBranch: 'main', runtime: 'sandbox', agent: 'claude',
      status: 'ready', sandboxState: 'running', sandboxId: 'box' });
    fleet = new FakeFleet();
    runtime.setWorkbenchFleetClientForTests(async () => fleet.asClient());
  });

  afterEach(async () => {
    await settleArchivesForTests();
    runtime.setWorkbenchFleetClientForTests(null);
    vi.restoreAllMocks();
    await testDb.cleanup();
  });

  describe('saved work in Talyn storage', () => {
    let store: ReturnType<typeof memoryWorkObjectStore>;
    const bundle = 'archive bundle bytes';
    const sum = createHash('sha256').update(bundle).digest('hex');
    const SHA = 'e'.repeat(40);

    beforeEach(async () => {
      store = memoryWorkObjectStore();
      setWorkObjectStoreForTests(store);
      await store.put(`ws/${WB}/checkpoint/meta.json`, Buffer.from('{"version":1,"kind":"checkpoint","sha":"' + 'f'.repeat(40) + '","parts":1,"generation":"g1"}'));
      await store.put(`ws/${WB}/checkpoint/g1/part-00000`, Buffer.from('old'));
      await updateWorkbench(WB, { workCheckpointSha: 'f'.repeat(40), workCheckpointAt: new Date('2099-01-01T09:00:00Z'), workCheckpointBytes: 3 });
    });

    afterEach(() => setWorkObjectStoreForTests(null));

    const saving = (reply: { stdout?: string; exitCode?: number; stderr?: string }) => {
      fleet.handler = (script) => {
        if (isWorkSaveScript(script, 'archive')) return reply;
        if (script.startsWith(`dd if=/dev/shm/talyn-work-${WB}/work.bundle`)) return { stdout: bundle };
        return {};
      };
    };

    it('saves the work as a bundle, replaces the checkpoint, and pushes nothing', async () => {
      saving({ stdout: `BUNDLE ${SHA} 4070944800 ${'a'.repeat(40)} ${bundle.length} ${sum}\n` });
      await markArchive(WB);
      await processArchive(WB);
      expect(await row()).toMatchObject({ archivePendingAt: null, sandboxState: 'deleted', workCheckpointSha: null, workCheckpointBytes: null });
      expect(fleet.deleted).toEqual(['box']);
      expect(fleet.scripts.some((s) => s.includes('git push'))).toBe(false);
      expect([...store.objects.keys()].filter((k) => k.includes('/checkpoint/'))).toEqual([]);
      const meta = JSON.parse(store.objects.get(`ws/${WB}/archive/meta.json`)!.toString());
      expect(meta).toMatchObject({ version: 1, kind: 'archive', sha: SHA, base: 'a'.repeat(40), branch: 'paris', size: bundle.length, sha256: sum, parts: 1, takenAt: '2099-01-01T10:00:00.000Z' });
      expect(store.objects.get(`ws/${WB}/archive/${meta.generation}/part-00000`)?.toString()).toBe(bundle);
      // The staging folder is removed once the bundle is out.
      expect(fleet.scripts.some((s) => s.startsWith(`rm -rf -- /dev/shm/talyn-work-${WB}`))).toBe(true);
    });

    it('keeps the box and says why when the work is over the limit', async () => {
      saving({ stdout: `TOO_LARGE ${200 * 1024 * 1024}\n` });
      await markArchive(WB);
      await processArchive(WB);
      expect((await row()).statusMessage).toContain('comes to 200 MB compressed, more than the 96 MB Talyn keeps');
      expect(fleet.deleted).toEqual([]);
      expect(store.objects.has(`ws/${WB}/checkpoint/meta.json`)).toBe(true);
    });

    it('keeps the box when storage refuses the bundle', async () => {
      saving({ stdout: `BUNDLE ${SHA} 4070944800 - ${bundle.length} ${sum}\n` });
      store.put = async () => { throw new Error('storage is down'); };
      await markArchive(WB);
      await processArchive(WB);
      expect((await row()).statusMessage).toContain('storage is down');
      expect(fleet.deleted).toEqual([]);
    });

    it('keeps the box when a part arrives short', async () => {
      saving({ stdout: `BUNDLE ${SHA} 4070944800 - ${bundle.length + 5} ${sum}\n` });
      await markArchive(WB);
      await processArchive(WB);
      expect((await row()).statusMessage).toContain(`returned ${bundle.length} of ${bundle.length + 5} bytes`);
      expect(fleet.deleted).toEqual([]);
      expect(store.objects.has(`ws/${WB}/archive/meta.json`)).toBe(false);
    });

    it('stores nothing for a clean box, and removes what was stored before', async () => {
      await store.put(`ws/${WB}/archive/meta.json`, Buffer.from('{}'));
      saving({ stdout: 'CLEAN\n' });
      await markArchive(WB);
      await processArchive(WB);
      expect(fleet.deleted).toEqual(['box']);
      expect([...store.objects.keys()]).toEqual([]);
    });

    it('deletes every saved object with the session', async () => {
      await store.put(`ws/${WB}/archive/meta.json`, Buffer.from('{}'));
      await store.put(`ws/${WB}/archive/half-written/part-00000`, Buffer.from('x'));
      await store.put('ws/other-session/checkpoint/meta.json', Buffer.from('{}'));
      await deleteWorkbench(WB);
      expect([...store.objects.keys()]).toEqual(['ws/other-session/checkpoint/meta.json']);
      expect(await getWorkbench(WB)).toBeNull();
    });
  });

  it('answers before any sandbox call and hides the session immediately', async () => {
    const archived = await archiveWorkbench(WB);
    expect(archived).toMatchObject({ status: 'archived', archivedAt: expect.any(Date), archivePendingAt: expect.any(Date) });
    expect(fleet.scripts).toEqual([]);
    expect(fleet.deleted).toEqual([]);
  });

  it('saves, deletes, then clears the durable marker', async () => {
    const order: string[] = [];
    fleet.handler = (script) => {
      if (isWorkSaveScript(script, 'archive')) order.push('save');
      return { exitCode: 0 };
    };
    vi.spyOn(fleet, 'deleteSandbox').mockImplementation(async () => {
      expect((await row()).archivePendingAt).not.toBeNull();
      order.push('delete');
    });
    await markArchive(WB);
    await processArchive(WB);
    expect(order).toEqual(['save', 'delete']);
    expect(await row()).toMatchObject({ archivePendingAt: null, sandboxState: 'deleted' });
  });

  it('keeps the box after a failed save and backs off before retrying', async () => {
    const errorTick = vi.spyOn(debugBus, 'pollerTick');
    fleet.handler = (script) => isWorkSaveScript(script, 'archive') ? { exitCode: 1, stderr: 'push failed' } : {};
    await markArchive(WB);
    await processArchive(WB);
    const failed = await row();
    expect(failed.archivePendingAt).not.toBeNull();
    expect(failed.archiveFailures).toBe(1);
    expect(failed.statusMessage).toContain('push failed');
    expect(errorTick).toHaveBeenCalledWith('workbench-archive-sweep', expect.objectContaining({ error: expect.any(Error) }));
    const count = fleet.scripts.length;
    await processArchive(WB);
    expect(fleet.scripts).toHaveLength(count);
    expect(fleet.deleted).toEqual([]);
    fleet.handler = () => ({ exitCode: 0 });
    await updateWorkbench(WB, { archiveLeaseUntil: new Date(0), archiveRetryAt: new Date(0), archivePendingAt: new Date(0) });
    await sweepPendingArchives();
    expect(fleet.deleted).toEqual(['box']);
    expect((await row()).archivePendingAt).toBeNull();
  });

  it('allows only one instance to claim the timestamp it read', async () => {
    const seen = (await markArchive(WB))!;
    const claims = await Promise.all([claimArchive(seen), claimArchive(seen)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await renewArchive(claims.find(Boolean)!)).toBe(true);
  });

  it('runs the save once when two workers read the same pending archive', async () => {
    await markArchive(WB);
    await Promise.all([processArchive(WB), processArchive(WB)]);
    expect(fleet.scripts.filter((s) => isWorkSaveScript(s, 'archive'))).toHaveLength(1);
    expect(fleet.deleted).toEqual(['box']);
  });

  it('recovers an expired claim but rejects its old worker', async () => {
    const first = (await claimArchive((await markArchive(WB))!))!;
    await updateWorkbench(WB, { archiveLeaseUntil: new Date(0) });
    const second = await claimArchive(await row());
    expect(second).not.toBeNull();
    expect(await renewArchive(first)).toBe(false);
    expect(await renewArchive(second!)).toBe(true);
  });

  it('clears a pending archive when the sandbox is already gone', async () => {
    fleet.handler = () => { throw new FleetRunNotFoundError('box'); };
    await markArchive(WB);
    await processArchive(WB);
    expect(await row()).toMatchObject({ archivePendingAt: null, sandboxState: 'deleted' });
    expect(fleet.deleted).toEqual([]);
  });

  it('waits for a claimed archive before restoring', async () => {
    await updateWorkbench(WB, { runtime: 'local' });
    const claimed = (await claimArchive((await markArchive(WB))!))!;
    let restored = false;
    const restoring = restoreWorkbench(WB).then((r) => { restored = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(restored).toBe(false);
    expect((await row()).archivedAt).not.toBeNull();
    await finishArchive(claimed);
    expect(await restoring).toMatchObject({ archivedAt: null, status: 'ready' });
  });

  it('protects a pending archive from the previous backend restoring it', async () => {
    await markArchive(WB);
    await expect(testDb.db.execute(sql`UPDATE workbenches SET archived_at = NULL WHERE id = ${WB}`)).rejects.toThrow();
    await testDb.db.execute(sql`UPDATE workbenches SET status = 'ready' WHERE id = ${WB}`);
    expect((await row()).status).toBe('archived');
  });
  it('restores from the live box during archive backoff', async () => {
    await markArchive(WB);
    await finishArchive((await claimArchive(await row()))!, 'Access revoked');
    const restored = await restoreWorkbench(WB);
    expect(restored).toMatchObject({ status: 'ready', archivedAt: null, archivePendingAt: null, sandboxId: 'box' });
    expect(fleet.deleted).toEqual([]);
  });
  it('caps archive failures and permits an explicit retry', async () => {
    await markArchive(WB);
    await updateWorkbench(WB, { archiveFailures: 7 });
    await finishArchive((await claimArchive(await row()))!, 'Protected branch');
    expect(await row()).toMatchObject({ status: 'archiveError', archivePendingAt: null, statusMessage: 'Protected branch', sandboxId: 'box' });
    expect(await markArchive(WB)).toMatchObject({ status: 'archived', archiveFailures: 0, archivePendingAt: expect.any(Date) });
    expect(fleet.deleted).toEqual([]);
  });

  it('cancels an unresponsive archive after sixty seconds and fences its worker', async () => {
    const claimed = (await claimArchive((await markArchive(WB))!))!;
    expect(await restoreWorkbench(WB, { archiveWaitMs: 0 })).toMatchObject({ status: 'ready', archivePendingAt: null, sandboxId: 'box' });
    expect(fleet.execs.some((exec) => exec.req.env?.TALYN_MARKER?.startsWith('archive-save-'))).toBe(true);
    expect(await renewArchive(claimed)).toBe(false);
    expect(await finishArchive(claimed)).toBeNull();
    expect(fleet.deleted).toEqual([]);
  });

});
