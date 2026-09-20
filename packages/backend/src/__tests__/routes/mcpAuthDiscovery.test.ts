import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mcpServerRoutes, mcpOAuthCallbackRoutes } from '../../routes/mcpServers.js';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  allowed: vi.fn(),
  discover: vi.fn(),
  get: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  complete: vi.fn(),
  validateState: vi.fn(),
}));
vi.mock('../../middleware/auth.js', () => ({
  assertUser: () => ({ id: 'user-1' }),
  requireWorkspaceAccess: mocks.access,
  handleAccessError: (_error: unknown, res: express.Response) =>
    res.status(403).json({ success: false }),
}));
vi.mock('../../services/mcpServersAccess.js', () => ({
  workspaceMayUseMcpServers: mocks.allowed,
  mcpServersRefusalReason: () => 'disabled',
}));
vi.mock('../../services/mcpServers/authDiscovery.js', () => ({ discoverMcpAuth: mocks.discover }));
vi.mock('../../services/mcpServers/store.js', () => ({
  getMcpServer: mocks.get,
  mcpOAuthStore: { read: mocks.read, write: mocks.write },
}));
vi.mock('../../services/mcpServers/oauth.js', () => ({
  serverIdFromState: () => 'srv-1',
  validateMcpOAuthState: mocks.validateState,
  completeMcpOAuth: mocks.complete,
}));

vi.mock('../../db/client.js', () => ({ getDbClient: () => ({}) }));
vi.mock('../../services/advisoryLock.js', () => ({
  withBlockingAdvisoryLock: async (_db: unknown, _key: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../services/analytics.js', () => ({ captureWorkspaceEvent: vi.fn() }));

let server: Server;
let base: string;
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue(undefined);
  mocks.allowed.mockResolvedValue(true);
  mocks.discover.mockResolvedValue({ methods: ['oauth'], source: 'server' });
  const app = express();
  app.use(express.json());
  app.use('/mcp-servers', mcpOAuthCallbackRoutes());
  app.use('/mcp-servers', mcpServerRoutes());
  server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp-servers`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const post = (path: string, body: unknown) =>
  fetch(`${base}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('MCP discovery route', () => {
  it('returns discovery without creating a connection', async () => {
    const response = await post('discover-auth', {
      workspaceId: 'ws-1',
      url: 'https://mcp.example.com/mcp',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { methods: ['oauth'], source: 'server' },
    });
    expect(mocks.access).toHaveBeenCalledWith(expect.anything(), 'ws-1');
    expect(mocks.discover).toHaveBeenCalledWith('https://mcp.example.com/mcp');
  });
  it.each(['missing workspace', 'no access', 'flag off', 'invalid address'])(
    'refuses %s before network discovery',
    async (reason) => {
      if (reason === 'no access') mocks.access.mockRejectedValue(new Error('Forbidden'));
      if (reason === 'flag off') mocks.allowed.mockResolvedValue(false);
      const response = await post('discover-auth', {
        workspaceId: reason === 'missing workspace' ? '' : 'ws-1',
        url: reason === 'invalid address' ? 'https://127.0.0.1' : 'https://mcp.example.com/mcp',
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mocks.discover).not.toHaveBeenCalled();
    }
  );
});

describe('OAuth callback failures', () => {
  beforeEach(() => {
    mocks.get.mockResolvedValue({
      id: 'srv-1',
      workspaceId: 'ws-1',
      url: 'https://mcp.example.com/mcp',
      authKind: 'bearer',
    });
    mocks.read.mockResolvedValue({ status: 'pending', flow: { id: 'flow-1' } });
  });
  it('finishes without a browser session and returns no server details', async () => {
    mocks.complete.mockResolvedValue({ status: 'connected', lastCompletedFlowId: 'flow-1' });
    const response = await post('complete', { state: 'srv-1.state', code: 'valid-code' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: null });
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.write).toHaveBeenCalledWith('srv-1', { status: 'connected', lastCompletedFlowId: 'flow-1' });
  });
  it('refuses a callback when the workspace flag is disabled', async () => {
    mocks.allowed.mockResolvedValue(false);
    expect((await post('complete', { state: 'srv-1.state', code: 'valid-code' })).status).toBe(403);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it('records a denied callback so polling can stop', async () => {
    const response = await post('complete', { state: 'srv-1.state', error: 'access_denied' });
    expect(response.status).toBe(200);
    expect(mocks.validateState).toHaveBeenCalled();
    expect(mocks.write).toHaveBeenCalledWith('srv-1', {
      status: 'pending',
      detail: 'access_denied',
      flow: undefined,
    });
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('does not clear a flow for an invalid callback state', async () => {
    mocks.validateState.mockImplementation(() => {
      throw new Error('Invalid state');
    });
    expect((await post('complete', { state: 'forged', error: 'access_denied' })).status).toBe(409);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it.each([
    ['old-flow', 'pending'],
    ['requested-flow', 'connected'],
  ])(
    'reports completion only for the requested flow: %s',
    async (lastCompletedFlowId, expected) => {
      mocks.read.mockResolvedValue({ status: 'connected', lastCompletedFlowId });
      const response = await fetch(`${base}/srv-1/connect/requested-flow`);
      expect((await response.json()).data).toMatchObject({ status: expected, pending: false });
    }
  );
  it('keeps an existing connection when a new sign-in is denied', async () => {
    mocks.read.mockResolvedValue({
      status: 'connected',
      accessTokenEnc: 'existing',
      flow: { id: 'new-flow' },
    });
    expect((await post('complete', { state: 'srv-1.state', error: 'access_denied' })).status).toBe(
      200
    );
    expect(mocks.write).toHaveBeenCalledWith(
      'srv-1',
      expect.objectContaining({ status: 'connected', accessTokenEnc: 'existing', flow: undefined })
    );
  });
});
