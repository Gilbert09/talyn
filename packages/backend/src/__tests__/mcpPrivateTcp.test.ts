import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { probeMcpServer } from '../services/mcpServers/probe.js';
import { fetchFailureReason, mcpFetch, readMcpBody } from '../services/mcpServers/http.js';
import { dialError, dialPrivateTcp, evictPrivateConnections, mcpFailureDiagnostics, privateDispatcher } from '../services/mcpServers/privateTcp.js';

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
let websocket: WebSocketServer;
let serve: (req: IncomingMessage, res: ServerResponse) => void;
let deny = 0;
let stall = false;
let denyCode: string | undefined;
let denyBody: string | undefined;
let upgrade = 'yas-private-tcp-v1';
let subprotocol: string | undefined = 'yas-private-tcp-v1';
let invalidFrame: 'text' | 'large' | undefined;
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
  bodies = []; deny = 0; stall = false; denyCode = undefined; denyBody = undefined;
  upgrade = 'yas-private-tcp-v1'; subprotocol = 'yas-private-tcp-v1'; invalidFrame = undefined;
  mocks.trust = true; mocks.connectorId = 'connector-1';
  vi.spyOn(console, 'info').mockImplementation(() => {});
  serve = (_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); };
  origin = httpsServer({ key, cert: mocks.ca, ALPNProtocols: ['http/1.1'] }, (req, res) => serve(req, res));
  origin.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  gateway = httpServer();
  gateway.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  websocket = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: () => subprotocol ?? false });
  gateway.on('upgrade', (req, socket, head) => {
    authorization = req.headers.authorization;
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/v1/workspaces/ws-1/private-routes/dial');
    expect(req.headers.upgrade).toBe('websocket');
    expect(req.headers['sec-websocket-protocol']).toBe('yas-private-tcp-v1');
    expect(req.headers['sec-websocket-extensions']).toBeUndefined();
    expect(req.headers.origin).toBeUndefined();
    expect(req.headers['content-length']).toBeUndefined();
    bodies.push(JSON.parse(req.headers['yas-private-route'] as string));
    if (stall) return;
    if (deny) {
      const error = denyBody ?? JSON.stringify({ code: denyCode, message: 'Do not log destination secrets.' });
      socket.end(`HTTP/1.1 ${deny} Denied\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(error)}\r\nConnection: close\r\n\r\n${error}`);
      return;
    }
    if (upgrade !== 'yas-private-tcp-v1') {
      socket.end(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${upgrade}\r\n\r\n`);
      return;
    }
    websocket.handleUpgrade(req, socket, head, (ws) => {
      if (invalidFrame) {
        ws.send(invalidFrame === 'text' ? 'frame-secret' : Buffer.alloc(65537));
        return;
      }
      const stream = createWebSocketStream(ws);
      const upstream = connect((origin.address() as AddressInfo).port, '127.0.0.1');
      sockets.add(upstream);
      upstream.once('close', () => { sockets.delete(upstream); stream.destroy(); });
      upstream.on('error', () => stream.destroy());
      stream.on('error', () => upstream.destroy());
      stream.once('close', () => upstream.destroy());
      stream.pipe(upstream).pipe(stream);
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  mocks.endpoint = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});
afterEach(async () => {
  evictPrivateConnections('ws-1');
  for (const socket of sockets) socket.destroy();
  await Promise.all([new Promise<void>((resolve) => origin.close(() => resolve())), new Promise<void>((resolve) => gateway.close(() => resolve())),
    new Promise<void>((resolve) => websocket.close(() => resolve()))]);
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
    const peer = [...websocket.clients][0];
    const closed = new Promise<number>((resolve) => peer.once('close', resolve));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(await closed).toBe(1006);
  });
  it('terminates the WebSocket when response consumption is cancelled', async () => {
    serve = (_req, res) => { res.writeHead(200); res.write('partial'); };
    const response = await mcpFetch(url, {}, context);
    const peer = [...websocket.clients][0];
    const closed = new Promise<number>((resolve) => peer.once('close', resolve));
    await response.body!.cancel();
    expect(await closed).toBe(1006);
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
  it.each([400, 401, 426, 502, 503])('records the gateway status for HTTP %s without exposing remote data', async (status) => {
    deny = status;
    denyCode = 'remote-code-secret';
    const failure = await mcpFetch(`${url}?token=query-secret`, {
      method: 'POST', headers: { authorization: 'Bearer header-secret' }, body: 'body-secret',
    }, context).catch((error: unknown) => error);
    expect(failure).toMatchObject({ cause: { code: status === 503 ? 'private_routes_unavailable' : 'private_transport_unavailable' } });
    expect(fetchFailureReason(failure)).toContain(status === 503 ? 'private route owner' : 'private connection is unavailable');
    expect(bodies).toHaveLength(1);
    expect(vi.mocked(console.info).mock.calls.at(-1)?.[1]).toMatchObject({
      transport: 'private', phase: 'gateway_response', gatewayStatus: status, gatewayCode: 'unrecognized',
    });
    const audit = JSON.stringify(vi.mocked(console.info).mock.calls);
    for (const secret of ['remote-code-secret', 'query-secret', 'header-secret', 'body-secret',
      'tenant-test-value', '/mcp', 'Do not log destination secrets.']) expect(audit).not.toContain(secret);
  });
  it.each(['{"code":"standby_owner"}', '{"error":"standby_owner"}', '<html>remote-body-secret</html>',
    'null', 'x'.repeat(8193)])('bounds and parses a rejected gateway response (%#)', async (body) => {
    deny = 502; denyBody = body;
    const failure = await mcpFetch(url, {}, context).catch((error: unknown) => error);
    expect(failure).toMatchObject({ cause: { code: body.includes('standby_owner') ? 'standby_owner' : 'private_transport_unavailable' } });
    expect(vi.mocked(console.info).mock.calls.at(-1)?.[1]).toMatchObject({ gatewayStatus: 502 });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('remote-body-secret');
  });
  it('refuses an unexpected 101 upgrade protocol', async () => {
    upgrade = 'unexpected-protocol-secret';
    await expect(mcpFetch(url, {}, context)).rejects.toMatchObject({ cause: { code: 'invalid_upgrade' } });
    expect(vi.mocked(console.info).mock.calls.at(-1)?.[1]).toMatchObject({ phase: 'gateway_upgrade', gatewayStatus: 101 });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(upgrade);
  });
  it.each([undefined, 'unexpected-subprotocol-secret'])('refuses a missing or incorrect WebSocket subprotocol (%#)', async (protocol) => {
    subprotocol = protocol;
    await expect(mcpFetch(url, {}, context)).rejects.toMatchObject({ cause: { code: 'invalid_upgrade' } });
    expect(bodies).toHaveLength(1);
    expect(vi.mocked(console.info).mock.calls.at(-1)?.[1]).toMatchObject({ phase: 'gateway_upgrade', gatewayStatus: 101 });
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('unexpected-subprotocol-secret');
  });
  it.each([301, 302, 307, 308])('does not follow a gateway redirect (%s)', async (status) => {
    deny = status;
    await expect(mcpFetch(url, {}, context)).rejects.toMatchObject({ cause: { code: 'private_transport_unavailable' } });
    expect(bodies).toHaveLength(1);
    expect(vi.mocked(console.info).mock.calls.at(-1)?.[1]).toMatchObject({ gatewayStatus: status });
  });
  it('does not open a connection after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(dialPrivateTcp(mocks.endpoint, 'tenant-test-value', 'ws-1', 'connector-1', 'mcp.private.test', 443, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(bodies).toHaveLength(0);
  });
  it.each([8192, 8193])('bounds the route header to 8192 bytes (%s)', async (size) => {
    const host = 'mcp.private.test';
    const overhead = Buffer.byteLength(JSON.stringify({ connectorId: '', host, port: 443 }));
    const connector = 'x'.repeat(size - overhead);
    const pending = dialPrivateTcp(mocks.endpoint, 'tenant-test-value', 'ws-1', connector, host, 443, new AbortController().signal);
    if (size > 8192) {
      await expect(pending).rejects.toMatchObject({ code: 'invalid_private_route' });
      expect(bodies).toHaveLength(0);
    } else {
      const stream = await pending;
      expect(bodies).toEqual([{ connectorId: connector, host, port: 443 }]);
      stream.destroy();
    }
  });
  it.each(['text', 'large'] as const)('refuses a %s WebSocket message', async (frame) => {
    invalidFrame = frame;
    await expect(mcpFetch(url, {}, context)).rejects.toThrow();
    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('frame-secret');
  });
  it('records a refused gateway connection without changing its public failure reason', async () => {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    const failure = await mcpFetch(url, {}, context).catch((error: unknown) => error);
    expect(fetchFailureReason(failure)).toBe('the server refused the connection');
    expect(bodies).toHaveLength(0);
    expect(vi.mocked(console.info).mock.calls.at(-1)?.[1]).toMatchObject({ transport: 'private', networkCode: 'ECONNREFUSED' });
  });
  it.each(['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'])('retains the known network code %s', (code) => {
    expect(mcpFailureDiagnostics(new Error('outer-secret', { cause: Object.assign(new Error('inner-secret'), { code }) })))
      .toEqual({ networkCode: code });
  });
  it('drops unknown network codes and messages', () => {
    expect(mcpFailureDiagnostics(Object.assign(new Error('message-secret'), { code: 'code-secret' }))).toBeUndefined();
  });
  it('removes the abort listener after a rejected response', async () => {
    deny = 502; denyBody = 'x'.repeat(8193);
    const signal = new AbortController().signal;
    const remove = vi.spyOn(signal, 'removeEventListener');
    await expect(dialPrivateTcp(mocks.endpoint, 'tenant-test-value', 'ws-1', 'connector-1', 'mcp.private.test', 443, signal))
      .rejects.toMatchObject({ code: 'private_transport_unavailable' });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
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
