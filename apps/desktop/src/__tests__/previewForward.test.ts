/** @jest-environment node */
import http from 'http';
import type { AddressInfo } from 'net';
import { once } from 'events';
import WebSocket, { WebSocketServer } from 'ws';
import { PreviewForwarder } from '../main/workbench/previewForward';

let forwarder: PreviewForwarder;
let servers: http.Server[];
let clients: WebSocket[];
let wsServers: WebSocketServer[];

async function listen(server: http.Server, port = 0): Promise<number> {
  servers.push(server);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function request(port: number, options: http.RequestOptions = {}, body?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, ...options }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

function start(port: number, backend: number, overrides = {}) {
  return forwarder.start({ workbenchId: 'wb1', port, apiBaseUrl: `http://127.0.0.1:${backend}`, getToken: async () => 'secret', ...overrides });
}

beforeEach(() => {
  forwarder = new PreviewForwarder();
  servers = [];
  clients = [];
  wsServers = [];
});

afterEach(async () => {
  clients.forEach((client) => client.terminate());
  await forwarder.stopAll();
  wsServers.forEach((server) => { server.clients.forEach((client) => client.terminate()); server.close(); });
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});

it('uses the requested port and reuses simultaneous starts', async () => {
  const port = await freePort();
  const [first, second] = await Promise.all([start(port, 1234), start(port, 1234)]);
  expect(first).toEqual({ workbenchId: 'wb1', port, localPort: port, url: `http://localhost:${port}` });
  expect(second).toEqual(first);
  expect(forwarder.list()).toEqual([first]);
});

it('uses the next port when the requested port is busy', async () => {
  const port = await listen(http.createServer());
  expect((await start(port, 1234)).localPort).toBe(port + 1);
});

it('streams the method, path, query, body, status and headers with fresh credentials', async () => {
  const seen: Array<{ url?: string; method?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const backend = await listen(http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, body });
      res.writeHead(201, { 'x-preview': 'yes', connection: 'close, x-internal', 'x-internal': 'private' });
      res.write('hello ');
      res.end('world');
    });
  }));
  let token = 'first-token';
  const port = await freePort();
  await start(port, backend, { getToken: async () => token });
  const options = {
    method: 'POST', path: '/assets/main.js?q=1',
    headers: { authorization: 'client-secret', cookie: 'session=private', connection: 'close, x-private', 'x-private': 'hidden', 'x-app': 'retained' },
  };
  const result = await request(port, options, 'streamed body');
  expect(result).toMatchObject({ status: 201, body: 'hello world', headers: { 'x-preview': 'yes' } });
  expect(result.headers['x-internal']).toBeUndefined();
  expect(seen[0]).toMatchObject({ url: `/api/v1/workbenches/wb1/ports/${port}/assets/main.js?q=1`, method: 'POST', body: 'streamed body' });
  expect(seen[0].headers).toMatchObject({ authorization: 'Bearer first-token', host: `127.0.0.1:${backend}`, 'x-app': 'retained' });
  expect(seen[0].headers.cookie).toBeUndefined();
  expect(seen[0].headers['x-private']).toBeUndefined();
  token = 'refreshed-token';
  await request(port);
  expect(seen[1].headers.authorization).toBe('Bearer refreshed-token');
});

it('turns an expired backend token into a plain 502 response', async () => {
  const backend = await listen(http.createServer((_req, res) => res.writeHead(401).end('private backend error')));
  const port = await freePort();
  await start(port, backend);
  const result = await request(port);
  expect(result.status).toBe(502);
  expect(result.headers['content-type']).toContain('text/plain');
  expect(result.body).toContain('Preview access expired');
  expect(result.body).not.toContain('private backend error');
});

it.each([
  { host: 'attacker.example' },
  { origin: 'https://attacker.example' },
])('rejects nonlocal browser requests: %j', async (headers) => {
  const port = await freePort();
  await start(port, 1234);
  expect((await request(port, { headers })).status).toBe(403);
});

it('returns 502 if the backend cannot connect', async () => {
  const backend = await freePort();
  const port = await freePort();
  await start(port, backend);
  expect((await request(port)).status).toBe(502);
});

it('pipes WebSocket messages and preserves the subprotocol with backend authentication', async () => {
  const server = http.createServer();
  const backend = await listen(server);
  const wsServer = new WebSocketServer({ server });
  wsServers.push(wsServer);
  let received: http.IncomingMessage | undefined;
  wsServer.on('connection', (socket, req) => {
    received = req;
    socket.on('message', (message, binary) => socket.send(message, { binary }));
  });
  const port = await freePort();
  await start(port, backend);
  const client = new WebSocket(`ws://127.0.0.1:${port}/hmr?q=1`, 'vite-hmr', {
    headers: { cookie: 'private=true', authorization: 'client-secret' },
  });
  clients.push(client);
  await once(client, 'open');
  expect(client.protocol).toBe('vite-hmr');
  expect(received?.url).toBe(`/api/v1/workbenches/wb1/ports/${port}/hmr?q=1`);
  expect(received?.headers).toMatchObject({ authorization: 'Bearer secret', origin: `http://localhost:${port}` });
  expect(received?.headers.cookie).toBeUndefined();
  const message = once(client, 'message');
  client.send('hello HMR');
  expect((await message)[0].toString()).toBe('hello HMR');
  const closed = once(client, 'close');
  await forwarder.stop('wb1', port);
  await closed;
});

it('stops one port, then all ports, and releases each listener', async () => {
  const port = await freePort();
  const first = await start(port, 1234);
  const second = await start(port, 1234, { workbenchId: 'wb2' });
  await forwarder.stop('wb1', port);
  expect(forwarder.list()).toEqual([second]);
  await expect(request(first.localPort)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  await forwarder.stopAll();
  expect(forwarder.list()).toEqual([]);
  await expect(request(second.localPort)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
});

it.each([0, 1023, 65536, 3000.5])('rejects invalid port %s', async (port) => {
  await expect(start(port, 1234)).rejects.toThrow('Invalid preview');
});

it.each(['http://example.com', 'file:///tmp/preview', 'https://user:password@example.com'])('rejects unsafe API URL %s', async (apiBaseUrl) => {
  await expect(start(3000, 1234, { apiBaseUrl })).rejects.toThrow('preview API address');
});
