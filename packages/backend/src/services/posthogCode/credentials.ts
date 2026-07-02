import { v4 as uuid } from 'uuid';
import { and, eq } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { integrations as integrationsTable } from '../../db/schema.js';
import {
  encryptString,
  decryptString,
  isEncryptedEnvelope,
  type EncryptedEnvelope,
} from '../tokenCrypto.js';
import { PostHogCodeClient } from './client.js';

const INTEGRATION_TYPE = 'posthog';
const DEFAULT_HOST = 'https://us.posthog.com';

/**
 * Persisted shape of the `posthog` integration row's `config`. The
 * personal API key is encrypted at rest (same envelope as the GitHub
 * token); project id + host are not secret.
 */
interface PostHogIntegrationConfig {
  apiKeyEnc?: EncryptedEnvelope;
  /** Legacy plaintext field — migrated + nulled at boot
   *  (services/credentialMigration.ts), never read/written. */
  apiKey?: string;
  projectId?: string;
  host?: string;
}

export interface PostHogCodeCredentials {
  apiKey: string;
  projectId: string;
  host: string;
}

function readApiKey(config: PostHogIntegrationConfig): string | null {
  if (config.apiKeyEnc && isEncryptedEnvelope(config.apiKeyEnc)) {
    try {
      return decryptString(config.apiKeyEnc);
    } catch (err) {
      console.error('[posthogCode] failed to decrypt API key:', err);
      return null;
    }
  }
  // No plaintext fallback: legacy `config.apiKey` rows are re-encrypted by
  // the boot sweep (services/credentialMigration.ts).
  return null;
}

/** Resolve a workspace's PostHog Code credentials, or null if unset. */
export async function getPostHogCodeCredentials(
  workspaceId: string,
): Promise<PostHogCodeCredentials | null> {
  const db = getDbClient();
  const rows = await db
    .select({ config: integrationsTable.config, enabled: integrationsTable.enabled })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || !row.enabled) return null;

  const config = (row.config as PostHogIntegrationConfig | null) ?? {};
  const apiKey = readApiKey(config);
  if (!apiKey || !config.projectId) return null;

  return {
    apiKey,
    projectId: config.projectId,
    host: config.host || DEFAULT_HOST,
  };
}

/** Build a client for a workspace, or null if it isn't configured. */
export async function getPostHogCodeClient(
  workspaceId: string,
): Promise<PostHogCodeClient | null> {
  const creds = await getPostHogCodeCredentials(workspaceId);
  if (!creds) return null;
  return new PostHogCodeClient(creds.apiKey, creds.projectId, creds.host);
}

/** Upsert a workspace's PostHog Code credentials (key encrypted). */
export async function storePostHogCodeCredentials(
  workspaceId: string,
  input: { apiKey: string; projectId: string; host?: string },
): Promise<void> {
  const db = getDbClient();
  const config: PostHogIntegrationConfig = {
    apiKeyEnc: encryptString(input.apiKey),
    projectId: input.projectId,
    host: input.host?.replace(/\/+$/, '') || DEFAULT_HOST,
  };

  const existing = await db
    .select({ id: integrationsTable.id })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    )
    .limit(1);

  const now = new Date();
  if (existing[0]) {
    await db
      .update(integrationsTable)
      .set({ config, enabled: true, updatedAt: now })
      .where(eq(integrationsTable.id, existing[0].id));
  } else {
    await db.insert(integrationsTable).values({
      id: uuid(),
      workspaceId,
      type: INTEGRATION_TYPE,
      enabled: true,
      config,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/** Remove a workspace's PostHog Code credentials. */
export async function removePostHogCodeCredentials(workspaceId: string): Promise<void> {
  const db = getDbClient();
  await db
    .delete(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    );
}
