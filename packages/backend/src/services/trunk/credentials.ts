import { v4 as uuid } from 'uuid';
import { and, eq, sql } from 'drizzle-orm';
import type { TrunkIntegrationStatus } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { integrations as integrationsTable } from '../../db/schema.js';
import {
  decryptString,
  encryptString,
  isEncryptedEnvelope,
  type EncryptedEnvelope,
} from '../tokenCrypto.js';

/**
 * A workspace's Trunk v2 API key, on an `integrations` row of type `trunk`.
 *
 * Same storage as the PostHog Code key: the key is an AES-GCM envelope in
 * `config`, and nothing returns it. Clients learn only `connected` and
 * `needsReauth` through {@link trunkStatus}. (The field names still say
 * "token": rows written before v2 hold a v1 organization API token there.)
 */

export const TRUNK_INTEGRATION_TYPE = 'trunk';

/** Every Trunk v2 API key starts with this, per Trunk's docs. */
export const TRUNK_API_KEY_PREFIX = 'trunk_v2_';

/**
 * False for a v1 organization API token, which the v2 API refuses. A row saved
 * before the move to v2 holds one, and it needs a new key before any call.
 */
export function isTrunkApiKey(token: string): boolean {
  return token.startsWith(TRUNK_API_KEY_PREFIX);
}

export const TRUNK_V1_TOKEN_REASON =
  'This is a v1 organization API token, which Trunk is retiring.';

export interface TrunkIntegrationConfig {
  tokenEnc?: EncryptedEnvelope;
  connectedAt?: string;
  /** Set when Trunk answered 401/403 to this key. */
  reauthRequiredAt?: string;
  reauthReason?: string;
}

export interface TrunkCredentials {
  token: string;
  reauthRequired: boolean;
  /**
   * The envelope's ciphertext, used to mark exactly the token that failed. A
   * token saved while a call was in flight must not be marked as refused.
   */
  tokenFingerprint: string;
}

async function readConfig(workspaceId: string): Promise<TrunkIntegrationConfig | null> {
  const rows = await getDbClient()
    .select({ config: integrationsTable.config })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, TRUNK_INTEGRATION_TYPE)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return (row.config as TrunkIntegrationConfig | null) ?? {};
}

/** The decrypted token, or null when there is none (or it cannot be read). */
export async function getTrunkCredentials(workspaceId: string): Promise<TrunkCredentials | null> {
  const config = await readConfig(workspaceId);
  if (!config || !isEncryptedEnvelope(config.tokenEnc)) return null;
  try {
    return {
      token: decryptString(config.tokenEnc),
      reauthRequired: Boolean(config.reauthRequiredAt),
      tokenFingerprint: config.tokenEnc.ct,
    };
  } catch (err) {
    console.error(
      '[trunk] failed to decrypt the API key:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export async function trunkStatus(workspaceId: string): Promise<TrunkIntegrationStatus> {
  const config = await readConfig(workspaceId);
  if (!config || !isEncryptedEnvelope(config.tokenEnc)) {
    return { connected: false, needsReauth: false };
  }
  const connectedAt = config.connectedAt ? { connectedAt: config.connectedAt } : {};
  if (!isTrunkApiKey(decryptOrEmpty(config.tokenEnc))) {
    return { connected: true, needsReauth: true, reauthReason: TRUNK_V1_TOKEN_REASON, ...connectedAt };
  }
  return {
    connected: true,
    needsReauth: Boolean(config.reauthRequiredAt),
    ...(config.reauthReason ? { reauthReason: config.reauthReason } : {}),
    ...connectedAt,
  };
}

function decryptOrEmpty(envelope: EncryptedEnvelope): string {
  try {
    return decryptString(envelope);
  } catch {
    return '';
  }
}

/** Save (or replace) the key. Replacing it clears any reconnect marker. */
export async function storeTrunkToken(workspaceId: string, token: string): Promise<void> {
  const db = getDbClient();
  const config: TrunkIntegrationConfig = {
    tokenEnc: encryptString(token),
    connectedAt: new Date().toISOString(),
  };
  const now = new Date();
  await db
    .insert(integrationsTable)
    .values({
      id: uuid(),
      workspaceId,
      type: TRUNK_INTEGRATION_TYPE,
      enabled: true,
      config,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [integrationsTable.workspaceId, integrationsTable.type],
      set: { config, enabled: true, updatedAt: now },
    });
}

export async function removeTrunkToken(workspaceId: string): Promise<void> {
  await getDbClient()
    .delete(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, TRUNK_INTEGRATION_TYPE)
      )
    );
}

function sameToken(fingerprint: string) {
  return sql`${integrationsTable.config} -> 'tokenEnc' ->> 'ct' = ${fingerprint}`;
}

/**
 * Record that Trunk refused the key. A missing row is not created: with no
 * key there is nothing to reconnect.
 */
export async function markTrunkReauthRequired(
  workspaceId: string,
  fingerprint: string,
  reason: string
): Promise<void> {
  const patch = JSON.stringify({ reauthRequiredAt: new Date().toISOString(), reauthReason: reason });
  await getDbClient()
    .update(integrationsTable)
    .set({ config: sql`${integrationsTable.config} || ${patch}::jsonb`, updatedAt: new Date() })
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, TRUNK_INTEGRATION_TYPE),
        sameToken(fingerprint)
      )
    );
}

/** A call with this key succeeded, so it is not refused any more. */
export async function clearTrunkReauth(workspaceId: string, fingerprint: string): Promise<void> {
  await getDbClient()
    .update(integrationsTable)
    .set({
      config: sql`${integrationsTable.config} - 'reauthRequiredAt' - 'reauthReason'`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, TRUNK_INTEGRATION_TYPE),
        sameToken(fingerprint)
      )
    );
}
