import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { workbenchEvents, workspaces } from '../db/schema.js';
import { recordSandboxWake, writeBoxStart, type StoredBoxStart, type StoredWake } from '../services/workbenches/boxStart.js';
import { getWorkbench, insertChat, insertWorkbench, rowToWorkbench } from '../services/workbenches/store.js';

describe('workbench boot metrics', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Test' });
    await insertWorkbench({
      id: 'wb', workspaceId: 'ws', repositoryId: null, repoFullName: '', name: 'boot', branch: '', baseBranch: '',
      runtime: 'sandbox', agent: 'claude', status: 'ready', sandboxState: 'running', sandboxId: 'box',
    });
    await insertChat({ id: 'chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Chat', agent: 'claude' });
  });

  afterAll(async () => { await testDb.cleanup(); });

  it('keeps ten starts and wakes, writes metric events, and hides settings from the public row', async () => {
    const start: StoredBoxStart = {
      sandboxId: 'box', cause: 'new', measuredAt: '', requestedAt: null, waitMs: null, readyMs: 1,
      checkoutMs: null, prebaked: null, repoSetupMs: null, stepsMs: null, setupMs: null,
      setupExit: null, totalMs: 1, steps: [], layer: 'base', repoCommit: null,
      userLayerPending: null, repoLayerPending: null,
    };
    for (let ms = 1; ms <= 12; ms++) {
      await writeBoxStart('wb', { ...start, totalMs: ms });
      await recordSandboxWake({ sandboxId: 'box', at: new Date().toISOString(), ms, from: 'host', ok: true });
    }
    const row = (await getWorkbench('wb'))!;
    const settings = row.settings as Record<string, unknown>;
    expect((settings.boxStarts as StoredBoxStart[]).map((item) => item.totalMs)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect((settings.wakes as StoredWake[]).map((item) => item.ms)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const metrics = await testDb.db.select({ event: workbenchEvents.event }).from(workbenchEvents);
    expect(metrics.filter(({ event }) => event.metric === 'box_created')).toHaveLength(12);
    expect(metrics.filter(({ event }) => event.metric === 'wake_end')).toHaveLength(12);
    expect(JSON.stringify(rowToWorkbench(row))).not.toMatch(/boxStart|boxStarts|lastWake|wakes/);
  });
});
