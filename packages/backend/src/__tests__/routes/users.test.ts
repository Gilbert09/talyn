import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { userRoutes } from '../../routes/users.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  users as usersTable,
  workspaces as workspacesTable,
  integrations as integrationsTable,
  repositories as repositoriesTable,
} from '../../db/schema.js';
import { githubService } from '../../services/github.js';
import { setSupabaseServiceClientForTesting } from '../../services/supabase.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const OTHER_USER_ID = 'user-other';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/users', requireAuth, userRoutes());
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function seed(db: Database): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await seedUser(db, { id: OTHER_USER_ID });
  await db.insert(workspacesTable).values([
    { id: 'ws-mine-1', ownerId: TEST_USER_ID, name: 'mine 1', settings: {} },
    { id: 'ws-mine-2', ownerId: TEST_USER_ID, name: 'mine 2', settings: {} },
    { id: 'ws-theirs', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
  ]);
  await db.insert(integrationsTable).values([
    { id: 'int-mine', workspaceId: 'ws-mine-1', type: 'github', config: {} },
    { id: 'int-theirs', workspaceId: 'ws-theirs', type: 'github', config: {} },
  ]);
  await db.insert(repositoriesTable).values([
    {
      id: 'repo-mine',
      workspaceId: 'ws-mine-1',
      name: 'me/repo',
      url: 'https://github.com/me/repo',
      defaultBranch: 'main',
    },
  ]);
}

const authHeaders = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

describe('routes/users', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env.FASTOWL_TOKEN_KEY = randomBytes(32).toString('base64');
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);
    const s = await makeServer();
    serverUrl = s.url;
    closeServer = s.close;
  });

  afterEach(async () => {
    for (const ws of githubService.getConnectedWorkspaces()) {
      await githubService.removeToken(ws).catch(() => {});
    }
    setSupabaseServiceClientForTesting(null);
    await closeServer();
    await cleanup();
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('DELETE /api/v1/users/me', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await fetch(`${serverUrl}/api/v1/users/me`, { method: 'DELETE' });
      expect(res.status).toBe(401);
    });

    it('deletes the user row and cascades to owned workspaces + children', async () => {
      const res = await fetch(`${serverUrl}/api/v1/users/me`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);

      const users = await db.select({ id: usersTable.id }).from(usersTable);
      expect(users.map((u) => u.id)).toEqual([OTHER_USER_ID]);

      const workspaces = await db.select({ id: workspacesTable.id }).from(workspacesTable);
      expect(workspaces.map((w) => w.id)).toEqual(['ws-theirs']);

      const integrations = await db
        .select({ id: integrationsTable.id })
        .from(integrationsTable);
      expect(integrations.map((i) => i.id)).toEqual(['int-theirs']);

      const repos = await db.select({ id: repositoriesTable.id }).from(repositoriesTable);
      expect(repos).toEqual([]);
    });

    it("leaves other users' data untouched", async () => {
      await fetch(`${serverUrl}/api/v1/users/me`, { method: 'DELETE', headers: authHeaders });

      const theirWorkspace = await db
        .select({ id: workspacesTable.id })
        .from(workspacesTable)
        .where(eq(workspacesTable.ownerId, OTHER_USER_ID));
      expect(theirWorkspace).toHaveLength(1);

      const theirUser = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.id, OTHER_USER_ID));
      expect(theirUser).toHaveLength(1);
    });

    it('purges in-memory GitHub state for the wiped workspaces', async () => {
      await githubService.storeToken('ws-mine-1', 'gho_token', 'bearer', 'repo');
      expect(githubService.isConnected('ws-mine-1')).toBe(true);

      await fetch(`${serverUrl}/api/v1/users/me`, { method: 'DELETE', headers: authHeaders });

      expect(githubService.isConnected('ws-mine-1')).toBe(false);
    });

    it('deletes the Supabase auth user when configured', async () => {
      process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
      const deleteUser = vi.fn().mockResolvedValue({ data: {}, error: null });
      setSupabaseServiceClientForTesting({
        auth: { admin: { deleteUser } },
      } as unknown as SupabaseClient);

      const res = await fetch(`${serverUrl}/api/v1/users/me`, {
        method: 'DELETE',
        headers: authHeaders,
      });

      expect(res.status).toBe(200);
      expect(deleteUser).toHaveBeenCalledWith(TEST_USER_ID);
    });

    it('still succeeds when the auth-user deletion fails', async () => {
      process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
      setSupabaseServiceClientForTesting({
        auth: { admin: { deleteUser: vi.fn().mockRejectedValue(new Error('boom')) } },
      } as unknown as SupabaseClient);

      const res = await fetch(`${serverUrl}/api/v1/users/me`, {
        method: 'DELETE',
        headers: authHeaders,
      });

      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);
      const users = await db.select({ id: usersTable.id }).from(usersTable);
      expect(users.map((u) => u.id)).toEqual([OTHER_USER_ID]);
    });
  });
});
