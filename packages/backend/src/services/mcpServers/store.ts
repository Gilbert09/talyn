import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type {
  McpServerDefinition,
  McpProbeResult,
  NormalizedMcpServer,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { mcpServers as mcpServersTable } from '../../db/schema.js';
import { decryptString, encryptString } from '../tokenCrypto.js';
import { resolveMcpAccessToken, type McpOAuthStore, type StoredMcpOAuth } from './oauth.js';

/**
 * Reading and writing a workspace's MCP servers.
 *
 * # The projection is the point
 *
 * `secret_enc` is never in a read that serves a client, and the `Pick` type on
 * `PUBLIC_COLUMNS` is what keeps it that way: a consumer that later reaches for
 * a column the projection drops fails to compile rather than silently
 * re-bloating the query. The one function that decrypts is
 * `mcpServersForDispatch`, and it is called from exactly one place.
 */

/** Everything except the credential. The shape every read but dispatch uses. */
const PUBLIC_COLUMNS = {
  id: mcpServersTable.id,
  workspaceId: mcpServersTable.workspaceId,
  name: mcpServersTable.name,
  displayName: mcpServersTable.displayName,
  url: mcpServersTable.url,
  description: mcpServersTable.description,
  catalogHandle: mcpServersTable.catalogHandle,
  authKind: mcpServersTable.authKind,
  inject: mcpServersTable.inject,
  oauth: mcpServersTable.oauth,
  tools: mcpServersTable.tools,
  enabled: mcpServersTable.enabled,
  lastProbe: mcpServersTable.lastProbe,
  createdAt: mcpServersTable.createdAt,
  updatedAt: mcpServersTable.updatedAt,
} as const;

type PublicRow = Pick<typeof mcpServersTable.$inferSelect, keyof typeof PUBLIC_COLUMNS>;

/**
 * Whether a credential is stored, computed in SQL so the envelope never ships.
 *
 * `hasSecret` is a boolean the UI needs on every row; the envelope it is
 * derived from is the one thing that must not leave. Deriving it here rather
 * than selecting the column and testing it in JS is the same trick the cloud
 * poller uses for `transcriptEmpty`.
 */
const HAS_SECRET = {
  hasSecret: mcpServersTable.secretEnc,
} as const;

function rowToDefinition(row: PublicRow, hasSecret: boolean): McpServerDefinition {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    displayName: row.displayName,
    url: row.url,
    description: row.description,
    catalogHandle: row.catalogHandle,
    authKind: row.authKind as McpServerDefinition['authKind'],
    inject: row.inject,
    hasSecret,
    oauth: row.oauth,
    tools: row.tools,
    enabled: row.enabled,
    lastProbe: row.lastProbe,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listMcpServers(workspaceId: string): Promise<McpServerDefinition[]> {
  const rows = await getDbClient()
    .select({ ...PUBLIC_COLUMNS, ...HAS_SECRET })
    .from(mcpServersTable)
    .where(eq(mcpServersTable.workspaceId, workspaceId))
    .orderBy(mcpServersTable.name);
  return rows.map((r) => rowToDefinition(r, r.hasSecret !== null));
}

export async function getMcpServer(id: string): Promise<McpServerDefinition | null> {
  const rows = await getDbClient()
    .select({ ...PUBLIC_COLUMNS, ...HAS_SECRET })
    .from(mcpServersTable)
    .where(eq(mcpServersTable.id, id))
    .limit(1);
  const row = rows[0];
  return row ? rowToDefinition(row, row.hasSecret !== null) : null;
}

export async function createMcpServer(
  workspaceId: string,
  input: NormalizedMcpServer
): Promise<McpServerDefinition> {
  const id = randomUUID();
  await getDbClient()
    .insert(mcpServersTable)
    .values({
      id,
      workspaceId,
      name: input.name,
      displayName: input.displayName,
      url: input.url,
      description: input.description,
      catalogHandle: input.catalogHandle,
      authKind: input.authKind,
      inject: input.inject,
      // An empty string clears rather than stores. Matching the fleet's own
      // rule, so "leave it alone" and "remove it" stay distinct gestures.
      secretEnc: input.secret ? encryptString(input.secret) : null,
      tools: input.tools,
      enabled: input.enabled,
    });
  const created = await getMcpServer(id);
  if (!created) throw new Error('the MCP server was not created');
  return created;
}

export async function updateMcpServer(
  id: string,
  input: NormalizedMcpServer
): Promise<McpServerDefinition | null> {
  await getDbClient()
    .update(mcpServersTable)
    .set({
      name: input.name,
      displayName: input.displayName,
      url: input.url,
      description: input.description,
      catalogHandle: input.catalogHandle,
      authKind: input.authKind,
      inject: input.inject,
      // Absent keeps what is stored; an empty string clears it. A PATCH that
      // did not say anything about the credential must not lose one, or every
      // rename would silently disconnect the server.
      ...(input.secret === undefined
        ? {}
        : { secretEnc: input.secret === '' ? null : encryptString(input.secret) }),
      tools: input.tools,
      enabled: input.enabled,
      updatedAt: new Date(),
    })
    .where(eq(mcpServersTable.id, id));
  return getMcpServer(id);
}

export async function setMcpServerEnabled(id: string, enabled: boolean): Promise<void> {
  await getDbClient()
    .update(mcpServersTable)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(mcpServersTable.id, id));
}

export async function recordMcpProbe(id: string, probe: McpProbeResult): Promise<void> {
  await getDbClient()
    .update(mcpServersTable)
    .set({ lastProbe: probe, updatedAt: new Date() })
    .where(eq(mcpServersTable.id, id));
}

export async function deleteMcpServer(id: string): Promise<void> {
  await getDbClient().delete(mcpServersTable).where(eq(mcpServersTable.id, id));
}

/**
 * The OAuth grant's storage, as the broker wants it.
 *
 * A separate read from `getMcpServer` because this one is the ONLY path that
 * may see the token envelopes — `getMcpServer` serves clients and deliberately
 * cannot reach them.
 */
export const mcpOAuthStore: McpOAuthStore = {
  read: async (serverId) => {
    const rows = await getDbClient()
      .select({ oauth: mcpServersTable.oauth })
      .from(mcpServersTable)
      .where(eq(mcpServersTable.id, serverId))
      .limit(1);
    return (rows[0]?.oauth as StoredMcpOAuth | null) ?? null;
  },
  write: async (serverId, next) => {
    await getDbClient()
      .update(mcpServersTable)
      .set({ oauth: next as never, updatedAt: new Date() })
      .where(eq(mcpServersTable.id, serverId));
  },
};

/** One server with its credential in the clear. Dispatch, and nothing else. */
export interface McpServerWithSecret {
  id: string;
  name: string;
  url: string;
  description: string | null;
  authKind: McpServerDefinition['authKind'];
  inject: McpServerDefinition['inject'];
  tools: string[] | null;
  secret: string | null;
}

/**
 * The enabled servers for a workspace, decrypted, for one dispatch.
 *
 * The ONLY function that decrypts. Keep it that way: a second caller is a
 * second place a credential can be logged, and the reason this one is safe is
 * that its result goes straight into a request body and is never stored,
 * echoed, or put in an error.
 *
 * A row whose envelope will not open is SKIPPED and named in the log rather
 * than failing the dispatch. The task itself is still worth doing, and a run
 * that lost one MCP server is a much better outcome than a PR that never got
 * fixed because a key rotated.
 */
export async function mcpServersForDispatch(
  workspaceId: string,
  only?: string[] | null
): Promise<McpServerWithSecret[]> {
  const rows = await getDbClient()
    .select({
      id: mcpServersTable.id,
      name: mcpServersTable.name,
      url: mcpServersTable.url,
      description: mcpServersTable.description,
      authKind: mcpServersTable.authKind,
      inject: mcpServersTable.inject,
      tools: mcpServersTable.tools,
      secretEnc: mcpServersTable.secretEnc,
      oauth: mcpServersTable.oauth,
    })
    .from(mcpServersTable)
    .where(and(eq(mcpServersTable.workspaceId, workspaceId), eq(mcpServersTable.enabled, true)))
    .orderBy(mcpServersTable.name);

  // `only` is the per-loop pin. null means inherit the workspace's enabled set;
  // an empty array means this run wants no MCP servers, which is a choice and
  // not the same statement as saying nothing.
  const wanted = only === null || only === undefined ? null : new Set(only);

  const out: McpServerWithSecret[] = [];
  for (const row of rows) {
    if (wanted && !wanted.has(row.id)) continue;
    let secret: string | null = null;
    // A SIGNED-IN server's token wins over any pasted key, and is refreshed
    // here if it is close to expiry. Handing a sandbox a stale token would fail
    // as an upstream 401 naming nothing, which the agent reads as the vendor
    // refusing it rather than as an authorization to renew.
    const grant = row.oauth as StoredMcpOAuth | null;
    if (grant) {
      secret = await resolveMcpAccessToken(row.id, mcpOAuthStore);
      if (!secret) {
        console.warn(
          `[mcp] the sign-in for MCP server "${row.name}" is not usable, so this run goes ` +
            `without it (${grant.status})`
        );
        continue;
      }
    } else if (row.secretEnc) {
      try {
        secret = decryptString(row.secretEnc);
      } catch (err) {
        console.warn(
          `[mcp] the credential for MCP server "${row.name}" could not be opened, so this run ` +
            `goes without it: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
    }
    out.push({
      id: row.id,
      name: row.name,
      url: row.url,
      description: row.description,
      authKind: row.authKind as McpServerDefinition['authKind'],
      inject: row.inject,
      tools: row.tools,
      secret,
    });
  }
  return out;
}
