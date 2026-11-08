import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { probeMcpServer } from '../services/mcpServers/probe.js';
import { mcpFetch, readMcpBody } from '../services/mcpServers/http.js';
import { dialError, evictPrivateConnections, privateDispatcher } from '../services/mcpServers/privateTcp.js';

const mocks = vi.hoisted(() => ({
  endpoint: '', ca: undefined as Buffer | undefined, trust: true, connectorId: 'connector-1',
  routes: [{ host: 'mcp.private.test', port: 443 }, { host: 'wrong.private.test', port: 443 }],
}));
vi.mock('../services/selfHosted/credentials.js', () => ({
  fleetPinnedEndpoint: () => mocks.endpoint,
  fleetGatewayToken: () => 'tenant-test-value',
}));
vi.mock('../services/selfHosted/privateRoutes.js', () => ({
  workspaceMayUsePrivateRoutes: async () => true,
  getPrivateConnector: async () => ({ id: mocks.connectorId, workspaceId: 'ws-1', status: 'connected', routes: mocks.routes }),
  mapPrivateRoutesError: (error: unknown) => error,
}));
// Trust only this test CA. Production uses the normal system trust store.
vi.mock('node:tls', async (original) => {
  const tls = await original<typeof import('node:tls')>();
  return { ...tls, connect: (options: import('node:tls').ConnectionOptions) => tls.connect({ ...options, ...(mocks.trust ? { ca: mocks.ca } : {}) }) };
});

let directory: string;
let key: Buffer;
let origin: ReturnType<typeof httpsServer>;
let gateway: ReturnType<typeof httpServer>;
let serve: (req: IncomingMessage, res: ServerResponse) => void;
let deny = 0;
let stall = false;
let denyCode: string | undefined;
let bodies: unknown[];
let authorization: string | undefined;
const sockets = new Set<Socket>();
const context = { workspaceId: 'ws-1', purpose: 'probe' as const };
const url = 'https://mcp.private.test/mcp';

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'talyn-mcp-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=mcp.private.test', '-addext', 'subjectAltName=DNS:mcp.private.test',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
  key = readFileSync(join(directory, 'key.pem'));
  mocks.ca = readFileSync(join(directory, 'cert.pem'));
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
beforeEach(async () => {
  bodies = []; deny = 0; stall = false; denyCode = undefined; mocks.trust = true; mocks.connectorId = 'connector-1';
  vi.spyOn(console, 'info').mockImplementation(() => {});
  serve = (_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); };
  origin = httpsServer({ key, cert: mocks.ca, ALPNProtocols: ['http/1.1'] }, (req, res) => serve(req, res));
  origin.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  gateway = httpServer();
  gateway.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  gateway.on('upgrade', (req, socket, head) => {
    authorization = req.headers.authorization;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/workspaces/ws-1/private-routes/dial');
    expect(req.headers.upgrade).toBe('yas-private-tcp');
    const size = Number(req.headers['content-length']);
    let body = head;
    const proceed = () => {
      if (body.length < size) return;
      socket.removeListener('data', receive);
      bodies.push(JSON.parse(body.subarray(0, size).toString()));
      if (stall) return;
      if (deny) {
        const error = JSON.stringify({ code: denyCode, message: 'Do not log destination secrets.' });
        socket.end(`HTTP/1.1 ${deny} Denied\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(error)}\r\nConnection: close\r\n\r\n${error}`);
        return;
      }
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: yas-private-tcp\r\n\r\n');
      const upstream = connect((origin.address() as AddressInfo).port, '127.0.0.1');
      sockets.add(upstream);
      upstream.once('close', () => { sockets.delete(upstream); socket.destroy(); });
      upstream.on('error', () => socket.destroy());
      socket.once('close', () => upstream.destroy());
      if (body.length > size) upstream.write(body.subarray(size));
      socket.pipe(upstream).pipe(socket);
    };
    const receive = (chunk: Buffer) => { body = Buffer.concat([body, chunk]); proceed(); };
    socket.on('data', receive);
    proceed();
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  mocks.endpoint = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});
afterEach(async () => {
  evictPrivateConnections('ws-1');
  for (const socket of sockets) socket.destroy();
  await Promise.all([new Promise<void>((resolve) => origin.close(() => resolve())), new Promise<void>((resolve) => gateway.close(() => resolve()))]);
  vi.restoreAllMocks();
});

describe('opaque YAS TCP transport', () => {
  it.each(['GET', 'POST', 'DELETE'])('preserves destination TLS, Host, and %s', async (method) => {
    serve = (req, res) => {
      const tls = req.socket as TLSSocket;
      expect(tls.servername).toBe('mcp.private.test');
      expect(tls.alpnProtocol).toBe('http/1.1');
      expect(req.headers.host).toBe('mcp.private.test');
      expect(req.method).toBe(method);
      expect(req.headers.authorization).toBe('Bearer destination-test-value');
      req.resume();
      req.once('end', () => res.end('{"ok":true}'));
    };
    const response = await mcpFetch(`${url}?code=destination-query-value`, {
      method, headers: { authorization: 'Bearer destination-test-value' }, ...(method === 'POST' ? { body: 'destination-body-value' } : {}),
    }, context);
    expect(await response.json()).toEqual({ ok: true });
    expect(authorization).toBe('Bearer tenant-test-value');
    expect(bodies).toEqual([{ connectorId: 'connector-1', host: 'mcp.private.test', port: 443 }]);
    expect(JSON.stringify(bodies)).not.toContain('destination-');
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('destination-');
  });
  it('completes a private probe with paginated SSE tool lists and session cleanup', async () => {
    const methods: string[] = [];
    serve = (req, res) => {
      expect(req.headers.authorization).toBe('Bearer destination-test-value');
      if (req.method === 'DELETE') { methods.push('DELETE'); res.writeHead(204); res.end(); return; }
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        const message = JSON.parse(body);
        methods.push(message.method);
        if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
        const result = message.method === 'initialize'
          ? { serverInfo: { name: 'Private server' }, protocolVersion: '2025-06-18' }
          : message.params.cursor ? { tools: [{ name: 'second_tool' }] }
            : { tools: [{ name: 'first_tool' }], nextCursor: 'second-page' };
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-1' });
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
      });
    };
    const result = await probeMcpServer({ workspaceId: 'ws-1', url, authKind: 'bearer', secret: 'destination-test-value' });
    expect(result.ok).toBe(true);
    expect(result.toolNames).toEqual(['first_tool', 'second_tool']);
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'DELETE']);
    expect(bodies).toHaveLength(5);
    expect(JSON.stringify(bodies)).not.toContain('destination-test-value');
  });
  it.each([false, true])('checks CA trust and hostname (wrong name: %s)', async (wrongName) => {
    mocks.trust = wrongName;
    await expect(mcpFetch(wrongName ? 'https://wrong.private.test/mcp' : url, {}, context)).rejects.toThrow();
    expect(bodies).toHaveLength(1);
  });
  it('reads a complete multiline SSE event without waiting for stream closure', async () => {
    serve = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': heartbeat\n\ndata: {"jsonrpc":"2.0",\ndata: "id":1,"result":{"ok":true}}\n\n');
    };
    const response = await mcpFetch(url, {}, context);
    const { mcpJsonFrames } = await import('../services/mcpServers/http.js');
    const body = await readMcpBody(response, 8192, (text) => mcpJsonFrames('text/event-stream', text).length > 0);
    expect(mcpJsonFrames('text/event-stream', body)).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
  });
  it('cancels an open response stream', async () => {
    serve = (_req, res) => { res.writeHead(200); res.write('partial'); };
    const controller = new AbortController();
    const response = await mcpFetch(url, { signal: controller.signal }, context);
    const pending = response.text();
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
  it('bounds the complete request while an SSE stream stays open', async () => {
    serve = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': heartbeat\n\n'); };
    const response = await mcpFetch(url, { signal: AbortSignal.timeout(300) }, context);
    await expect(response.text()).rejects.toThrow();
    expect(bodies).toHaveLength(1);
    expect(vi.mocked(console.info).mock.calls.at(-1)?.[1]).toMatchObject({ result: 'timeout' });
  });
  it('cancels a pending upgrade', async () => {
    stall = true;
    await expect(mcpFetch(url, { signal: AbortSignal.timeout(300) }, context)).rejects.toThrow();
    expect(bodies).toHaveLength(1);
  });
  it('bounds the private connection phase', async () => {
    stall = true;
    const started = Date.now();
    await expect(mcpFetch(url, {}, context)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(6000);
    expect(bodies).toHaveLength(1);
  });
  it.each([[403, undefined, 'destination_denied'], [404, undefined, 'route_missing'], [409, undefined, 'connector_not_connected'], [503, 'standby_owner', 'standby_owner'], [503, 'private_routes_unavailable', 'private_routes_unavailable'], [429, 'private_tunnel_limit', 'private_tunnel_limit']] as const)('maps a YAS %s denial without retries', async (status, code, expected) => {
      deny = status; denyCode = code;
      await expect(mcpFetch(url, { method: 'POST', body: 'destination-body-value' }, context)).rejects.toMatchObject({ cause: { code: expected } });
      expect(bodies).toHaveLength(1);
      expect(dialError(status, code).code).toBe(expected);
    });
  it('evicts an active stream after a connector replacement', async () => {
    serve = (_req, res) => { res.writeHead(200); res.write('partial'); };
    const response = await mcpFetch(url, {}, context);
    const pending = response.text();
    const rejection = expect(pending).rejects.toThrow();
    mocks.connectorId = 'connector-2';
    await rejection;
  });
  it('isolates active connection keys by workspace and connector', () => {
    const signal = new AbortController().signal;
    const first = privateDispatcher('ws-1', 'connector-1', 'mcp.private.test', 443, 'mcp.private.test', 'state-1', signal);
    const second = privateDispatcher('ws-2', 'connector-1', 'mcp.private.test', 443, 'mcp.private.test', 'state-1', signal);
    evictPrivateConnections('ws-1');
    expect(first.agent.destroyed).toBe(true);
    expect(second.agent.destroyed).toBe(false);
    second.release();
  });
});
