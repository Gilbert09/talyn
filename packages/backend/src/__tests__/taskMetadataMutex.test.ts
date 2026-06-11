import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  patchTaskMetadata,
  drainTaskMetadata,
  _resetTaskMetadataMutex,
} from '../services/taskMetadataMutex.js';
import * as websocketModule from '../services/websocket.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces as workspacesTable, tasks as tasksTable } from '../db/schema.js';

describe('taskMetadataMutex', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    _resetTaskMetadataMutex();
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws',
      settings: {},
    });
    await seedTask('t1');
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  async function seedTask(id: string, metadata: Record<string, unknown> | null = null) {
    const now = new Date();
    await db.insert(tasksTable).values({
      id,
      workspaceId: 'ws1',
      type: 'code_writing',
      status: 'queued',
      title: 't',
      description: '',
      priority: 'medium',
      metadata: metadata ?? undefined,
      createdAt: now,
      updatedAt: now,
    });
  }

  async function readMetadata(id: string): Promise<Record<string, unknown> | null> {
    const rows = await db
      .select({ metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.id, id))
      .limit(1);
    return (rows[0]?.metadata as Record<string, unknown> | null) ?? null;
  }

  it('applies a patch, persists it, and returns the new metadata + workspaceId', async () => {
    const result = await patchTaskMetadata('t1', (m) => ({ ...m, a: 1 }));

    expect(result).toEqual({ metadata: { a: 1 }, workspaceId: 'ws1' });
    expect(await readMetadata('t1')).toEqual({ a: 1 });
  });

  it('emits task:update with the patched metadata', async () => {
    const spy = vi.spyOn(websocketModule, 'emitTaskUpdate');

    await patchTaskMetadata('t1', (m) => ({ ...m, a: 1 }));

    expect(spy).toHaveBeenCalledWith('ws1', 't1', { metadata: { a: 1 } });
  });

  it('returns null (and emits nothing) when the task row is gone', async () => {
    const spy = vi.spyOn(websocketModule, 'emitTaskUpdate');

    expect(await patchTaskMetadata('t-missing', (m) => m)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('hands each patch the previous patch result, not a stale snapshot', async () => {
    await patchTaskMetadata('t1', (m) => ({ ...m, a: 1 }));
    await patchTaskMetadata('t1', (m) => ({ ...m, b: 2 }));

    expect(await readMetadata('t1')).toEqual({ a: 1, b: 2 });
  });

  it('serializes concurrent patches so neither write is torn', async () => {
    // Fired without awaiting in between — without the per-task chain both
    // SELECTs would read {} and the last UPDATE would clobber the first key.
    await Promise.all([
      patchTaskMetadata('t1', (m) => ({ ...m, a: 1 })),
      patchTaskMetadata('t1', (m) => ({ ...m, b: 2 })),
      patchTaskMetadata('t1', (m) => ({ ...m, c: 3 })),
    ]);

    expect(await readMetadata('t1')).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('propagates a patch error to its caller without poisoning the chain', async () => {
    const failing = patchTaskMetadata('t1', () => {
      throw new Error('patch exploded');
    });
    const following = patchTaskMetadata('t1', (m) => ({ ...m, after: true }));

    await expect(failing).rejects.toThrow('patch exploded');
    await expect(following).resolves.toEqual({
      metadata: { after: true },
      workspaceId: 'ws1',
    });
    expect(await readMetadata('t1')).toEqual({ after: true });
  });

  it('runs different taskIds on independent chains', async () => {
    await seedTask('t2');

    await Promise.all([
      patchTaskMetadata('t1', (m) => ({ ...m, who: 't1' })),
      patchTaskMetadata('t2', (m) => ({ ...m, who: 't2' })),
    ]);

    expect(await readMetadata('t1')).toEqual({ who: 't1' });
    expect(await readMetadata('t2')).toEqual({ who: 't2' });
  });

  it('drainTaskMetadata resolves only after queued patches settle', async () => {
    const applied: string[] = [];
    void patchTaskMetadata('t1', (m) => {
      applied.push('first');
      return { ...m, first: true };
    });
    void patchTaskMetadata('t1', (m) => {
      applied.push('second');
      return { ...m, second: true };
    });

    await drainTaskMetadata('t1');

    expect(applied).toEqual(['first', 'second']);
    expect(await readMetadata('t1')).toEqual({ first: true, second: true });
  });

  it('drainTaskMetadata is a no-op for a task with no chain', async () => {
    await expect(drainTaskMetadata('t-untouched')).resolves.toBeUndefined();
  });
});
