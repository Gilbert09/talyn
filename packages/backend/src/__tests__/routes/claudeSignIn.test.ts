import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq, and } from 'drizzle-orm';
import { cloudProviderRoutes } from '../../routes/cloudProviders.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  workspaces as workspacesTable,
  integrations as integrationsTable,
} from '../../db/schema.js';

/**
 * The Claude sign-in's two legs, against a workspace that has NEVER connected
 * anything to the fleet.
 *
 * That is the case the flow shipped broken in, and the one nobody could have
 * hit while the fleet was allow-listed: every allow-listed workspace had been
 * set up by hand and already had a `selfhosted` integration row. Releasing the
 * fleet to everybody made "no row yet" the NORMAL state for a new user, and the
 * authorize leg's write was a silent no-op without one — so `/complete` looked
 * for a pending sign-in that had never been stored and answered "this one was
 * not found", forever, on every retry.
 *
 * Disconnecting deletes the row outright (`removeSelfHostedCredentials`), so
 * this is also the disconnect-then-reconnect path, for an existing user.
 */

// Real AES key for the PKCE verifier at rest; the routes encrypt it before it
// touches the row. Production sets this, which is why the encryption half of
// this flow was never the broken part.
const savedTokenKey = process.env.TALYN_TOKEN_KEY;

const headers = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

vi.mock('../../services/cloudProviders/fleetAccess.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  workspaceMayUseFleet: async () => true,
  fleetRefusalReason: () => 'fleet off',
}));

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/cloud-providers', requireAuth, wrapAsyncRoutes(cloudProviderRoutes()));
  app.use(apiErrorHandler);
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((res) => {
        server.closeAllConnections();
        server.close(() => res());
      }),
  };
}

describe('Claude sign-in on a workspace with no fleet integration row', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    process.env.TALYN_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
    ({ db, cleanup } = await createTestDb());
    await seedUser(db);
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws1',
      settings: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    ({ url, close } = await makeServer());
  });

  afterEach(async () => {
    await close();
    await cleanup();
    if (savedTokenKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = savedTokenKey;
  });

  async function integrationRow() {
    const rows = await db
      .select({ config: integrationsTable.config, enabled: integrationsTable.enabled })
      .from(integrationsTable)
      .where(
        and(
          eq(integrationsTable.workspaceId, 'ws1'),
          eq(integrationsTable.type, 'selfhosted'),
        ),
      )
      .limit(1);
    return rows[0];
  }

  it('starts with no integration row at all — the state a new user is in', async () => {
    expect(await integrationRow()).toBeUndefined();
  });

  it('PERSISTS the pending sign-in, creating the row if there is none', async () => {
    const res = await fetch(`${url}/cloud-providers/selfhosted/claude/authorize`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspaceId: 'ws1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { url: string } };
    expect(body.data.url).toContain('claude.com/cai/oauth/authorize');

    // The assertion that matters. Answering 200 with an authorize URL while
    // writing nothing is exactly how this failed: the user completes a real
    // sign-in at Anthropic and comes back to a server with no memory of it.
    const row = await integrationRow();
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(true);
    const pending = (row!.config as { claudePendingAuth?: { state: string } }).claudePendingAuth;
    expect(pending).toBeDefined();
    // The state in the stored row must be the one in the URL the user was sent
    // to, or `/complete` rejects their code as "a different sign-in".
    expect(new URL(body.data.url).searchParams.get('state')).toBe(pending!.state);
  });

  it('does not answer "not found" to a code from a sign-in it just started', async () => {
    await fetch(`${url}/cloud-providers/selfhosted/claude/authorize`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspaceId: 'ws1' }),
    });
    const res = await fetch(`${url}/cloud-providers/selfhosted/claude/complete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspaceId: 'ws1', code: 'a-code-anthropic-will-reject' }),
    });
    // The exchange itself fails — there is no Anthropic here — and that is
    // fine. What must not happen is the flow claiming it never started, which
    // tells the user to do the one thing that cannot help.
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain('was not found');
  });

  it('keeps the pending sign-in after a failed exchange, so a retry says why', async () => {
    await fetch(`${url}/cloud-providers/selfhosted/claude/authorize`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ workspaceId: 'ws1' }),
    });
    const attempt = () =>
      fetch(`${url}/cloud-providers/selfhosted/claude/complete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ workspaceId: 'ws1', code: 'bad-code' }),
      }).then((r) => r.json() as Promise<{ error: string }>);

    const first = await attempt();
    const second = await attempt();
    // Clearing the pending on failure turned the SECOND attempt into "this one
    // was not found" — the real reason shown once, then masked forever behind
    // an error that blames the user for a flow they did start. The pending is
    // not the code; it is the PKCE verifier, and it stays good until it expires.
    expect(second.error).not.toContain('was not found');
    expect(second.error).toBe(first.error);
  });
});
