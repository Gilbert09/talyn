import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq, and } from 'drizzle-orm';
import { ClaudeOAuthError, ClaudeReauthRequiredError } from '../../services/selfHosted/claudeOauth.js';
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
const { capture, exchange } = vi.hoisted(() => ({
  capture: vi.fn(),
  exchange: vi.fn(),
}));
vi.mock('../../services/analytics.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  captureWorkspaceEvent: capture,
}));
vi.mock('../../services/selfHosted/claudeOauth.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  exchangeCode: exchange,
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
    capture.mockReset();
    exchange.mockReset();
    exchange.mockRejectedValue(new Error('test token exchange failed'));
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

  describe('error codes and the claude_signin_completed event', () => {
    const authorize = () =>
      fetch(`${url}/cloud-providers/selfhosted/claude/authorize`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ workspaceId: 'ws1' }),
      });
    const complete = async (body: Record<string, unknown>) => {
      const res = await fetch(`${url}/cloud-providers/selfhosted/claude/complete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ workspaceId: 'ws1', ...body }),
      });
      return { status: res.status, body: (await res.json()) as { code?: string; error?: string; success: boolean } };
    };

    it('answers missing_input without an event (no workspace resolved yet)', async () => {
      const res = await complete({ code: '  ' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('missing_input');
      expect(capture).not.toHaveBeenCalled();
    });

    it('answers signin_not_found when nothing was started', async () => {
      const res = await complete({ code: 'abc' });
      expect(res.body.code).toBe('signin_not_found');
      expect(res.body.error).toBe('Start the Claude sign-in again — this one was not found.');
      expect(capture).toHaveBeenCalledWith('ws1', 'claude_signin_completed', {
        agent: 'claude',
        outcome: 'failed',
        code: 'signin_not_found',
      });
    });

    it('answers signin_expired for an old pending sign-in', async () => {
      await authorize();
      const row = await integrationRow();
      const config = row!.config as { claudePendingAuth: Record<string, unknown> };
      await db
        .update(integrationsTable)
        .set({ config: { ...config, claudePendingAuth: { ...config.claudePendingAuth, expiresAt: new Date(0).toISOString() } } })
        .where(and(eq(integrationsTable.workspaceId, 'ws1'), eq(integrationsTable.type, 'selfhosted')));
      const res = await complete({ code: 'abc' });
      expect(res.body.code).toBe('signin_expired');
    });

    it('answers signin_account_mismatch for a different account target', async () => {
      await authorize();
      const res = await complete({ code: 'abc', label: 'Other' });
      expect(res.body.code).toBe('signin_account_mismatch');
    });

    it('answers signin_state_mismatch for a code from another sign-in', async () => {
      await authorize();
      const res = await complete({ code: 'abc#not-the-state' });
      expect(res.body.code).toBe('signin_state_mismatch');
    });

    it.each([
      ['grant_rejected', new ClaudeReauthRequiredError('Anthropic rejected the stored sign-in')],
      ['scope_refused', new ClaudeOAuthError('came back without permission to run models', 'scope_refused')],
      ['token_exchange_failed', new ClaudeOAuthError('Claude token request failed (400): nope')],
      ['token_exchange_failed', new Error('network down')],
    ])('classifies an exchange failure as %s', async (code, err) => {
      exchange.mockRejectedValue(err);
      await authorize();
      const res = await complete({ code: 'abc' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
      expect(res.body.error).toBe(err.message);
      expect(capture).toHaveBeenCalledWith('ws1', 'claude_signin_completed', { agent: 'claude', outcome: 'failed', code });
    });

    it('captures a connected outcome with no code', async () => {
      exchange.mockResolvedValue({
        accessTokenEnc: { iv: '', tag: '', data: '' },
        refreshTokenEnc: { iv: '', tag: '', data: '' },
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await authorize();
      const res = await complete({ code: 'abc' });
      expect(res.body.success).toBe(true);
      expect(capture).toHaveBeenCalledWith('ws1', 'claude_signin_completed', { agent: 'claude', outcome: 'connected' });
    });
  });
});
