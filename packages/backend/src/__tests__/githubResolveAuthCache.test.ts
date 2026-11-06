import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { githubService } from '../services/github.js';
import * as githubApp from '../services/githubApp.js';
import { encryptString, decryptString, type EncryptedEnvelope } from '../services/tokenCrypto.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces as workspacesTable, integrations as integrationsTable } from '../db/schema.js';

/**
 * `resolveAuth` reads the integration row on every call, but ships `config`
 * only when its md5 differs from the copy the service already holds. These
 * pin that the credential still follows the database on the very next call.
 */

type AuthRow = { id: string; enabled: boolean; config: unknown; configHash: string; version: string } | undefined;
const GitHubServiceClass = githubService.constructor as unknown as {
  readAuthRow: (db: Database, workspaceId: string, knownHash: string | null) => Promise<AuthRow>;
};

describe('github resolveAuth config cache', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const originalEnv = { ...process.env };
  const where = and(eq(integrationsTable.workspaceId, 'ws1'), eq(integrationsTable.type, 'github'));

  beforeEach(async () => {
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} });
    for (const ws of githubService.getConnectedWorkspaces()) {
      await githubService.removeToken(ws).catch(() => {});
    }
  });

  afterEach(async () => {
    for (const ws of githubService.getConnectedWorkspaces()) {
      await githubService.removeToken(ws).catch(() => {});
    }
    await cleanup();
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  const spyReads = () => vi.spyOn(GitHubServiceClass, 'readAuthRow');
  const resultOf = async (spy: ReturnType<typeof spyReads>, call: number) =>
    (await spy.mock.results[call].value) as AuthRow;

  describe('readAuthRow', () => {
    beforeEach(async () => {
      await githubService.storeToken('ws1', 'ghu_a', 'bearer', 'repo');
    });

    it('ships config when the caller holds none', async () => {
      const row = await GitHubServiceClass.readAuthRow(db, 'ws1', null);
      expect(row?.config).toMatchObject({ tokenType: 'bearer' });
      expect(row?.configHash).toMatch(/^[0-9a-f]{32}$/);
      expect(row?.version).toEqual(expect.any(String));
    });

    it.each([
      { label: 'matching hash', known: (h: string) => h, shipsConfig: false },
      { label: 'stale hash', known: () => '0'.repeat(32), shipsConfig: true },
      { label: 'empty hash', known: () => '', shipsConfig: true },
    ])('with a $label ships config: $shipsConfig', async ({ known, shipsConfig }) => {
      const first = await GitHubServiceClass.readAuthRow(db, 'ws1', null);
      const row = await GitHubServiceClass.readAuthRow(db, 'ws1', known(first!.configHash));
      expect(row?.id).toBe(first?.id);
      expect(row?.enabled).toBe(true);
      expect(row?.configHash).toBe(first?.configHash);
      if (shipsConfig) expect(row?.config).toEqual(first?.config);
      else expect(row?.config).toBeNull();
    });

    it('answers undefined for a workspace with no row', async () => {
      expect(await GitHubServiceClass.readAuthRow(db, 'ws-none', null)).toBeUndefined();
    });
  });

  it('does not ship the config again while it is unchanged', async () => {
    await githubService.storeToken('ws1', 'ghu_a', 'bearer', 'repo');
    const spy = spyReads();
    for (let i = 0; i < 3; i++) expect(await githubService.getVerifiedAccessToken('ws1')).toBe('ghu_a');
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[0][2]).toBeNull();
    expect((await resultOf(spy, 0))?.config).not.toBeNull();
    for (const call of [1, 2]) {
      expect(spy.mock.calls[call][2]).toBe((await resultOf(spy, 0))?.configHash);
      expect((await resultOf(spy, call))?.config).toBeNull();
    }
  });

  it.each([
    {
      label: 'a reconnect',
      change: () => githubService.storeToken('ws1', 'ghu_b', 'bearer', 'repo'),
    },
    {
      label: 'a raw config write that leaves updated_at alone',
      change: async () => {
        const [row] = await db.select({ updatedAt: integrationsTable.updatedAt }).from(integrationsTable).where(where);
        await db
          .update(integrationsTable)
          .set({ config: { accessTokenEnc: encryptString('ghu_b'), tokenType: 'bearer' }, updatedAt: row.updatedAt })
          .where(where);
      },
    },
    {
      label: 'a delete and re-insert by another replica',
      change: async () => {
        await db.delete(integrationsTable).where(where);
        await db.insert(integrationsTable).values({
          id: 'gh-new',
          workspaceId: 'ws1',
          type: 'github',
          config: { accessTokenEnc: encryptString('ghu_b'), tokenType: 'bearer' },
        });
      },
    },
  ])('reloads the config after $label', async ({ change }) => {
    await githubService.storeToken('ws1', 'ghu_a', 'bearer', 'repo');
    expect(await githubService.getVerifiedAccessToken('ws1')).toBe('ghu_a');
    await change();
    const spy = spyReads();
    expect(await githubService.getVerifiedAccessToken('ws1')).toBe('ghu_b');
    expect((await resultOf(spy, 0))?.config).not.toBeNull();
    expect(await githubService.getVerifiedAccessToken('ws1')).toBe('ghu_b');
    expect((await resultOf(spy, 1))?.config).toBeNull();
  });

  it.each([
    { label: 'disabled', change: () => db.update(integrationsTable).set({ enabled: false }).where(where) },
    { label: 'deleted', change: () => db.delete(integrationsTable).where(where) },
  ])('stops granting access on the very next call once the row is $label', async ({ change }) => {
    await githubService.storeToken('ws1', 'ghu_a', 'bearer', 'repo');
    expect(await githubService.getVerifiedAccessToken('ws1')).toBe('ghu_a');
    expect(await githubService.getVerifiedAccessToken('ws1')).toBe('ghu_a');
    await change();
    expect(await githubService.getVerifiedAccessToken('ws1')).toBeNull();
    expect(githubService.getAccessToken('ws1')).toBeNull();
  });

  it('grants access again when a disabled row with the same config is re-enabled', async () => {
    await githubService.storeToken('ws1', 'ghu_a', 'bearer', 'repo');
    expect(await githubService.getVerifiedAccessToken('ws1')).toBe('ghu_a');
    await db.update(integrationsTable).set({ enabled: false }).where(where);
    expect(await githubService.getVerifiedAccessToken('ws1')).toBeNull();
    await db.update(integrationsTable).set({ enabled: true }).where(where);
    expect(await githubService.getVerifiedAccessToken('ws1')).toBe('ghu_a');
  });

  it('rotates a token that nears expiry while its config is served from the cache', async () => {
    const realNow = Date.now();
    await githubService.storeToken('ws1', 'ghu_old', 'bearer', 'repo', {
      refreshToken: 'ghr_old',
      accessTokenExpiresAt: realNow + 60 * 60_000,
    });
    expect(await githubService.getVerifiedAccessToken('ws1')).toBe('ghu_old');

    vi.spyOn(Date, 'now').mockReturnValue(realNow + 58 * 60_000);
    const refresh = vi.spyOn(githubApp, 'refreshUserToken').mockResolvedValue({
      access_token: 'ghu_rotated', token_type: 'bearer', scope: 'repo', expiresInSec: 28800,
    });
    const spy = spyReads();
    expect(await githubService.getVerifiedAccessToken('ws1')).toBe('ghu_rotated');
    expect(refresh).toHaveBeenCalledTimes(1);
    // The refresh started from the cached copy, and the conditional write still matched.
    expect((await resultOf(spy, 0))?.config).toBeNull();
    const [row] = await db.select({ config: integrationsTable.config }).from(integrationsTable).where(where);
    expect(decryptString((row.config as { accessTokenEnc: EncryptedEnvelope }).accessTokenEnc)).toBe('ghu_rotated');
  });

  it('does not persist a refresh whose snapshot was replaced while it ran', async () => {
    const realNow = Date.now();
    await githubService.storeToken('ws1', 'ghu_old', 'bearer', 'repo', {
      refreshToken: 'ghr_old',
      accessTokenExpiresAt: realNow + 60 * 60_000,
    });
    expect(await githubService.getVerifiedAccessToken('ws1')).toBe('ghu_old');
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 58 * 60_000);
    vi.spyOn(githubApp, 'refreshUserToken').mockImplementation(async () => {
      await db
        .update(integrationsTable)
        .set({ config: { accessTokenEnc: encryptString('ghu_replacement'), tokenType: 'bearer' } })
        .where(where);
      return { access_token: 'ghu_obsolete', token_type: 'bearer', scope: 'repo', expiresInSec: 28800 };
    });
    expect(await githubService.getVerifiedAccessToken('ws1')).toBe('ghu_replacement');
    const [row] = await db.select({ config: integrationsTable.config }).from(integrationsTable).where(where);
    expect(decryptString((row.config as { accessTokenEnc: EncryptedEnvelope }).accessTokenEnc)).toBe('ghu_replacement');
  });
});
