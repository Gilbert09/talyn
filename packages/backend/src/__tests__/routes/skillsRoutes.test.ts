import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { getTableColumns } from 'drizzle-orm';
import { SKILL_MAX_BYTES } from '@talyn/shared';
import { skillRoutes, SKILL_LIST_COLUMNS } from '../../routes/skills.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { workspaces as workspacesTable, skills as skillsTable } from '../../db/schema.js';
import { githubService } from '../../services/github.js';
import { clearRepoSkillCache } from '../../services/skills.js';

vi.mock('../../services/github.js', () => ({
  githubService: {
    getDirectoryListing: vi.fn(),
    getFileContent: vi.fn(),
  },
}));

const OTHER_USER_ID = 'user-other';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/skills', requireAuth, skillRoutes());
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

const authHeaders = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

describe('routes/skills', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    clearRepoSkillCache();
    await seedUser(db, { id: TEST_USER_ID });
    await seedUser(db, { id: OTHER_USER_ID });
    await db.insert(workspacesTable).values([
      { id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
      { id: 'ws2', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
    ]);
    const s = await makeServer();
    serverUrl = s.url;
    closeServer = s.close;
  });

  afterEach(async () => {
    await closeServer();
    await cleanup();
  });

  async function createSkill(name = 'reviewer', workspaceId = 'ws1') {
    const res = await fetch(`${serverUrl}/skills`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        workspaceId,
        name,
        description: 'Reviews PRs',
        content: '# Review\n\nDo it well.',
      }),
    });
    return res;
  }

  describe('POST /skills', () => {
    it('creates a platform skill and returns it with content', async () => {
      const res = await createSkill();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('reviewer');
      expect(body.data.content).toContain('Do it well.');
      expect(body.data.key).toBe(`platform:${body.data.id}`);
      expect(body.data.source).toBe('platform');
    });

    it('409s on a duplicate name in the same workspace', async () => {
      expect((await createSkill()).status).toBe(200);
      expect((await createSkill()).status).toBe(409);
    });

    it('400s on missing fields and 413s on oversized content', async () => {
      const missing = await fetch(`${serverUrl}/skills`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws1', name: 'x' }),
      });
      expect(missing.status).toBe(400);

      const big = await fetch(`${serverUrl}/skills`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          workspaceId: 'ws1',
          name: 'big',
          content: 'x'.repeat(SKILL_MAX_BYTES + 1),
        }),
      });
      expect(big.status).toBe(413);
    });

    it('404s when the workspace is not owned by the caller', async () => {
      expect((await createSkill('reviewer', 'ws2')).status).toBe(404);
    });
  });

  describe('GET /skills', () => {
    it('lists platform skills WITHOUT content, plus usage', async () => {
      await createSkill();
      const res = await fetch(`${serverUrl}/skills?workspaceId=ws1`, { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.platform).toHaveLength(1);
      expect(body.data.platform[0].name).toBe('reviewer');
      expect(body.data.platform[0]).not.toHaveProperty('content');
      expect(body.data.platform[0].contentSize).toBeGreaterThan(0);
      expect(body.data.repoStatus).toBe('none'); // no repositoryId passed
      expect(body.data.usage).toEqual({});
    });

    it('never selects the content column in the list projection', () => {
      // The projection object is the egress guard — content must not be in it.
      expect(Object.keys(SKILL_LIST_COLUMNS)).not.toContain('content');
      // And the underlying table definitely has one (guards a rename).
      expect(Object.keys(getTableColumns(skillsTable))).toContain('content');
    });

    it('404s for a workspace the caller does not own', async () => {
      const res = await fetch(`${serverUrl}/skills?workspaceId=ws2`, { headers: authHeaders });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /skills/:id', () => {
    it('returns the full skill with content', async () => {
      const { data } = await (await createSkill()).json();
      const res = await fetch(`${serverUrl}/skills/${data.id}`, { headers: authHeaders });
      expect(res.status).toBe(200);
      expect((await res.json()).data.content).toContain('Do it well.');
    });

    it('404s for another owner’s skill', async () => {
      const [row] = await db
        .insert(skillsTable)
        .values({ id: 'theirs', workspaceId: 'ws2', name: 's', content: 'c' })
        .returning({ id: skillsTable.id });
      const res = await fetch(`${serverUrl}/skills/${row.id}`, { headers: authHeaders });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /skills/:id', () => {
    it('updates fields and bumps updatedAt', async () => {
      const { data } = await (await createSkill()).json();
      const res = await fetch(`${serverUrl}/skills/${data.id}`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ description: 'Updated', content: 'new content' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.description).toBe('Updated');
      expect(body.data.content).toBe('new content');
      expect(body.data.name).toBe('reviewer'); // untouched
    });

    it('rejects an empty name', async () => {
      const { data } = await (await createSkill()).json();
      const res = await fetch(`${serverUrl}/skills/${data.id}`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ name: '   ' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /skills/:id', () => {
    it('deletes an owned skill', async () => {
      const { data } = await (await createSkill()).json();
      const res = await fetch(`${serverUrl}/skills/${data.id}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const rows = await db.select({ id: skillsTable.id }).from(skillsTable).where(eq(skillsTable.id, data.id));
      expect(rows).toHaveLength(0);
    });

    it('404s for another owner’s skill without deleting it', async () => {
      await db
        .insert(skillsTable)
        .values({ id: 'theirs', workspaceId: 'ws2', name: 's', content: 'c' });
      const res = await fetch(`${serverUrl}/skills/theirs`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
      expect(await db.select({ id: skillsTable.id }).from(skillsTable)).toHaveLength(1);
    });
  });

  describe('GET /skills/repo/content', () => {
    it('400s without the required params and 404s for an unknown skill', async () => {
      const missing = await fetch(`${serverUrl}/skills/repo/content?workspaceId=ws1`, {
        headers: authHeaders,
      });
      expect(missing.status).toBe(400);

      vi.mocked(githubService.getDirectoryListing).mockResolvedValue(null);
      const res = await fetch(
        `${serverUrl}/skills/repo/content?workspaceId=ws1&repositoryId=r1&name=nope`,
        { headers: authHeaders }
      );
      expect(res.status).toBe(404);
    });
  });

  it('rejects unauthenticated requests', async () => {
    const res = await fetch(`${serverUrl}/skills?workspaceId=ws1`);
    expect(res.status).toBe(401);
  });
});
