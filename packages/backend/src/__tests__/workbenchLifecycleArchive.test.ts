import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { FakeFleet } from './helpers/fakeFleet.js';
import { repositories, workspaces } from '../db/schema.js';
import { FleetRunNotFoundError } from '../services/selfHosted/client.js';
import { debugBus } from '../services/debugBus.js';
import * as runtime from '../services/workbenches/sandboxRuntime.js';
import { archiveWorkbench, processArchive, restoreWorkbench, settleArchivesForTests, sweepPendingArchives } from '../services/workbenches/lifecycle.js';
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

  it('answers before any sandbox call and hides the session immediately', async () => {
    const archived = await archiveWorkbench(WB);
    expect(archived).toMatchObject({ status: 'archived', archivedAt: expect.any(Date), archivePendingAt: expect.any(Date) });
    expect(fleet.scripts).toEqual([]);
    expect(fleet.deleted).toEqual([]);
  });

  it('saves, deletes, then clears the durable marker', async () => {
    const order: string[] = [];
    fleet.handler = (script) => {
      if (script.includes('PUSHED_BRANCH')) order.push('save');
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
    fleet.handler = (script) => script.includes('PUSHED_BRANCH') ? { exitCode: 1, stderr: 'push failed' } : {};
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
    expect(fleet.scripts.filter((s) => s.includes('PUSHED_BRANCH'))).toHaveLength(1);
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
