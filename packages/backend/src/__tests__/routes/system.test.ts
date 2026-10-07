import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import type { GithubHealth } from '@talyn/shared';
import { systemRoutes } from '../../routes/system.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import { githubTraffic } from '../../services/githubHealth.js';
import { githubHealthMonitor } from '../../services/githubHealthMonitor.js';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  // No ownerScope: the route is mounted before it in production too.
  app.use('/api/v1/system', requireAuth, systemRoutes());
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

describe('routes/system', () => {
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  const get = (path: string, authed = true) =>
    fetch(`${serverUrl}/api/v1/system${path}`, {
      headers: authed ? internalProxyHeaders(TEST_USER_ID) : {},
    });

  beforeEach(async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;
    await seedUser(testDb.db, { id: TEST_USER_ID });
    const s = await makeServer();
    serverUrl = s.url;
    closeServer = s.close;
    githubTraffic._reset();
    githubHealthMonitor._reset();
  });

  afterEach(async () => {
    await closeServer();
    await cleanup();
    githubTraffic._reset();
    githubHealthMonitor._reset();
    vi.restoreAllMocks();
  });

  it('refuses an unauthenticated call', async () => {
    const res = await get('/github-health', false);
    expect(res.status).toBe(401);
  });

  it('answers the whole GithubHealth with no workspace named', async () => {
    const res = await get('/github-health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: GithubHealth };
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      state: 'unknown',
      source: null,
      traffic: {
        rest: { requests: 0, serverFailures: 0, state: 'unknown' },
        graphql: { requests: 0, serverFailures: 0, state: 'unknown' },
        state: 'unknown',
        windowMs: 10 * 60_000,
      },
      statusPage: null,
      since: null,
      updatedAt: expect.any(String),
    });
  });

  it('ignores a workspaceId and any other query', async () => {
    const res = await get('/github-health?workspaceId=not-mine&owner=someone');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: GithubHealth }).data.state).toBe('unknown');
  });

  it('reports what the request funnel recorded', async () => {
    for (let i = 0; i < 6; i += 1) githubTraffic.record('rest', 'server_failure');
    for (let i = 0; i < 4; i += 1) githubTraffic.record('graphql', 'ok');
    const { data } = (await (await get('/github-health')).json()) as { data: GithubHealth };
    expect(data).toMatchObject({ state: 'down', source: 'traffic' });
    expect(data.traffic.rest).toEqual({ requests: 6, serverFailures: 6, state: 'down' });
    expect(data.traffic.graphql).toEqual({ requests: 4, serverFailures: 0, state: 'operational' });
    expect(data.since).toEqual(expect.any(String));
  });

  it('holds no tenant data: only the documented keys leave', async () => {
    for (let i = 0; i < 6; i += 1) githubTraffic.record('rest', 'server_failure');
    const { data } = (await (await get('/github-health')).json()) as { data: GithubHealth };
    expect(Object.keys(data).sort()).toEqual(
      ['since', 'source', 'state', 'statusPage', 'traffic', 'updatedAt'].sort(),
    );
    expect(JSON.stringify(data)).not.toMatch(/token|workspace|owner|api\.github\.com/i);
  });
});
