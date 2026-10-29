import { createHash, randomBytes } from 'crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getPoolDbClient } from '../db/client.js';
import {
  sessionMcpTokens,
  users,
  workbenchChats,
  workbenches,
  workspaces,
} from '../db/schema.js';
import { AuthError, enforceAllowList } from '../middleware/auth.js';
import { decryptString, encryptString } from './tokenCrypto.js';

/**
 * Talyn's own MCP credential for ONE session's sandbox.
 *
 * # Why the plaintext is recoverable
 *
 * The fleet seals an inline MCP secret on arrival and persists it nowhere, so a
 * fleetd restart asks us for it again (`resolveWorkbenchRunCredentials`). A
 * personal token is stored only as a hash and could not be handed back. So this
 * one is stored twice: the SHA-256 hash that validation looks up, and the
 * plaintext encrypted with the integration-token key. A deterministic HMAC of a
 * server secret was the other choice; it adds a second master secret to rotate
 * and gives nothing the encrypted row does not, because revocation is per row
 * either way.
 *
 * # Why a table of its own
 *
 * `mcp_tokens` is owner-scoped: the user's settings page lists it, and the
 * request role can read it. A recoverable credential belongs in a table that
 * only the backend pool can read, and a session's token is not the user's to
 * see or revoke one by one — it lives and dies with its session (the row
 * cascades with the workbench).
 */

/** Distinct from `talyn_mcp_` so the two kinds can never be looked up in the wrong table. */
export const SESSION_TOKEN_PREFIX = 'talyn_mcs_';
const TOKEN_BYTES = 32;

/**
 * A session a person started is depth 0, a session it starts is 1, and that
 * one's child is 2. A session at depth 2 may not start another: two levels is
 * enough to split work and then split one part again, and it is what bounds the
 * tree. Normal (user) tokens have no depth.
 */
export const MAX_SESSION_SPAWN_DEPTH = 2;

/**
 * create_session calls one session token may make per hour. Three because a
 * session asked to "split this up" rarely needs more parallel sessions than
 * that, and because the cap multiplies down the tree: one root can cause at
 * most 3 + 3 x 3 = 12 sandboxes an hour, each a 4 GiB microVM on our own
 * hardware. A person can always start more from the app.
 */
export const SESSION_CREATES_PER_HOUR = 3;

/** What a validated session token is bound to. */
export interface SessionMcpBinding {
  tokenId: string;
  workbenchId: string;
  depth: number;
}

export class SessionSpawnRefusedError extends Error {
  constructor(
    message: string,
    readonly reason: 'depth' | 'rate'
  ) {
    super(message);
    this.name = 'SessionSpawnRefusedError';
  }
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function isSessionMcpToken(raw: string): boolean {
  return raw.trim().startsWith(SESSION_TOKEN_PREFIX);
}

/**
 * The session's token in plaintext, minted on first use. Idempotent and safe
 * under a race: the unique index on `workbench_id` keeps one row, and every
 * caller answers with the row that won.
 */
export async function ensureSessionMcpToken(session: {
  id: string;
  workspaceId: string;
}): Promise<string> {
  const db = getPoolDbClient();
  const existing = await readSessionMcpToken(session.id);
  if (existing) return existing;

  const [owner] = await db
    .select({ ownerId: workspaces.ownerId })
    .from(workspaces)
    .where(eq(workspaces.id, session.workspaceId))
    .limit(1);
  if (!owner) throw new Error(`workspace ${session.workspaceId} not found`);

  const token = `${SESSION_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  await db
    .insert(sessionMcpTokens)
    .values({
      id: uuid(),
      workbenchId: session.id,
      ownerId: owner.ownerId,
      tokenHash: hashToken(token),
      tokenCiphertext: encryptString(token),
    })
    .onConflictDoNothing();
  const stored = await readSessionMcpToken(session.id);
  if (!stored) throw new Error(`minting the session MCP token for ${session.id} failed`);
  return stored;
}

/**
 * The session's token in plaintext, or null when none was minted. Minting
 * happens only when a box is created with the `talyn` server, so a row means
 * the box has the route the token is for.
 */
export async function readSessionMcpToken(workbenchId: string): Promise<string | null> {
  const [row] = await getPoolDbClient()
    .select({ tokenCiphertext: sessionMcpTokens.tokenCiphertext })
    .from(sessionMcpTokens)
    .where(eq(sessionMcpTokens.workbenchId, workbenchId))
    .limit(1);
  return row ? decryptString(row.tokenCiphertext) : null;
}

/** Revoke a session's token now. Deleting the session does the same through the cascade. */
export async function revokeSessionMcpToken(workbenchId: string): Promise<void> {
  await getPoolDbClient()
    .delete(sessionMcpTokens)
    .where(eq(sessionMcpTokens.workbenchId, workbenchId));
}

/** Only write the recency stamp once a minute: a turn can make many tool calls. */
const LAST_USED_RESOLUTION_MS = 60_000;

/**
 * Resolve a session token to its owner and session, or null. Runs on the pool
 * (the /mcp endpoint sits before ownerScope). Refused when the session is gone,
 * archived, not a sandbox session, or no longer in its owner's workspace, and
 * when the owner is outside the allow-list.
 */
export async function validateSessionMcpToken(
  rawToken: string
): Promise<{ ownerId: string; session: SessionMcpBinding } | null> {
  const trimmed = rawToken.trim();
  if (!trimmed.startsWith(SESSION_TOKEN_PREFIX)) return null;

  const db = getPoolDbClient();
  const [row] = await db
    .select({
      id: sessionMcpTokens.id,
      ownerId: sessionMcpTokens.ownerId,
      workbenchId: sessionMcpTokens.workbenchId,
      spawnDepth: sessionMcpTokens.spawnDepth,
      lastUsedAt: sessionMcpTokens.lastUsedAt,
      workspaceOwnerId: workspaces.ownerId,
      archivedAt: workbenches.archivedAt,
      runtime: workbenches.runtime,
      email: users.email,
    })
    .from(sessionMcpTokens)
    .innerJoin(workbenches, eq(workbenches.id, sessionMcpTokens.workbenchId))
    .innerJoin(workspaces, eq(workspaces.id, workbenches.workspaceId))
    .innerJoin(users, eq(users.id, sessionMcpTokens.ownerId))
    .where(eq(sessionMcpTokens.tokenHash, hashToken(trimmed)))
    .limit(1);

  if (!row) return null;
  if (row.workspaceOwnerId !== row.ownerId) return null;
  if (row.archivedAt || row.runtime !== 'sandbox') return null;
  try {
    enforceAllowList(row.email);
  } catch (err) {
    if (err instanceof AuthError && err.code === 'forbidden') return null;
    throw err;
  }

  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    try {
      await db
        .update(sessionMcpTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(sessionMcpTokens.id, row.id));
    } catch {
      /* a failed stamp must not refuse a valid token */
    }
  }

  return {
    ownerId: row.ownerId,
    session: { tokenId: row.id, workbenchId: row.workbenchId, depth: row.spawnDepth },
  };
}

/**
 * Take one create_session slot for a session token, or throw. Checked BEFORE
 * the session is created, so a create that then fails still spends its slot:
 * the cap is on attempts, which is what bounds a runaway agent.
 *
 * The window check and the count are one UPDATE, so two concurrent calls cannot
 * both take the last slot.
 */
export async function reserveSessionCreate(binding: SessionMcpBinding): Promise<void> {
  if (binding.depth + 1 > MAX_SESSION_SPAWN_DEPTH) {
    throw new SessionSpawnRefusedError(
      `This session was itself started by another session ${binding.depth} level(s) down, and ` +
        `sessions started by sessions stop at ${MAX_SESSION_SPAWN_DEPTH} levels. Do the work in ` +
        'this session, or ask the person to start a session from the Talyn app.',
      'depth'
    );
  }
  const expired = or(
    isNull(sessionMcpTokens.createsWindowStartedAt),
    sql`${sessionMcpTokens.createsWindowStartedAt} <= now() - interval '1 hour'`
  );
  const taken = await getPoolDbClient()
    .update(sessionMcpTokens)
    .set({
      createsInWindow: sql`CASE WHEN ${expired} THEN 1 ELSE ${sessionMcpTokens.createsInWindow} + 1 END`,
      createsWindowStartedAt: sql`CASE WHEN ${expired} THEN now() ELSE ${sessionMcpTokens.createsWindowStartedAt} END`,
    })
    .where(
      and(
        eq(sessionMcpTokens.id, binding.tokenId),
        or(expired, lt(sessionMcpTokens.createsInWindow, SESSION_CREATES_PER_HOUR))
      )
    )
    .returning({ id: sessionMcpTokens.id });
  if (taken.length === 0) {
    throw new SessionSpawnRefusedError(
      `This session has already started ${SESSION_CREATES_PER_HOUR} sessions in the last hour, ` +
        'which is the limit for a session. Wait, or ask the person to start more from the Talyn app.',
      'rate'
    );
  }
}

/**
 * Record that `childWorkbenchId` was started by the session `parent` is bound
 * to. The child's token is minted here if provisioning has not minted it yet,
 * so the depth is on the row before the child's first turn can ask for it.
 */
export async function recordSessionSpawn(
  childWorkbenchId: string,
  parent: SessionMcpBinding
): Promise<void> {
  const db = getPoolDbClient();
  const [child] = await db
    .select({ id: workbenches.id, workspaceId: workbenches.workspaceId })
    .from(workbenches)
    .where(eq(workbenches.id, childWorkbenchId))
    .limit(1);
  if (!child) return;
  await ensureSessionMcpToken(child);
  await db
    .update(sessionMcpTokens)
    .set({
      parentWorkbenchId: parent.workbenchId,
      spawnDepth: sql`GREATEST(${sessionMcpTokens.spawnDepth}, ${parent.depth + 1})`,
    })
    .where(eq(sessionMcpTokens.workbenchId, childWorkbenchId));
}

/** The session a chat belongs to, for the self-call guards. */
export async function chatWorkbenchId(chatId: string): Promise<string | null> {
  const [row] = await getPoolDbClient()
    .select({ workbenchId: workbenchChats.workbenchId })
    .from(workbenchChats)
    .where(eq(workbenchChats.id, chatId))
    .limit(1);
  return row?.workbenchId ?? null;
}
