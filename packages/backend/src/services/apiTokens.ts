import { createHash, randomBytes } from 'crypto';
import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import {
  API_SCOPES,
  API_TOKEN_DEFAULT_EXPIRY_DAYS,
  API_TOKEN_MAX_EXPIRY_DAYS,
  API_TOKEN_NAME_MAX,
  API_TOKEN_PREFIX,
  isApiScope,
  type ApiScope,
  type ApiToken,
  type CreateApiTokenRequest,
  type CreateApiTokenResponse,
} from '@talyn/shared';
import { getPoolDbClient } from '../db/client.js';
import { apiTokens as tokensTable, users as usersTable, workspaces as workspacesTable } from '../db/schema.js';
import { AuthError, enforceAllowList } from '../middleware/auth.js';

/**
 * Personal access tokens for the public API (`/v1`). The model is the MCP
 * token's (`mcpToken.ts`): random body, SHA-256 at rest, plaintext shown once,
 * soft revoke. Added: scopes, an optional workspace binding and a last-used
 * stamp written at most once a minute.
 *
 * Every query runs on the POOL. The table has no RLS policy: `/v1` requests
 * carry no Supabase JWT, and the management routes pass the caller's id into
 * every query here.
 */

const TOKEN_BYTES = 32;
/** Characters of the random body kept in `token_prefix`, to tell tokens apart in a list. */
const DISPLAY_BODY_CHARS = 6;
/** How old `last_used_at` must be before a request writes it again. One write per minute per token at most. */
const LAST_USED_RESOLUTION_MS = 60_000;

export function hashApiToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** A refusal of a create request, with the field it is about. */
export class ApiTokenInputError extends Error {
  constructor(message: string, readonly param: string) {
    super(message);
    this.name = 'ApiTokenInputError';
  }
}

const PUBLIC_COLUMNS = {
  id: tokensTable.id,
  name: tokensTable.name,
  tokenPrefix: tokensTable.tokenPrefix,
  scopes: tokensTable.scopes,
  workspaceIds: tokensTable.workspaceIds,
  createdAt: tokensTable.createdAt,
  lastUsedAt: tokensTable.lastUsedAt,
  expiresAt: tokensTable.expiresAt,
} as const;

type PublicRow = Pick<typeof tokensTable.$inferSelect, keyof typeof PUBLIC_COLUMNS>;

function rowToToken(row: PublicRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes: row.scopes.filter(isApiScope),
    workspaceIds: row.workspaceIds ?? null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}

/** The checked form of a create request. */
export interface ValidApiTokenInput {
  name: string;
  scopes: ApiScope[];
  workspaceIds: string[] | null;
  expiresInDays: number | null;
}

/** Check a create request. Throws {@link ApiTokenInputError}. Does not check workspace ownership. */
export function parseCreateApiTokenInput(body: Partial<CreateApiTokenRequest> | null | undefined): ValidApiTokenInput {
  const input = body ?? {};
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new ApiTokenInputError('name is required', 'name');
  if (name.length > API_TOKEN_NAME_MAX) {
    throw new ApiTokenInputError(`name must be at most ${API_TOKEN_NAME_MAX} characters`, 'name');
  }

  if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
    throw new ApiTokenInputError(`scopes must be a non-empty list of: ${API_SCOPES.join(', ')}`, 'scopes');
  }
  const unknown = input.scopes.filter((s) => !isApiScope(s));
  if (unknown.length > 0) {
    throw new ApiTokenInputError(`unknown scope: ${unknown.map(String).join(', ')}`, 'scopes');
  }
  // Stored in the register's order, once each, so two equal tokens list the same.
  const scopes = API_SCOPES.filter((s) => (input.scopes as string[]).includes(s));

  let workspaceIds: string[] | null = null;
  if (input.workspaceIds !== undefined && input.workspaceIds !== null) {
    if (!Array.isArray(input.workspaceIds) || input.workspaceIds.some((id) => typeof id !== 'string' || !id)) {
      throw new ApiTokenInputError('workspaceIds must be a list of workspace ids, or null for every workspace', 'workspaceIds');
    }
    workspaceIds = [...new Set(input.workspaceIds)];
    if (workspaceIds.length === 0) {
      throw new ApiTokenInputError('workspaceIds must name at least one workspace, or be null for every workspace', 'workspaceIds');
    }
  }

  let expiresInDays: number | null = API_TOKEN_DEFAULT_EXPIRY_DAYS;
  if (input.expiresInDays === null) {
    expiresInDays = null;
  } else if (input.expiresInDays !== undefined) {
    const days = input.expiresInDays;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > API_TOKEN_MAX_EXPIRY_DAYS) {
      throw new ApiTokenInputError(
        `expiresInDays must be a whole number from 1 to ${API_TOKEN_MAX_EXPIRY_DAYS}, or null for no expiry`,
        'expiresInDays',
      );
    }
    expiresInDays = days;
  }

  return { name, scopes, workspaceIds, expiresInDays };
}

/**
 * Mint a token for `ownerId`. A workspace binding must name the owner's own
 * workspaces; a foreign or unknown id is refused as one the owner does not have.
 * Returns the plaintext once.
 */
export async function createApiToken(
  ownerId: string,
  input: ValidApiTokenInput,
  opts: { ip?: string | null; now?: Date } = {},
): Promise<CreateApiTokenResponse> {
  const db = getPoolDbClient();
  if (input.workspaceIds) {
    const owned = await db
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(and(eq(workspacesTable.ownerId, ownerId), inArray(workspacesTable.id, input.workspaceIds)));
    if (owned.length !== input.workspaceIds.length) {
      throw new ApiTokenInputError('workspaceIds names a workspace you do not have', 'workspaceIds');
    }
  }

  const body = randomBytes(TOKEN_BYTES).toString('base64url');
  const token = `${API_TOKEN_PREFIX}${body}`;
  const now = opts.now ?? new Date();
  const expiresAt = input.expiresInDays === null ? null : new Date(now.getTime() + input.expiresInDays * 86_400_000);

  const [row] = await db
    .insert(tokensTable)
    .values({
      id: uuid(),
      ownerId,
      name: input.name,
      tokenPrefix: `${API_TOKEN_PREFIX}${body.slice(0, DISPLAY_BODY_CHARS)}`,
      tokenHash: hashApiToken(token),
      scopes: input.scopes,
      workspaceIds: input.workspaceIds,
      createdAt: now,
      expiresAt,
      createdByIp: opts.ip ?? null,
    })
    .returning(PUBLIC_COLUMNS);

  return { token, apiToken: rowToToken(row) };
}

/** The owner's tokens that are not revoked, newest first. Expired ones stay, so the list can say so. */
export async function listApiTokens(ownerId: string): Promise<ApiToken[]> {
  const rows = await getPoolDbClient()
    .select(PUBLIC_COLUMNS)
    .from(tokensTable)
    .where(and(eq(tokensTable.ownerId, ownerId), isNull(tokensTable.revokedAt)))
    .orderBy(desc(tokensTable.createdAt));
  return rows.map(rowToToken);
}

/** Soft-revoke. False when the id is not one of the owner's live tokens. */
export async function revokeApiToken(ownerId: string, id: string): Promise<boolean> {
  const revoked = await getPoolDbClient()
    .update(tokensTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(tokensTable.id, id), eq(tokensTable.ownerId, ownerId), isNull(tokensTable.revokedAt)))
    .returning({ id: tokensTable.id });
  return revoked.length > 0;
}

/** Who a valid token acts for, and what it may do. */
export interface ApiTokenPrincipal {
  tokenId: string;
  name: string;
  ownerId: string;
  email: string;
  isAdmin: boolean;
  scopes: ApiScope[];
  /** Null: every workspace of the owner. */
  workspaceIds: string[] | null;
  expiresAt: Date | null;
}

export type ApiTokenRefusal = 'invalid_token' | 'token_revoked' | 'token_expired' | 'account_not_allowed';

export type ApiTokenValidation = { ok: true; principal: ApiTokenPrincipal } | { ok: false; reason: ApiTokenRefusal };

/**
 * Resolve a raw bearer token. One indexed lookup by hash, on the pool. A
 * token of another kind (a Supabase JWT, an MCP token) is `invalid_token`:
 * `/v1` accepts personal access tokens only.
 */
export async function validateApiToken(rawToken: string, now = new Date()): Promise<ApiTokenValidation> {
  const raw = rawToken.trim();
  if (!raw.startsWith(API_TOKEN_PREFIX) || raw.length <= API_TOKEN_PREFIX.length) {
    return { ok: false, reason: 'invalid_token' };
  }
  const db = getPoolDbClient();
  const [row] = await db
    .select({
      id: tokensTable.id,
      name: tokensTable.name,
      ownerId: tokensTable.ownerId,
      scopes: tokensTable.scopes,
      workspaceIds: tokensTable.workspaceIds,
      expiresAt: tokensTable.expiresAt,
      revokedAt: tokensTable.revokedAt,
      lastUsedAt: tokensTable.lastUsedAt,
      email: usersTable.email,
      isAdmin: usersTable.isAdmin,
    })
    .from(tokensTable)
    .innerJoin(usersTable, eq(usersTable.id, tokensTable.ownerId))
    .where(eq(tokensTable.tokenHash, hashApiToken(raw)))
    .limit(1);

  if (!row) return { ok: false, reason: 'invalid_token' };
  if (row.revokedAt) return { ok: false, reason: 'token_revoked' };
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'token_expired' };
  try {
    enforceAllowList(row.email);
  } catch (err) {
    if (err instanceof AuthError && err.code === 'forbidden') return { ok: false, reason: 'account_not_allowed' };
    throw err;
  }

  // Awaited: it runs at most once a minute per token, and a write left running
  // past the response would outlive the request that owns it.
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS) {
    await stampLastUsed(row.id, now);
  }

  return {
    ok: true,
    principal: {
      tokenId: row.id,
      name: row.name,
      ownerId: row.ownerId,
      email: row.email,
      isAdmin: row.isAdmin,
      scopes: row.scopes.filter(isApiScope),
      workspaceIds: row.workspaceIds ?? null,
      expiresAt: row.expiresAt,
    },
  };
}

/**
 * Write `last_used_at`, but only when the stored value is a minute old: two
 * replicas that read the same old stamp write it once between them. A failed
 * write never refuses a valid token.
 */
async function stampLastUsed(tokenId: string, now: Date): Promise<void> {
  try {
    await getPoolDbClient()
      .update(tokensTable)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(tokensTable.id, tokenId),
          or(isNull(tokensTable.lastUsedAt), lt(tokensTable.lastUsedAt, new Date(now.getTime() - LAST_USED_RESOLUTION_MS))),
        ),
      );
  } catch (err) {
    console.warn('[api-tokens] could not stamp last_used_at:', err instanceof Error ? err.message : err);
  }
}
