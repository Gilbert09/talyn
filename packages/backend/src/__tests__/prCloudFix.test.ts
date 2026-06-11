import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ACTIVE_STATUSES,
  resolvePostHogEnvId,
  linkedTaskStatus,
} from '../services/prCloudFix.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  tasks as tasksTable,
} from '../db/schema.js';

describe('prCloudFix helpers', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws',
      settings: {},
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  describe('ACTIVE_STATUSES', () => {
    it.each(['pending', 'queued', 'in_progress'])('treats %s as active', (status) => {
      expect(ACTIVE_STATUSES.has(status)).toBe(true);
    });

    it.each(['completed', 'failed', 'cancelled'])('treats %s as terminal', (status) => {
      expect(ACTIVE_STATUSES.has(status)).toBe(false);
    });
  });

  describe('resolvePostHogEnvId', () => {
    it("returns the workspace owner's posthog_code env marker", async () => {
      await db.insert(environmentsTable).values({
        id: 'env-ph',
        ownerId: TEST_USER_ID,
        name: 'PostHog Code',
        type: 'posthog_code',
        config: {},
      });

      expect(await resolvePostHogEnvId('ws1')).toBe('env-ph');
    });

    it('returns null when the owner has no posthog_code env', async () => {
      expect(await resolvePostHogEnvId('ws1')).toBeNull();
    });

    it('ignores env markers of other provider types', async () => {
      await db.insert(environmentsTable).values({
        id: 'env-codex',
        ownerId: TEST_USER_ID,
        name: 'Codex Cloud',
        type: 'codex_cloud',
        config: {},
      });

      expect(await resolvePostHogEnvId('ws1')).toBeNull();
    });

    it("ignores another user's posthog_code env", async () => {
      await seedUser(db, { id: 'user-other' });
      await db.insert(environmentsTable).values({
        id: 'env-other',
        ownerId: 'user-other',
        name: 'PostHog Code',
        type: 'posthog_code',
        config: {},
      });

      expect(await resolvePostHogEnvId('ws1')).toBeNull();
    });

    it('returns null for an unknown workspace', async () => {
      expect(await resolvePostHogEnvId('ws-missing')).toBeNull();
    });
  });

  describe('linkedTaskStatus', () => {
    it('returns null when the PR has no linked task', async () => {
      expect(await linkedTaskStatus(null)).toBeNull();
    });

    it('returns null when the linked task row no longer exists', async () => {
      expect(await linkedTaskStatus('task-gone')).toBeNull();
    });

    it.each(['queued', 'in_progress', 'completed', 'failed'])(
      'returns the current status (%s) of the linked task',
      async (status) => {
        const now = new Date();
        await db.insert(tasksTable).values({
          id: `task-${status}`,
          workspaceId: 'ws1',
          type: 'pr_response',
          status,
          title: 't',
          description: '',
          priority: 'medium',
          createdAt: now,
          updatedAt: now,
        });

        expect(await linkedTaskStatus(`task-${status}`)).toBe(status);
      }
    );
  });
});
