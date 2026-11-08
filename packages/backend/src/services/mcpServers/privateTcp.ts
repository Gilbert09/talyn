import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { connect as tlsConnect, checkServerIdentity } from 'node:tls';
import type { Duplex } from 'node:stream';
import { Agent } from 'undici';
import { fleetGatewayToken, fleetPinnedEndpoint } from '../selfHosted/credentials.js';

const DIAL_TIMEOUT_MS = 5_000;

export class McpTransportError extends Error {
  constructor(readonly code: string, message: string, readonly connectorId?: string) {
    super(message);
    this.name = 'McpTransportError';
  }
}

export function dialError(status: number, code?: string): McpTransportError {
  if (code === 'standby_owner' || code === 'connector_standby')
    return new McpTransportError('standby_owner', 'The private connector owner is on standby. Try again shortly.');
  if (status === 403)
    return new McpTransportError('destination_denied', 'YAS denied this private destination. Check its exact route.');
  if (status === 404)
    return new McpTransportError('route_missing', 'Add an exact private route for this hostname and port.');
  if (status === 503)
    return new McpTransportError('private_routes_unavailable', 'The private route owner is unavailable or on standby. Try again shortly.');
  if (status === 429)
    return new McpTransportError('private_tunnel_limit', 'Private connection capacity is full. Try again shortly.');
  if (status === 409)
    return new McpTransportError('connector_not_connected', 'The private connector is not connected. Check its status.');
  return new McpTransportError('private_transport_unavailable', 'The private connection is unavailable. Try again shortly.');
}

export function dialPrivateTcp(
  endpoint: string,
  token: string,
  workspaceId: string,
  connectorId: string,
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const target = new URL(`${endpoint}/v1/workspaces/${encodeURIComponent(workspaceId)}/private-routes/dial`);
    const body = JSON.stringify({ connectorId, host, port });
    const req = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        connection: 'Upgrade',
        upgrade: 'yas-private-tcp',
      },
    });
    const abort = () => req.destroy(signal.reason instanceof Error ? signal.reason : new Error('The request was cancelled.'));
    const detach = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    req.once('error', (error) => { detach(); reject(error); });
    req.once('upgrade', (response, socket, head) => {
      detach();
      if (response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== 'yas-private-tcp') {
        socket.destroy();
        reject(new McpTransportError('invalid_upgrade', 'YAS refused the private TCP upgrade.'));
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    req.once('response', (response) => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8192) {
          response.destroy();
          reject(dialError(response.statusCode ?? 0));
        } else chunks.push(chunk);
      });
      response.once('error', () => reject(dialError(response.statusCode ?? 0)));
      response.once('end', () => {
        detach();
        let code: string | undefined;
        try {
          const doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          code = typeof doc.code === 'string' ? doc.code : doc.error;
        } catch { /* Use the status when YAS has no error code. */ }
        reject(dialError(response.statusCode ?? 0, code));
      });
    });
    if (signal.aborted) abort();
    else req.end(body);
  });
}

interface Connection {
  workspaceId: string;
  state: string;
  agent: Agent;
  lifetime: AbortController;
}

// Connections are isolated by tenant, workspace, connector, host, and port.
const connections = new Map<string, Set<Connection>>();

export function evictPrivateConnections(workspaceId: string, state?: string): void {
  for (const [key, entries] of connections) {
    for (const entry of entries) {
      if (entry.workspaceId === workspaceId && entry.state !== state) {
        const error = new McpTransportError('route_changed', 'The private route changed. Retry this request.');
        entry.lifetime.abort(error);
        void entry.agent.destroy(error);
        entries.delete(entry);
      }
    }
    if (!entries.size) connections.delete(key);
  }
}

export function privateDispatcher(
  workspaceId: string,
  connectorId: string,
  host: string,
  port: number,
  servername: string,
  state: string,
  signal: AbortSignal,
): { agent: Agent; release: () => void } {
  const endpoint = fleetPinnedEndpoint();
  const token = fleetGatewayToken();
  if (!endpoint || !token)
    throw new McpTransportError('private_transport_unavailable', 'Private routes are unavailable on this deployment.');
  const tenant = createHash('sha256').update(token).digest('hex');
  const key = JSON.stringify([endpoint, tenant, workspaceId, connectorId, host, port]);
  const lifetime = new AbortController();
  const agent = new Agent({
    connections: 1,
    pipelining: 0,
    connect: (_options, callback) => {
      const phase = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(DIAL_TIMEOUT_MS)]);
      let stream: Duplex | undefined;
      let settled = false;
      const done = (error: Error | null, socket: ReturnType<typeof tlsConnect> | null) => {
        if (settled) return;
        settled = true;
        phase.removeEventListener('abort', abort);
        if (error) callback(error, null);
        else if (socket) callback(null, socket);
      };
      const abort = () => {
        stream?.destroy();
        done(lifetime.signal.reason instanceof McpTransportError ? lifetime.signal.reason
          : new McpTransportError(signal.aborted && signal.reason?.name !== 'TimeoutError' ? 'cancelled' : 'timeout',
            signal.aborted && signal.reason?.name !== 'TimeoutError' ? 'The MCP request was cancelled.' : 'The private connection timed out.'), null);
      };
      phase.addEventListener('abort', abort, { once: true });
      if (phase.aborted) { abort(); return; }
      void dialPrivateTcp(endpoint, token, workspaceId, connectorId, host, port, phase).then((socket) => {
        stream = socket;
        if (phase.aborted) { socket.destroy(); abort(); return; }
        const secure = tlsConnect({
          socket,
          servername: isIP(servername) ? undefined : servername,
          rejectUnauthorized: true,
          ALPNProtocols: ['http/1.1'],
          checkServerIdentity: (_hostname, certificate) => checkServerIdentity(servername, certificate),
        });
        stream = secure;
        secure.once('error', (error) => done(error, null));
        secure.once('secureConnect', () => done(null, secure));
      }, (error: Error) => done(error, null));
    },
  });
  const entry = { workspaceId, state, agent, lifetime };
  const entries = connections.get(key) ?? new Set<Connection>();
  entries.add(entry);
  connections.set(key, entries);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', release);
    entries.delete(entry);
    if (!entries.size && connections.get(key) === entries) connections.delete(key);
    lifetime.abort(new McpTransportError('cancelled', 'The MCP request was cancelled.'));
    void agent.destroy();
  };
  signal.addEventListener('abort', release, { once: true });
  if (signal.aborted) release();
  return { agent, release };
}
