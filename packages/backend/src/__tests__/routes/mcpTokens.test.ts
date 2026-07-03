import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { mcpTokenRoutes } from '../../routes/mcpTokens.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { requireMcpToken } from '../../mcp/requireMcpToken.js';
import { createToken } from '../../services/mcpToken.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';

const OTHER_USER_ID = 'user-other';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  // CRUD is authenticated like the real mount (requireAuth → mcpTokenRoutes).
  app.use('/api/v1/mcp-tokens', requireAuth, mcpTokenRoutes());
  // A stand-in for the /mcp endpoint to exercise the token gate.
  app.use('/api/v1/mcp', requireMcpToken, (req, res) => {
    res.json({ success: true, data: { ownerId: req.mcpOwnerId } });
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const authHeaders = (userId: string) => ({
  ...internalProxyHeaders(userId),
  'content-type': 'application/json',
});

describe('routes/mcp-tokens', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let server: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID });
    await seedUser(db, { id: OTHER_USER_ID });
    server = await makeServer();
  });

  afterEach(async () => {
    await server.close();
    await cleanup();
  });

  it('mints, lists, and revokes a token', async () => {
    // Create.
    const createRes = await fetch(`${server.url}/api/v1/mcp-tokens`, {
      method: 'POST',
      headers: authHeaders(TEST_USER_ID),
      body: JSON.stringify({ name: 'Laptop' }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.data.token).toMatch(/^talyn_mcp_/);
    const id = created.data.token_meta.id;

    // List — secret is gone, prefix remains.
    const listRes = await fetch(`${server.url}/api/v1/mcp-tokens`, {
      headers: authHeaders(TEST_USER_ID),
    });
    const listed = await listRes.json();
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].name).toBe('Laptop');
    expect(listed.data[0].token).toBeUndefined();

    // Revoke.
    const revokeRes = await fetch(`${server.url}/api/v1/mcp-tokens/${id}`, {
      method: 'DELETE',
      headers: authHeaders(TEST_USER_ID),
    });
    expect(revokeRes.status).toBe(200);

    // Gone from the list.
    const afterRes = await fetch(`${server.url}/api/v1/mcp-tokens`, {
      headers: authHeaders(TEST_USER_ID),
    });
    expect((await afterRes.json()).data).toHaveLength(0);
  });

  it('revoking another user\'s token is a 404', async () => {
    const theirs = await createToken(OTHER_USER_ID, { name: 'theirs' });
    const res = await fetch(`${server.url}/api/v1/mcp-tokens/${theirs.token_meta.id}`, {
      method: 'DELETE',
      headers: authHeaders(TEST_USER_ID),
    });
    expect(res.status).toBe(404);
  });

  describe('the /mcp token gate', () => {
    it('rejects a missing bearer with 401 + WWW-Authenticate', async () => {
      const res = await fetch(`${server.url}/api/v1/mcp`, { method: 'POST' });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Bearer');
    });

    it('rejects an invalid token', async () => {
      const res = await fetch(`${server.url}/api/v1/mcp`, {
        method: 'POST',
        headers: { authorization: 'Bearer talyn_mcp_nope' },
      });
      expect(res.status).toBe(401);
    });

    it('accepts a valid token and resolves the owner', async () => {
      const { token } = await createToken(TEST_USER_ID);
      const res = await fetch(`${server.url}/api/v1/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).data.ownerId).toBe(TEST_USER_ID);
    });
  });
});
