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
 * A workspace's Trunk org API token, on an `integrations` row of type `trunk`.
 *
 * Same storage as the PostHog Code key: the token is an AES-GCM envelope in
 * `config`, and nothing returns it. Clients learn only `connected` and
 * `needsReauth` through {@link trunkStatus}.
 */

export const TRUNK_INTEGRATION_TYPE = 'trunk';

export interface TrunkIntegrationConfig {
  tokenEnc?: EncryptedEnvelope;
  connectedAt?: string;
  /** Set when Trunk answered 401/403 to this token. */
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
      '[trunk] failed to decrypt the API token:',
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
  return {
    connected: true,
    needsReauth: Boolean(config.reauthRequiredAt),
    ...(config.reauthReason ? { reauthReason: config.reauthReason } : {}),
    ...(config.connectedAt ? { connectedAt: config.connectedAt } : {}),
  };
}

/** Save (or replace) the token. Replacing it clears any reconnect marker. */
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
 * Record that Trunk refused the token. A missing row is not created: with no
 * token there is nothing to reconnect.
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

/** A call with this token succeeded, so it is not refused any more. */
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
