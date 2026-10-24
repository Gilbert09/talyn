import http, { type IncomingHttpHeaders, type IncomingMessage } from 'http';
import https from 'https';
import type { Duplex } from 'stream';
import type { PreviewForward } from '../../workbenchBridgeTypes';

interface StartInput {
  workbenchId: string;
  port: number;
  apiBaseUrl: string;
  getToken: () => Promise<string | null>;
}

interface Forward {
  input: StartInput;
  server: http.Server;
  sockets: Set<Duplex>;
  requests: Set<http.ClientRequest>;
  ready: Promise<PreviewForward>;
  stopped: boolean;
}

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);

function headersWithoutHop(headers: IncomingHttpHeaders, request = false): IncomingHttpHeaders {
  const excluded = new Set(HOP_HEADERS);
  for (const name of (headers.connection ?? '').split(',')) excluded.add(name.trim().toLowerCase());
  if (request) for (const name of ['host', 'authorization', 'cookie']) excluded.add(name);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}

function backendUrl(input: StartInput): URL {
  const url = new URL(input.apiBaseUrl);
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('The preview API address must use HTTPS or loopback HTTP.');
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/v1/workbenches/${encodeURIComponent(input.workbenchId)}/ports/${input.port}`;
  return url;
}

function failure(status?: number): string {
  return status === 401
    ? 'Preview access expired. Sign in to Talyn and open the preview again.'
    : 'Could not connect to the preview. Check that the run script is running.';
}

export class PreviewForwarder {
  private forwards = new Map<string, Forward>();

  async start(input: StartInput): Promise<PreviewForward> {
    if (typeof input.workbenchId !== 'string' || !input.workbenchId || !Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) {
      throw new Error('Invalid preview session or port.');
    }
    const destination = backendUrl(input);
    const key = `${input.workbenchId}:${input.port}`;
    const existing = this.forwards.get(key);
    if (existing) {
      if (existing.input.apiBaseUrl !== input.apiBaseUrl) throw new Error('The preview API address changed. Stop the preview first.');
      existing.input.getToken = input.getToken;
      return existing.ready;
    }
    const server = http.createServer();
    const forward: Forward = {
      input, server, sockets: new Set(), requests: new Set(), stopped: false,
      ready: Promise.resolve({ workbenchId: input.workbenchId, port: input.port, localPort: 0, url: '' }),
    };
    this.forwards.set(key, forward);
    const track = (socket: Duplex) => {
      forward.sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => forward.sockets.delete(socket));
    };
    server.on('connection', track);
    const allowed = (req: IncomingMessage, localPort: number) => {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) return false;
      if (![`localhost:${localPort}`, `127.0.0.1:${localPort}`].includes(req.headers.host ?? '')) return false;
      if (!req.headers.origin) return true;
      return [`http://localhost:${localPort}`, `http://127.0.0.1:${localPort}`].includes(req.headers.origin);
    };
    const connect = async (req: IncomingMessage, upgrade: boolean) => {
      const token = await forward.input.getToken();
      if (forward.stopped) throw new Error('The preview stopped.');
      if (!token) throw new Error('Preview access expired.');
      const localPort = (server.address() as { port: number }).port;
      const headers = headersWithoutHop(req.headers, true);
      headers.authorization = `Bearer ${token}`;
      if (upgrade) {
        headers.connection = 'Upgrade';
        headers.upgrade = 'websocket';
        headers.origin = `http://localhost:${localPort}`;
      }
      const upstream = (destination.protocol === 'https:' ? https : http).request(destination, {
        method: req.method,
        path: destination.pathname + req.url,
        headers,
      });
      forward.requests.add(upstream);
      upstream.once('close', () => forward.requests.delete(upstream));
      return upstream;
    };
    server.on('request', (req, res) => {
      const localPort = (server.address() as { port: number }).port;
      if (!allowed(req, localPort)) {
        res.writeHead(403).end('This preview accepts local requests only.');
        return;
      }
      const fail = (status?: number) => {
        if (res.headersSent) res.destroy();
        else res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(failure(status));
      };
      void connect(req, false).then((upstream) => {
        upstream.on('error', () => fail());
        res.once('close', () => upstream.destroy());
        req.once('aborted', () => upstream.destroy());
        if (res.destroyed) { upstream.destroy(); return; }
        upstream.on('response', (response) => {
          response.on('error', () => res.destroy());
          if (response.statusCode === 401) {
            fail(401);
            response.destroy();
            return;
          }
          res.writeHead(response.statusCode ?? 502, headersWithoutHop(response.headers));
          response.pipe(res);
        });
        req.pipe(upstream);
      }).catch(() => fail());
    });
    server.on('upgrade', (req, socket, head) => {
      const localPort = (server.address() as { port: number }).port;
      if (!allowed(req, localPort) || req.headers.upgrade?.toLowerCase() !== 'websocket') {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      const fail = (status?: number) => socket.end(
        `HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${failure(status)}`,
      );
      void connect(req, true).then((upstream) => {
        upstream.on('error', () => { if (!socket.destroyed) fail(); });
        socket.once('close', () => upstream.destroy());
        if (socket.destroyed) { upstream.destroy(); return; }
        upstream.on('response', (response) => { fail(response.statusCode); response.destroy(); });
        upstream.on('upgrade', (response, remote, remoteHead) => {
          if (socket.destroyed || forward.stopped) { remote.destroy(); return; }
          track(remote);
          const headers = headersWithoutHop(response.headers);
          headers.connection = 'Upgrade';
          headers.upgrade = 'websocket';
          socket.write('HTTP/1.1 101 Switching Protocols\r\n');
          for (const [name, value] of Object.entries(headers)) {
            for (const item of Array.isArray(value) ? value : [value]) {
              if (item !== undefined) socket.write(`${name}: ${item}\r\n`);
            }
          }
          socket.write('\r\n');
          if (remoteHead.length) socket.write(remoteHead);
          if (head.length) remote.write(head);
          socket.once('close', () => remote.destroy());
          remote.once('close', () => socket.destroy());
          socket.pipe(remote).pipe(socket);
        });
        upstream.end();
      }).catch(() => fail());
    });
    forward.ready = this.listen(forward).catch((error: unknown) => {
      if (this.forwards.get(key) === forward) this.forwards.delete(key);
      throw error;
    });
    return forward.ready;
  }

  private async listen(forward: Forward): Promise<PreviewForward> {
    for (let offset = 0; offset < 20 && forward.input.port + offset <= 65535; offset++) {
      if (forward.stopped) throw new Error('The preview stopped.');
      const localPort = forward.input.port + offset;
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => { forward.server.off('listening', onListening); reject(error); };
          const onListening = () => { forward.server.off('error', onError); resolve(); };
          forward.server.once('error', onError);
          forward.server.once('listening', onListening);
          forward.server.listen(localPort, '127.0.0.1');
        });
        return { workbenchId: forward.input.workbenchId, port: forward.input.port, localPort, url: `http://localhost:${localPort}` };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      }
    }
    throw new Error('No free preview port was found in 20 attempts.');
  }

  list(): PreviewForward[] {
    return [...this.forwards.values()].flatMap(({ server, input, stopped }) => {
      const address = server.address();
      return address && typeof address !== 'string' && !stopped
        ? [{ workbenchId: input.workbenchId, port: input.port, localPort: address.port, url: `http://localhost:${address.port}` }]
        : [];
    });
  }

  async stop(workbenchId: string, port?: number): Promise<void> {
    await Promise.all([...this.forwards.entries()].map(async ([key, forward]) => {
      if (forward.input.workbenchId !== workbenchId || (port !== undefined && forward.input.port !== port)) return;
      forward.stopped = true;
      await forward.ready.catch(() => undefined);
      for (const request of forward.requests) request.destroy();
      for (const socket of forward.sockets) socket.destroy();
      await new Promise<void>((resolve) => forward.server.close(() => resolve()));
      if (this.forwards.get(key) === forward) this.forwards.delete(key);
    }));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...new Set([...this.forwards.values()].map(({ input }) => input.workbenchId))].map((id) => this.stop(id)));
  }
}
