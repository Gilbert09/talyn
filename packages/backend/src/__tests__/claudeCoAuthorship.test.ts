import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces } from '../db/schema.js';
import { claudeCoAuthoredBySetting } from '../services/workbenches/claudeCoAuthorship.js';

describe('Claude commit co-authorship', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: 'owner' });
    await db.insert(workspaces).values({ id: 'ws', ownerId: 'owner', name: 'Workspace' });
  });

  afterEach(async () => cleanup());

  it.each([
    [undefined, true],
    [true, true],
    [false, false],
  ])('reads %j as %j', async (stored, expected) => {
    if (stored !== undefined) {
      await db.update(workspaces).set({ settings: { claudeCoAuthoredBy: stored } }).where(eq(workspaces.id, 'ws'));
    }
    expect(await claudeCoAuthoredBySetting('ws')).toBe(expected);
  });
});
