import { v4 as uuid } from 'uuid';
import { and, eq } from 'drizzle-orm';
import type { LinearConnection } from '@talyn/shared';
import { getPoolDbClient, type Database } from '../../db/client.js';
import { inboundConnections } from '../../db/schema.js';
import { withBlockingAdvisoryLock } from '../advisoryLock.js';
import { debugBus } from '../debugBus.js';
import { fetchWithTimeout } from '../httpTimeout.js';
import { decryptString, encryptString, isEncryptedEnvelope } from '../tokenCrypto.js';
import { getLinearAppConfig, LINEAR_REVOKE_URL, LINEAR_TOKEN_URL } from './config.js';
import { LinearAuthError } from './api.js';

/**
 * Linear connections: rows of `inbound_connections` with `kind = 'linear'`
 * and `external_account_id` = the Linear organization id.
 *
 * `credential_enc` holds the token pair as one encrypted JSON document.
 * `credential_meta` holds what is not secret: the app user id (Talyn's own
 * actor in that organization, for the self-echo check), the scopes, the
 * organization's name, and `reauthRequiredAt` when the grant is dead.
 *
 * Backend-pool only. Nothing outside this module decrypts the credential, and
 * no answer to a client carries it.
 */

const db = (): Database => getPoolDbClient();

export interface LinearTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms, or null when Linear gave no lifetime. */
  expiresAt: number | null;
}

export interface LinearMeta {
  appUserId?: string;
  scopes?: string[];
  organizationName?: string | null;
  urlKey?: string | null;
  reauthRequiredAt?: string | null;
  reauthReason?: string | null;
}

/** Refresh this long before the access token expires. Linear's tokens last 24 h. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** A token call. Linear answers in under a second. */
const TOKEN_TIMEOUT_MS = 15_000;

function readTokens(envelope: unknown): LinearTokens | null {
  if (!isEncryptedEnvelope(envelope)) return null;
  try {
    const doc = JSON.parse(decryptString(envelope)) as Partial<LinearTokens>;
    if (typeof doc.accessToken !== 'string' || !doc.accessToken) return null;
    return {
      accessToken: doc.accessToken,
      refreshToken: typeof doc.refreshToken === 'string' && doc.refreshToken ? doc.refreshToken : null,
      expiresAt: typeof doc.expiresAt === 'number' ? doc.expiresAt : null,
    };
  } catch {
    return null;
  }
}

export function sealTokens(tokens: LinearTokens) {
  return encryptString(JSON.stringify(tokens));
}

/** A token response, as the token endpoint answers it. */
export interface LinearTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

export function tokensFrom(doc: LinearTokenResponse, now: number, previousRefresh: string | null = null): LinearTokens {
  if (typeof doc.access_token !== 'string' || !doc.access_token) {
    throw new Error('Linear answered without an access token.');
  }
  return {
    accessToken: doc.access_token,
    // Linear rotates the refresh token on each refresh. Keep the old one only
    // when the answer has none.
    refreshToken: typeof doc.refresh_token === 'string' && doc.refresh_token ? doc.refresh_token : previousRefresh,
    expiresAt: typeof doc.expires_in === 'number' && doc.expires_in > 0 ? now + doc.expires_in * 1000 : null,
  };
}

/** The scopes a token response granted, or null when it did not say. */
export function scopesFrom(doc: LinearTokenResponse): string[] | null {
  if (typeof doc.scope === 'string') return doc.scope.split(/[ ,]+/).filter(Boolean);
  if (Array.isArray(doc.scope)) return doc.scope.filter((s): s is string => typeof s === 'string');
  return null;
}

/** POST to Linear's token endpoint, form-encoded. Throws with Linear's words on a refusal. */
export async function postLinearToken(form: Record<string, string>): Promise<LinearTokenResponse> {
  const startedAt = Date.now();
  const res = await fetchWithTimeout(
    LINEAR_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    },
    { timeoutMs: TOKEN_TIMEOUT_MS, label: 'Linear token' }
  );
  debugBus.recordHttp({ service: 'linear', method: 'POST', url: LINEAR_TOKEN_URL, status: res.status, durationMs: Date.now() - startedAt, ok: res.ok });
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(res.bodyText) as Record<string, unknown>;
  } catch {
    doc = {};
  }
  if (!res.ok) {
    const code = typeof doc.error === 'string' ? doc.error : `HTTP ${res.status}`;
    const description = typeof doc.error_description === 'string' ? doc.error_description : '';
    // `invalid_grant` is final: the refresh token is spent or revoked.
    if (code === 'invalid_grant' || res.status === 401) {
      throw new LinearAuthError(description || 'Linear refused the sign-in. Connect Linear again.');
    }
    throw new Error(`Linear refused the token request (${code})${description ? `: ${description}` : ''}`);
  }
  return doc as LinearTokenResponse;
}

// ---- Rows ---------------------------------------------------------------------

const PUBLIC_COLUMNS = {
  id: inboundConnections.id,
  workspaceId: inboundConnections.workspaceId,
  externalAccountId: inboundConnections.externalAccountId,
  credentialMeta: inboundConnections.credentialMeta,
  createdAt: inboundConnections.createdAt,
} as const;

type PublicRow = Pick<typeof inboundConnections.$inferSelect, keyof typeof PUBLIC_COLUMNS>;

function toConnection(row: PublicRow): LinearConnection {
  const meta = (row.credentialMeta ?? {}) as LinearMeta;
  const scopes = Array.isArray(meta.scopes) ? meta.scopes : [];
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    organizationId: row.externalAccountId ?? '',
    organizationName: meta.organizationName ?? null,
    urlKey: meta.urlKey ?? null,
    scopes,
    canAssign: scopes.includes('app:assignable'),
    reauthRequiredAt: meta.reauthRequiredAt ?? null,
    reauthReason: meta.reauthReason ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The query behind {@link listLinearConnections}. Exported for the egress test. */
export function listLinearConnectionsQuery(workspaceId: string) {
  return db()
    .select(PUBLIC_COLUMNS)
    .from(inboundConnections)
    .where(and(eq(inboundConnections.workspaceId, workspaceId), eq(inboundConnections.kind, 'linear')));
}

export async function listLinearConnections(workspaceId: string): Promise<LinearConnection[]> {
  return (await listLinearConnectionsQuery(workspaceId)).map(toConnection);
}

export async function getLinearConnection(connectionId: string): Promise<LinearConnection | null> {
  const rows = await db()
    .select(PUBLIC_COLUMNS)
    .from(inboundConnections)
    .where(and(eq(inboundConnections.id, connectionId), eq(inboundConnections.kind, 'linear')))
    .limit(1);
  return rows[0] ? toConnection(rows[0]) : null;
}

/** The connections of one Linear organization, across workspaces. The webhook fans out to each. */
export async function connectionsForOrganization(organizationId: string): Promise<Array<{ id: string; workspaceId: string; appUserId: string | null }>> {
  const rows = await db()
    .select({ id: inboundConnections.id, workspaceId: inboundConnections.workspaceId, credentialMeta: inboundConnections.credentialMeta })
    .from(inboundConnections)
    .where(and(eq(inboundConnections.kind, 'linear'), eq(inboundConnections.externalAccountId, organizationId)));
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    appUserId: typeof (r.credentialMeta as LinearMeta)?.appUserId === 'string' ? ((r.credentialMeta as LinearMeta).appUserId as string) : null,
  }));
}

/** Talyn's app user id in a connection's organization, or null. */
export async function linearAppUserId(connectionId: string): Promise<string | null> {
  const rows = await db()
    .select({ credentialMeta: inboundConnections.credentialMeta })
    .from(inboundConnections)
    .where(eq(inboundConnections.id, connectionId))
    .limit(1);
  const id = (rows[0]?.credentialMeta as LinearMeta | undefined)?.appUserId;
  return typeof id === 'string' ? id : null;
}

/** Store a new grant, or replace the grant of an organization already connected here. */
export async function upsertLinearConnection(input: {
  workspaceId: string;
  organizationId: string;
  tokens: LinearTokens;
  meta: LinearMeta;
  createdBy: string;
}): Promise<string> {
  const now = new Date();
  const meta: LinearMeta = { ...input.meta, reauthRequiredAt: null, reauthReason: null };
  const rows = await db()
    .insert(inboundConnections)
    .values({
      id: uuid(),
      workspaceId: input.workspaceId,
      kind: 'linear',
      externalAccountId: input.organizationId,
      credentialEnc: sealTokens(input.tokens),
      credentialMeta: meta as Record<string, unknown>,
      createdBy: input.createdBy,
    })
    .onConflictDoUpdate({
      target: [inboundConnections.workspaceId, inboundConnections.kind, inboundConnections.externalAccountId],
      set: { credentialEnc: sealTokens(input.tokens), credentialMeta: meta as Record<string, unknown>, updatedAt: now },
    })
    .returning({ id: inboundConnections.id });
  return rows[0]!.id;
}

/** Mark a connection's grant as dead, with Linear's reason. Every write-back stops until it is reconnected. */
export async function markLinearReauthRequired(connectionId: string, reason: string): Promise<void> {
  const rows = await db()
    .select({ credentialMeta: inboundConnections.credentialMeta })
    .from(inboundConnections)
    .where(eq(inboundConnections.id, connectionId))
    .limit(1);
  if (!rows[0]) return;
  const meta = { ...((rows[0].credentialMeta ?? {}) as LinearMeta), reauthRequiredAt: new Date().toISOString(), reauthReason: reason };
  await db()
    .update(inboundConnections)
    .set({ credentialMeta: meta as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(inboundConnections.id, connectionId));
}

/** Delete a connection. Talyn revokes the token first, best effort. */
export async function deleteLinearConnection(workspaceId: string, connectionId: string): Promise<boolean> {
  const rows = await db()
    .select({ credentialEnc: inboundConnections.credentialEnc })
    .from(inboundConnections)
    .where(and(eq(inboundConnections.id, connectionId), eq(inboundConnections.workspaceId, workspaceId), eq(inboundConnections.kind, 'linear')))
    .limit(1);
  if (!rows[0]) return false;
  const tokens = readTokens(rows[0].credentialEnc);
  if (tokens) {
    await fetchWithTimeout(
      LINEAR_REVOKE_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokens.refreshToken ?? tokens.accessToken }).toString(),
      },
      { timeoutMs: TOKEN_TIMEOUT_MS, label: 'Linear revoke' }
    ).catch(() => undefined);
  }
  await db().delete(inboundConnections).where(eq(inboundConnections.id, connectionId));
  return true;
}

// ---- Tokens -------------------------------------------------------------------

/** Thrown when a connection cannot give a working token. The message is for a person. */
export class LinearConnectionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinearConnectionUnavailableError';
  }
}

async function readCredential(connectionId: string): Promise<{ tokens: LinearTokens | null; meta: LinearMeta } | null> {
  const rows = await db()
    .select({ credentialEnc: inboundConnections.credentialEnc, credentialMeta: inboundConnections.credentialMeta })
    .from(inboundConnections)
    .where(and(eq(inboundConnections.id, connectionId), eq(inboundConnections.kind, 'linear')))
    .limit(1);
  if (!rows[0]) return null;
  return { tokens: readTokens(rows[0].credentialEnc), meta: (rows[0].credentialMeta ?? {}) as LinearMeta };
}

function expiring(tokens: LinearTokens, now: number): boolean {
  return tokens.expiresAt !== null && tokens.expiresAt - REFRESH_MARGIN_MS <= now;
}

/**
 * A working access token for a connection, refreshed when it is about to
 * expire.
 *
 * The refresh is advisory-locked per connection and re-reads the row inside
 * the lock, as `mcpServers/oauth.ts` does: Linear rotates the refresh token on
 * each use, so two replicas that both spend the same one would kill the
 * grant. A refresh runs about once a day per connection, so the lock is not
 * on a hot path.
 *
 * A dead grant (Linear says `invalid_grant`) is RECORDED on the row, so every
 * later write-back fails fast with "connect again" instead of trying.
 */
export async function linearAccessToken(connectionId: string, now = Date.now()): Promise<string> {
  const stored = await readCredential(connectionId);
  if (!stored) throw new LinearConnectionUnavailableError('The Linear connection was removed. Connect Linear again.');
  if (stored.meta.reauthRequiredAt) {
    throw new LinearConnectionUnavailableError(stored.meta.reauthReason || 'Linear needs a new sign-in. Connect Linear again.');
  }
  if (!stored.tokens) throw new LinearConnectionUnavailableError('The Linear connection has no token. Connect Linear again.');
  if (!expiring(stored.tokens, now)) return stored.tokens.accessToken;

  return withBlockingAdvisoryLock(db(), `linearOAuth:${connectionId}`, async () => {
    const fresh = (await readCredential(connectionId)) ?? stored;
    if (fresh.meta.reauthRequiredAt) {
      throw new LinearConnectionUnavailableError(fresh.meta.reauthReason || 'Linear needs a new sign-in. Connect Linear again.');
    }
    if (fresh.tokens && !expiring(fresh.tokens, now)) return fresh.tokens.accessToken;
    const refreshToken = fresh.tokens?.refreshToken;
    if (!refreshToken) {
      await markLinearReauthRequired(connectionId, 'The Linear sign-in expired. Connect Linear again.');
      throw new LinearConnectionUnavailableError('The Linear sign-in expired. Connect Linear again.');
    }
    const config = getLinearAppConfig();
    if (!config) throw new LinearConnectionUnavailableError('Linear is not configured on this deployment.');
    try {
      const doc = await postLinearToken({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
      const next = tokensFrom(doc, now, refreshToken);
      await db()
        .update(inboundConnections)
        .set({ credentialEnc: sealTokens(next), updatedAt: new Date() })
        .where(eq(inboundConnections.id, connectionId));
      return next.accessToken;
    } catch (err) {
      if (err instanceof LinearAuthError) {
        await markLinearReauthRequired(connectionId, err.message);
        throw new LinearConnectionUnavailableError(err.message);
      }
      // Transient: the grant is left alone and the next call tries again.
      throw err;
    }
  });
}
