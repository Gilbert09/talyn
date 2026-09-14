import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { integrations, workspaces } from '../db/schema.js';
import { encryptString } from '../services/tokenCrypto.js';
import { githubService } from '../services/github.js';
import type { Database } from '../db/client.js';

vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));

/**
 * The webhook fan-out checks repository access once per watching workspace, per
 * delivery, and `check_run` is a firehose. These cases pin the two properties
 * that have to hold together: the check must not cost a live GitHub call every
 * time, AND a credential revoked in the database must stop granting access at
 * once. A cache keyed on the workspace would satisfy the first and break the
 * second.
 */
describe('repository access caching', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  async function connect(workspaceId: string, token: string): Promise<void> {
    await db.insert(workspaces).values({ id: workspaceId, ownerId: 'owner-a', name: workspaceId });
    await db.insert(integrations).values({
      id: `int-${workspaceId}`,
      workspaceId,
      type: 'github',
      enabled: true,
      config: { accessTokenEnc: encryptString(token), tokenType: 'bearer', scope: 'repo' },
    });
  }

  const okResponse = (): Response =>
    new Response(JSON.stringify({ full_name: 'acme/widget' }), { status: 200 });

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: 'owner-a' });
    githubService._resetAuthorizationCaches();
  });

  afterEach(async () => {
    githubService._resetAuthorizationCaches();
    await cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('answers repeat checks without another GitHub call', async () => {
    await connect('ws-a', 'token-a');
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    for (let i = 0; i < 5; i++) {
      expect(await githubService.canAccessRepository('ws-a', 'acme', 'widget')).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares nothing between two workspaces on different credentials', async () => {
    await connect('ws-a', 'token-a');
    await connect('ws-b', 'token-b');
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    expect(await githubService.canAccessRepository('ws-a', 'acme', 'widget')).toBe(true);
    expect(await githubService.canAccessRepository('ws-b', 'acme', 'widget')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one answer between two workspaces on the SAME credential', async () => {
    // Identical token, identical permissions — no tenant boundary is crossed.
    await connect('ws-a', 'shared-token');
    await connect('ws-b', 'shared-token');
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    expect(await githubService.canAccessRepository('ws-a', 'acme', 'widget')).toBe(true);
    expect(await githubService.canAccessRepository('ws-b', 'acme', 'widget')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['deleted', 'disabled', 'replaced'])(
    'refuses at once after the integration is %s elsewhere', async (change) => {
      await connect('ws-a', 'token-a');
      const fetchMock = vi.fn(async () => okResponse());
      vi.stubGlobal('fetch', fetchMock);
      expect(await githubService.canAccessRepository('ws-a', 'acme', 'widget')).toBe(true);

      const where = eq(integrations.workspaceId, 'ws-a');
      if (change === 'deleted') await db.delete(integrations).where(where);
      else if (change === 'disabled') await db.update(integrations).set({ enabled: false }).where(where);
      else {
        await db.update(integrations)
          .set({ config: { accessTokenEnc: encryptString('token-replacement') } })
          .where(where);
      }

      fetchMock.mockClear();
      if (change === 'replaced') {
        // A different credential asks a different question, so it is re-checked
        // rather than answered from the old token's entry.
        expect(await githubService.canAccessRepository('ws-a', 'acme', 'widget')).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } else {
        expect(await githubService.canAccessRepository('ws-a', 'acme', 'widget')).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
      }
    });

  it('never caches a non-answer as a refusal', async () => {
    await connect('ws-a', 'token-a');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(githubService.canAccessRepository('ws-a', 'acme', 'widget')).rejects.toThrow();
    expect(await githubService.canAccessRepository('ws-a', 'acme', 'widget')).toBe(true);
  });
});
