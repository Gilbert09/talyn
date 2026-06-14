import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  ACTIVE_STATUSES,
  resolvePostHogEnvId,
  resolveCloudEnvId,
  linkedTaskStatus,
} from '../services/prCloudFix.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  integrations as integrationsTable,
  tasks as tasksTable,
} from '../db/schema.js';
import { encryptString } from '../services/tokenCrypto.js';
import { registerCloudProvider } from '../services/cloudProviders/registry.js';
import { postHogCodeProvider } from '../services/cloudProviders/posthog/provider.js';
import { claudeCodeProvider } from '../services/cloudProviders/claude/provider.js';

// resolveCloudEnvId resolves through the registry's hasCredentials check.
registerCloudProvider(postHogCodeProvider);
registerCloudProvider(claudeCodeProvider);

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

  describe('resolveCloudEnvId', () => {
    let priorKey: string | undefined;
    beforeAll(() => {
      // Seeding a Claude credential needs the token-encryption key.
      priorKey = process.env.FASTOWL_TOKEN_KEY;
      process.env.FASTOWL_TOKEN_KEY = randomBytes(32).toString('base64');
    });
    afterAll(() => {
      if (priorKey === undefined) delete process.env.FASTOWL_TOKEN_KEY;
      else process.env.FASTOWL_TOKEN_KEY = priorKey;
    });

    async function connectPostHog() {
      await db.insert(environmentsTable).values({
        id: 'env-ph', ownerId: TEST_USER_ID, name: 'PostHog Code', type: 'posthog_code', config: {},
      });
      await db.insert(integrationsTable).values({
        id: 'int-ph', workspaceId: 'ws1', type: 'posthog', enabled: true,
        config: { apiKey: 'k', projectId: '1' },
      });
    }
    async function connectClaude() {
      await db.insert(environmentsTable).values({
        id: 'env-cl', ownerId: TEST_USER_ID, name: 'Claude Code', type: 'claude_code', config: {},
      });
      await db.insert(integrationsTable).values({
        id: 'int-cl', workspaceId: 'ws1', type: 'claude_code', enabled: true,
        config: { anthropicKeyEnc: encryptString('sk-ant-test') },
      });
    }
    const setDefault = (v: string) =>
      db.update(workspacesTable).set({ settings: { defaultCloudProvider: v } }).where(eq(workspacesTable.id, 'ws1'));

    it('prefers PostHog Code when both are connected and no default is set', async () => {
      await connectPostHog();
      await connectClaude();
      expect(await resolveCloudEnvId('ws1')).toBe('env-ph');
    });

    it('honours a pinned default of claude_code', async () => {
      await connectPostHog();
      await connectClaude();
      await setDefault('claude_code');
      expect(await resolveCloudEnvId('ws1')).toBe('env-cl');
    });

    it("'ask' falls back to the deterministic order (PostHog) for backend tasks", async () => {
      await connectPostHog();
      await connectClaude();
      await setDefault('ask');
      expect(await resolveCloudEnvId('ws1')).toBe('env-ph');
    });

    it('falls back past a pinned provider that isn’t connected', async () => {
      await connectClaude(); // only Claude connected
      await setDefault('posthog_code');
      expect(await resolveCloudEnvId('ws1')).toBe('env-cl');
    });

    it('skips a provider whose env exists but has no credentials', async () => {
      // env marker present (lingers after disconnect) but no integration row
      await db.insert(environmentsTable).values({
        id: 'env-ph', ownerId: TEST_USER_ID, name: 'PostHog Code', type: 'posthog_code', config: {},
      });
      expect(await resolveCloudEnvId('ws1')).toBeNull();
    });

    it('returns null when no provider is connected', async () => {
      expect(await resolveCloudEnvId('ws1')).toBeNull();
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
