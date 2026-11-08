import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { connect as tlsConnect, checkServerIdentity } from 'node:tls';
import type { Duplex } from 'node:stream';
import { Agent } from 'undici';
import WebSocket, { createWebSocketStream } from 'ws';
import { fleetGatewayToken, fleetPinnedEndpoint } from '../selfHosted/credentials.js';

const DIAL_TIMEOUT_MS = 5_000;

interface GatewayFailure {
  phase: 'gateway_response' | 'gateway_upgrade';
  gatewayStatus: number;
  gatewayCode?: string;
}

const gatewayCodes = new Set([
  'unauthorized', 'bad_request', 'private_upgrade_required', 'standby_owner', 'connector_standby',
  'private_routes_unavailable', 'private_tunnel_limit', 'connector_not_connected',
  'private_route_denied', 'no_such_connector', 'account_deleting',
]);
const networkCodes = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET', 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
]);

export class McpTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly connectorId?: string,
    readonly diagnostics?: GatewayFailure,
  ) {
    super(message);
    this.name = 'McpTransportError';
  }
}

// Copy only known codes. Error messages and remote fields can contain secrets.
export function mcpFailureDiagnostics(error: unknown): GatewayFailure | { networkCode: string } | undefined {
  for (let depth = 0; error instanceof Error && depth < 5; depth++, error = error.cause) {
    if (error instanceof McpTransportError && error.diagnostics) return error.diagnostics;
    const code = (error as NodeJS.ErrnoException).code;
    if (code && networkCodes.has(code)) return { networkCode: code };
  }
  return undefined;
}

export function dialError(status: number, code?: string, phase?: GatewayFailure['phase']): McpTransportError {
  const diagnostics: GatewayFailure | undefined = phase && {
    phase, gatewayStatus: status,
    ...(code ? { gatewayCode: gatewayCodes.has(code) ? code : 'unrecognized' } : {}),
  };
  const failure = (result: string, message: string) => new McpTransportError(result, message, undefined, diagnostics);
  if (code === 'standby_owner' || code === 'connector_standby')
    return failure('standby_owner', 'The private connector owner is on standby. Try again shortly.');
  if (status === 403)
    return failure('destination_denied', 'YAS denied this private destination. Check its exact route.');
  if (status === 404)
    return failure('route_missing', 'Add an exact private route for this hostname and port.');
  if (status === 503)
    return failure('private_routes_unavailable', 'The private route owner is unavailable or on standby. Try again shortly.');
  if (status === 429)
    return failure('private_tunnel_limit', 'Private connection capacity is full. Try again shortly.');
  if (status === 409)
    return failure('connector_not_connected', 'The private connector is not connected. Check its status.');
  return failure('private_transport_unavailable', 'The private connection is unavailable. Try again shortly.');
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
    signal.throwIfAborted();
    const route = JSON.stringify({ connectorId, host, port });
    if (Buffer.byteLength(route) > 8192)
      throw new McpTransportError('invalid_private_route', 'The private route metadata is too large.');
    const target = new URL(`${endpoint}/v1/workspaces/${encodeURIComponent(workspaceId)}/private-routes/dial`);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(target, 'yas-private-tcp-v1', {
      headers: {
        authorization: `Bearer ${token}`,
        'Yas-Private-Route': route,
      },
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: 64 * 1024,
      handshakeTimeout: DIAL_TIMEOUT_MS,
    });
    let settled = false;
    let upgraded = false;
    const detach = () => signal.removeEventListener('abort', abort);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      detach();
      reject(error);
      socket.terminate();
    };
    const abort = () => fail(signal.reason instanceof Error ? signal.reason : new Error('The request was cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    socket.on('error', (error) => fail(upgraded
      ? new McpTransportError('invalid_upgrade', 'YAS refused the private TCP upgrade.', undefined,
        { phase: 'gateway_upgrade', gatewayStatus: 101 })
      : error));
    socket.once('upgrade', () => { upgraded = true; });
    socket.once('unexpected-response', (_request, response) => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      const rejectResponse = (code?: string) => fail(dialError(response.statusCode ?? 0, code, 'gateway_response'));
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8192) {
          rejectResponse();
          response.destroy();
        } else chunks.push(chunk);
      });
      response.once('error', () => rejectResponse());
      response.once('end', () => {
        let code: string | undefined;
        try {
          const doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          code = typeof doc.code === 'string' ? doc.code : typeof doc.error === 'string' ? doc.error : undefined;
        } catch { /* Use the status when YAS has no error code. */ }
        rejectResponse(code);
      });
    });
    socket.once('open', () => {
      if (settled) { socket.terminate(); return; }
      detach();
      settled = true;
      socket.on('message', (_data, binary) => {
        if (!binary) stream.destroy(new McpTransportError('invalid_frame', 'YAS sent an invalid private TCP frame.'));
      });
      const stream = createWebSocketStream(socket);
      // The TLS socket takes over error handling after the promise resolves.
      stream.on('error', () => {});
      resolve(stream);
    });
    if (signal.aborted) abort();
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
