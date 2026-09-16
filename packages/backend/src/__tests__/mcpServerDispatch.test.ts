import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb.js';
import { mcpServers, users, workspaces } from '../db/schema.js';
import { encryptString } from '../services/tokenCrypto.js';
import { mcpIntegrationSecrets, mcpServerIdsFromMetadata } from '../services/mcpServers/dispatch.js';
import { mcpServersForDispatch } from '../services/mcpServers/store.js';
import type { Database } from '../db/client.js';

/**
 * What reaches a dispatch, and what reaches a re-supply after a fleetd restart.
 *
 * The second is the one worth the test. An inline MCP server's secret is sealed
 * on arrival at the fleet and persisted nowhere, so the fleet's own adoption
 * pull — which reads that tenant's STORED servers — has nothing to serve for
 * one. If Talyn does not hand them back, an adopted box keeps its MCP routes
 * and loses every tool credential, and each tool call 401s for the rest of the
 * run. Three paths have to agree about that: the create body, the poller's
 * push, and the host-pull answer.
 */

let db: Database;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  process.env.TALYN_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
  ({ db, cleanup } = await createTestDb());
});

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

async function seed(tools: string[] | null, enabled = true, secret = 'lin_api_x') {
  await db.insert(users).values({ id: 'owner-1', email: 'o@example.com' });
  await db.insert(workspaces).values({ id: 'ws-1', name: 'W', ownerId: 'owner-1' });
  await db.insert(mcpServers).values({
    id: 'srv-1',
    workspaceId: 'ws-1',
    name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    authKind: 'bearer',
    secretEnc: secret ? encryptString(secret) : null,
    tools,
    enabled,
  });
}

describe('mcpServersForDispatch', () => {
  it('decrypts the credential and carries the allow-list', async () => {
    await seed(['create_issue']);
    const got = await mcpServersForDispatch('ws-1', null);
    expect(got).toHaveLength(1);
    expect(got[0]!.secret).toBe('lin_api_x');
    expect(got[0]!.tools).toEqual(['create_issue']);
  });

  // The tri-state, which nothing downstream may collapse. `[]` is a choice.
  it('keeps an absent allow-list and an empty one apart', async () => {
    await seed(null);
    expect((await mcpServersForDispatch('ws-1', null))[0]!.tools).toBeNull();
  });

  it('a disabled server is not dispatched', async () => {
    await seed(null, false);
    expect(await mcpServersForDispatch('ws-1', null)).toEqual([]);
  });

  // The per-loop pin. An empty array means "this run wants no MCP servers",
  // which must not read as "inherit the workspace's set".
  it('an empty pin selects nothing, while null inherits', async () => {
    await seed(null);
    expect(await mcpServersForDispatch('ws-1', [])).toEqual([]);
    expect(await mcpServersForDispatch('ws-1', null)).toHaveLength(1);
    expect(await mcpServersForDispatch('ws-1', ['srv-1'])).toHaveLength(1);
    expect(await mcpServersForDispatch('ws-1', ['other'])).toEqual([]);
  });

  // A key that will not open costs its own server and nothing else. The task is
  // still worth doing; a PR that never got fixed because a key rotated is a
  // much worse outcome than a run missing one MCP server.
  it('skips a server whose credential will not open, and keeps the rest', async () => {
    await seed(null);
    await db
      .update(mcpServers)
      .set({ secretEnc: { v: 1, iv: 'AAAA', ct: 'AAAA', tag: 'AAAA' } })
      .where(eq(mcpServers.id, 'srv-1'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await mcpServersForDispatch('ws-1', null)).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('mcpServerIdsFromMetadata', () => {
  it('reads the three states, and distrusts anything else', async () => {
    expect(mcpServerIdsFromMetadata(null)).toBeNull();
    expect(mcpServerIdsFromMetadata({})).toBeNull();
    expect(mcpServerIdsFromMetadata({ mcpServerIds: [] })).toEqual([]);
    expect(mcpServerIdsFromMetadata({ mcpServerIds: ['a', 'b'] })).toEqual(['a', 'b']);
    // A jsonb column can hold anything an older shape left there, and it must
    // not get to decide what a run can reach.
    expect(mcpServerIdsFromMetadata({ mcpServerIds: 'all' })).toBeNull();
    expect(mcpServerIdsFromMetadata({ mcpServerIds: [1, 'a'] })).toEqual(['a']);
  });
});

describe('mcpIntegrationSecrets', () => {
  beforeEach(() => {
    process.env.MCP_SERVERS_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.MCP_SERVERS_ENABLED;
  });

  // Keyed by NAME, because that is how the fleet's proxy indexes an integration
  // — and it has to be the same name the create body used, or a push installs a
  // credential on a route that is not there.
  it('is keyed by the server name, matching the create body', async () => {
    await seed(null);
    expect(await mcpIntegrationSecrets({ workspaceId: 'ws-1', metadata: null })).toEqual({
      linear: 'lin_api_x',
    });
  });

  // A server with no credential still has a route and still works; an empty
  // string here would be a credential the proxy attaches.
  it('omits a server that has no credential rather than sending an empty one', async () => {
    await seed(null, true, '');
    expect(await mcpIntegrationSecrets({ workspaceId: 'ws-1', metadata: null })).toEqual({});
  });

  // Losing the flag mid-run degrades to a run WITHOUT MCP servers rather than
  // a run that fails. The task is still worth doing.
  it('answers empty when the workspace is out of the audience', async () => {
    await seed(null);
    process.env.MCP_SERVERS_ENABLED = 'false';
    expect(await mcpIntegrationSecrets({ workspaceId: 'ws-1', metadata: null })).toEqual({});
  });
});
