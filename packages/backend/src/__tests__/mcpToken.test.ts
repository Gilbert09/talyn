import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { mcpTokens as mcpTokensTable } from '../db/schema.js';
import {
  createToken,
  listTokens,
  revokeToken,
  validateToken,
} from '../services/mcpToken.js';

const OTHER_USER_ID = 'user-other';

describe('services/mcpToken', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID });
    await seedUser(db, { id: OTHER_USER_ID });
  });

  afterEach(async () => {
    await cleanup();
  });

  it('mints a token: returns plaintext once, stores only the hash, derives a prefix', async () => {
    const res = await createToken(TEST_USER_ID, { name: 'Laptop' });

    expect(res.token).toMatch(/^talyn_mcp_/);
    expect(res.token_meta.name).toBe('Laptop');
    expect(res.token_meta.tokenPrefix.startsWith('talyn_mcp_')).toBe(true);
    // The prefix is a short head — never the whole secret.
    expect(res.token.startsWith(res.token_meta.tokenPrefix)).toBe(true);
    expect(res.token_meta.tokenPrefix.length).toBeLessThan(res.token.length);

    const [row] = await db
      .select()
      .from(mcpTokensTable)
      .where(eq(mcpTokensTable.id, res.token_meta.id));
    expect(row.tokenHash).toBeTruthy();
    expect(row.tokenHash).not.toContain(res.token); // plaintext never persisted
    expect(row.tokenHash.length).toBe(64); // sha256 hex
  });

  it('defaults to a 90-day expiry; null/0 means non-expiring', async () => {
    const withDefault = await createToken(TEST_USER_ID);
    expect(withDefault.token_meta.expiresAt).toBeTruthy();
    const days = Math.round(
      (new Date(withDefault.token_meta.expiresAt!).getTime() - Date.now()) / 86_400_000
    );
    expect(days).toBe(90);

    const noExpiry = await createToken(TEST_USER_ID, { expiresInDays: null });
    expect(noExpiry.token_meta.expiresAt).toBeNull();
  });

  it('validates a fresh token, rejects unknown / revoked / expired, and bumps last_used_at', async () => {
    const { token, token_meta } = await createToken(TEST_USER_ID);

    const ok = await validateToken(token);
    expect(ok).toEqual({ ownerId: TEST_USER_ID });

    // last_used_at is stamped on a successful validate.
    const [afterUse] = await db
      .select()
      .from(mcpTokensTable)
      .where(eq(mcpTokensTable.id, token_meta.id));
    expect(afterUse.lastUsedAt).toBeTruthy();

    // Unknown token.
    expect(await validateToken('talyn_mcp_does-not-exist')).toBeNull();
    // Not even our prefix.
    expect(await validateToken('nope')).toBeNull();

    // Revoked.
    await revokeToken(TEST_USER_ID, token_meta.id);
    expect(await validateToken(token)).toBeNull();

    // Expired (insert one directly in the past).
    const expired = await createToken(TEST_USER_ID, { expiresInDays: 1 });
    await db
      .update(mcpTokensTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mcpTokensTable.id, expired.token_meta.id));
    expect(await validateToken(expired.token)).toBeNull();
  });

  it('still accepts legacy fowl_mcp_ tokens minted before the rename', async () => {
    // Simulate a pre-rename row: same storage shape, old prefix. Only the
    // hash is persisted, so validation is prefix-gate + hash lookup.
    const legacyToken = 'fowl_mcp_legacy-body-abc123';
    const { createHash } = await import('node:crypto');
    await db.insert(mcpTokensTable).values({
      id: 'legacy-token-id',
      ownerId: TEST_USER_ID,
      name: 'Pre-rename token',
      tokenPrefix: 'fowl_mcp_legacy',
      tokenHash: createHash('sha256').update(legacyToken).digest('hex'),
      createdAt: new Date(),
      expiresAt: null,
    });

    expect(await validateToken(legacyToken)).toEqual({ ownerId: TEST_USER_ID });
  });

  it('lists only the caller\'s active tokens and never returns the hash', async () => {
    await createToken(TEST_USER_ID, { name: 'a' });
    const second = await createToken(TEST_USER_ID, { name: 'b' });
    await createToken(OTHER_USER_ID, { name: 'theirs' });

    const mine = await listTokens(TEST_USER_ID);
    expect(mine.map((t) => t.name).sort()).toEqual(['a', 'b']);
    // Shape carries no secret material.
    expect(Object.keys(mine[0])).not.toContain('tokenHash');

    // Revoked tokens drop out of the list.
    await revokeToken(TEST_USER_ID, second.token_meta.id);
    const afterRevoke = await listTokens(TEST_USER_ID);
    expect(afterRevoke.map((t) => t.name)).toEqual(['a']);
  });

  it('revoke is owner-scoped: a foreign id matches nothing', async () => {
    const theirs = await createToken(OTHER_USER_ID, { name: 'theirs' });
    expect(await revokeToken(TEST_USER_ID, theirs.token_meta.id)).toBe(false);
    // Still valid for its real owner.
    expect(await validateToken(theirs.token)).toEqual({ ownerId: OTHER_USER_ID });
  });
});
