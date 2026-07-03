import { createHash, randomBytes } from 'crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { CreateMcpTokenResponse, McpToken } from '@talyn/shared';
import { getDbClient, getPoolDbClient } from '../db/client.js';
import { mcpTokens as mcpTokensTable } from '../db/schema.js';

const TOKEN_BYTES = 32;
const TOKEN_PREFIX = 'talyn_mcp_';
/**
 * Pre-rename prefix. Never minted anymore, but tokens created before the
 * Talyn rename stay valid until they expire or are revoked — validation
 * accepts both.
 */
const LEGACY_TOKEN_PREFIX = 'fowl_mcp_';
/** Chars of the random body kept in `token_prefix` for display disambiguation. */
const DISPLAY_BODY_CHARS = 6;
const DEFAULT_EXPIRY_DAYS = 90;

/** SHA-256 hex of the full token — what we persist (never the plaintext). */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Columns safe to return to the client — never the hash. */
const PUBLIC_COLUMNS = {
  id: mcpTokensTable.id,
  name: mcpTokensTable.name,
  tokenPrefix: mcpTokensTable.tokenPrefix,
  createdAt: mcpTokensTable.createdAt,
  lastUsedAt: mcpTokensTable.lastUsedAt,
  expiresAt: mcpTokensTable.expiresAt,
} as const;

type PublicRow = {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
};

function rowToToken(row: PublicRow): McpToken {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}

/**
 * Mint a new personal MCP token for `ownerId`. Runs owner-scoped (the route
 * mounts it after ownerScope), so the insert's `owner_id` is the caller's and
 * RLS's WITH CHECK passes. Returns the plaintext token exactly once.
 */
export async function createToken(
  ownerId: string,
  opts: { name?: string; expiresInDays?: number | null } = {}
): Promise<CreateMcpTokenResponse> {
  const body = randomBytes(TOKEN_BYTES).toString('base64url');
  const token = `${TOKEN_PREFIX}${body}`;
  const tokenPrefix = `${TOKEN_PREFIX}${body.slice(0, DISPLAY_BODY_CHARS)}`;

  const days =
    opts.expiresInDays === null || opts.expiresInDays === 0
      ? null
      : (opts.expiresInDays ?? DEFAULT_EXPIRY_DAYS);
  const now = new Date();
  const expiresAt = days != null ? new Date(now.getTime() + days * 86_400_000) : null;

  const db = getDbClient();
  const [row] = await db
    .insert(mcpTokensTable)
    .values({
      id: uuid(),
      ownerId,
      name: opts.name?.trim() || 'MCP token',
      tokenPrefix,
      tokenHash: hashToken(token),
      createdAt: now,
      expiresAt,
    })
    .returning(PUBLIC_COLUMNS);

  return { token, token_meta: rowToToken(row) };
}

/** List the caller's active (non-revoked) tokens, newest first. */
export async function listTokens(ownerId: string): Promise<McpToken[]> {
  const db = getDbClient();
  const rows = await db
    .select(PUBLIC_COLUMNS)
    .from(mcpTokensTable)
    .where(and(eq(mcpTokensTable.ownerId, ownerId), isNull(mcpTokensTable.revokedAt)))
    .orderBy(desc(mcpTokensTable.createdAt));
  return rows.map(rowToToken);
}

/**
 * Soft-revoke a token. Returns true if a matching active token was revoked.
 * Owner-scoped, so a foreign id simply matches nothing.
 */
export async function revokeToken(ownerId: string, id: string): Promise<boolean> {
  const db = getDbClient();
  const revoked = await db
    .update(mcpTokensTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(mcpTokensTable.id, id),
        eq(mcpTokensTable.ownerId, ownerId),
        isNull(mcpTokensTable.revokedAt)
      )
    )
    .returning({ id: mcpTokensTable.id });
  return revoked.length > 0;
}

/**
 * Resolve a raw bearer token to its owner, or null if invalid. Runs on the
 * UNSCOPED pool (the `/mcp` endpoint sits before requireAuth/ownerScope, so
 * there's no JWT context) — the pool's privileged role bypasses RLS, which is
 * exactly what lets us look a token up by hash across all owners. Rejects
 * revoked / expired tokens and bumps `last_used_at` on success.
 */
export async function validateToken(rawToken: string): Promise<{ ownerId: string } | null> {
  const trimmed = rawToken.trim();
  if (!trimmed.startsWith(TOKEN_PREFIX) && !trimmed.startsWith(LEGACY_TOKEN_PREFIX)) {
    return null;
  }

  const db = getPoolDbClient();
  const [row] = await db
    .select({
      id: mcpTokensTable.id,
      ownerId: mcpTokensTable.ownerId,
      expiresAt: mcpTokensTable.expiresAt,
      revokedAt: mcpTokensTable.revokedAt,
    })
    .from(mcpTokensTable)
    .where(eq(mcpTokensTable.tokenHash, hashToken(trimmed)))
    .limit(1);

  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  // Recency stamp for the settings list. Tolerate a write failure — a flaky
  // stamp must never reject an otherwise-valid token.
  try {
    await db
      .update(mcpTokensTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(mcpTokensTable.id, row.id));
  } catch {
    /* ignore */
  }

  return { ownerId: row.ownerId };
}
