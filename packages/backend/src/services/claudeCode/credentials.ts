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
import { ClaudeManagedAgentsClient } from './client.js';

const INTEGRATION_TYPE = 'claude_code';

/**
 * Persisted shape of the `claude_code` integration row's `config`. Only the
 * Anthropic key is stored here (encrypted) — GitHub access reuses the
 * workspace's existing connection (`githubService.getAccessToken`). The
 * reusable agent + environment ids are cached so we don't re-create them on
 * every dispatch; the vault is minted fresh per dispatch (always-current
 * GitHub token), so it isn't cached.
 */
interface ClaudeIntegrationConfig {
  anthropicKeyEnc?: EncryptedEnvelope;
  /** Cached, reusable Managed Agents resource ids (not secret). A Managed Agent
   *  has a FIXED model, so agents are cached per model id (the workspace can
   *  switch models). `environmentId` is model-independent. */
  agentIdsByModel?: Record<string, string>;
  environmentId?: string;
  /** Legacy single-agent cache (pre model-picker); ignored on read. */
  agentId?: string;
}

export interface ClaudeCodeCredentials {
  anthropicApiKey: string;
  agentIdsByModel?: Record<string, string>;
  environmentId?: string;
}

function readEnc(env: EncryptedEnvelope | undefined, label: string): string | null {
  if (env && isEncryptedEnvelope(env)) {
    try {
      return decryptString(env);
    } catch (err) {
      console.error(`[claudeCode] failed to decrypt ${label}:`, err);
      return null;
    }
  }
  return null;
}

/** Resolve a workspace's Claude Code credentials, or null if unset. */
export async function getClaudeCodeCredentials(
  workspaceId: string,
): Promise<ClaudeCodeCredentials | null> {
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

  const config = (row.config as ClaudeIntegrationConfig | null) ?? {};
  const anthropicApiKey = readEnc(config.anthropicKeyEnc, 'Anthropic API key');
  if (!anthropicApiKey) return null;

  return {
    anthropicApiKey,
    agentIdsByModel: config.agentIdsByModel,
    environmentId: config.environmentId,
  };
}

/** Build a client for a workspace, or null if it isn't configured. */
export async function getClaudeCodeClient(
  workspaceId: string,
): Promise<ClaudeManagedAgentsClient | null> {
  const creds = await getClaudeCodeCredentials(workspaceId);
  if (!creds) return null;
  return new ClaudeManagedAgentsClient(creds.anthropicApiKey);
}

/** Upsert a workspace's Claude Code credentials (Anthropic key encrypted). */
export async function storeClaudeCodeCredentials(
  workspaceId: string,
  input: { anthropicApiKey: string },
): Promise<void> {
  const db = getDbClient();
  const existing = await db
    .select({ id: integrationsTable.id, config: integrationsTable.config })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    )
    .limit(1);

  // Rotating the key invalidates cached resource ids (an agent/environment is
  // tied to the account the key belongs to), so drop them on a re-store.
  const config: ClaudeIntegrationConfig = {
    anthropicKeyEnc: encryptString(input.anthropicApiKey),
  };

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

/**
 * Persist reusable Managed Agents resource ids after the executor creates them,
 * so subsequent dispatches reuse the same agent/environment. The agent id is
 * cached under its model (each model needs its own agent); the environment is
 * model-independent. Merges into the existing config (never clobbers the key).
 */
export async function cacheClaudeResourceIds(
  workspaceId: string,
  ids: { model?: string; agentId?: string; environmentId?: string },
): Promise<void> {
  const db = getDbClient();
  const rows = await db
    .select({ id: integrationsTable.id, config: integrationsTable.config })
    .from(integrationsTable)
    .where(
      and(
        eq(integrationsTable.workspaceId, workspaceId),
        eq(integrationsTable.type, INTEGRATION_TYPE),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return;
  const config = { ...((row.config as ClaudeIntegrationConfig | null) ?? {}) };
  if (ids.model && ids.agentId) {
    config.agentIdsByModel = { ...config.agentIdsByModel, [ids.model]: ids.agentId };
  }
  if (ids.environmentId) config.environmentId = ids.environmentId;
  await db
    .update(integrationsTable)
    .set({ config, updatedAt: new Date() })
    .where(eq(integrationsTable.id, row.id));
}

/** Remove a workspace's Claude Code credentials. */
export async function removeClaudeCodeCredentials(workspaceId: string): Promise<void> {
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
