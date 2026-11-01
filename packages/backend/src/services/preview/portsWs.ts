import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { eq } from 'drizzle-orm';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { workspaces } from '../../db/schema.js';
import { AuthError, verifyTokenAndGetUser } from '../../middleware/auth.js';
import { userMayUseWorkbenches } from '../workbenches/access.js';
import { fleetClientFor } from '../workbenches/sandboxRuntime.js';
import { getWorkbench } from '../workbenches/store.js';
import { isSafePreviewPath, type PortTarget } from './portsHttp.js';

export interface PreviewPortPath { workbenchId: string; port: number; path: string }

export function matchPreviewPortPath(pathname: string): PreviewPortPath | null {
  const match = /^\/api\/v1\/workbenches\/([^/]+)\/ports\/(\d+)\/(.*)$/.exec(pathname);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  try {
    const workbenchId = decodeURIComponent(match[1]);
    if (!workbenchId || /[/\\\0]/.test(workbenchId) || !isSafePreviewPath(match[3])) return null;
    return { workbenchId, port, path: match[3] };
  } catch { return null; }
}

const MAX_BUFFER = 1024 * 1024;
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BUFFER });

export function handlePreviewPortUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, route: PreviewPortPath): void {
  const query = new URL(req.url ?? '/', 'http://localhost').search;
  wss.handleUpgrade(req, socket, head, (ws) => {
    runWithoutScope(() => servePreviewPort(ws, req.headers.authorization, route, query));
  });
}

/**
 * Upgrades a request that is already authorised (the preview host router) and
 * splices it to the port. `recheck` runs every 30 s and closes the socket when
 * the access is gone.
 */
export function acceptPreviewPortUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: PortTarget,
  pathAndQuery: string,
  opts: { expiresAt?: number; headers?: Record<string, string>; recheck?: () => Promise<boolean> },
): void {
  wss.handleUpgrade(req, socket, head, (ws) => {
    runWithoutScope(() => {
      const relay = relayPreviewSocket(ws);
      void relay.connect(target, pathAndQuery, opts.expiresAt, opts.headers);
      if (!opts.recheck) return;
      const recheck = opts.recheck;
      const timer = setInterval(() => {
        recheck().then((ok) => { if (!ok) relay.finish(4401, 'preview access ended'); }, () => undefined);
      }, 30_000);
      timer.unref();
      ws.once('close', () => clearInterval(timer));
    });
  });
}

interface PreviewRelay {
  connect(target: PortTarget, pathAndQuery: string, expiresAt?: number, headers?: Record<string, string>): Promise<void>;
  finish(code: number, reason: string): void;
  readonly closed: boolean;
}

/**
 * Splices a browser socket to the port's socket. Frames that arrive before the
 * upstream is open are queued, up to `MAX_BUFFER`. With `onAuthFrame`, the
 * first frame must be `{ type: 'auth', token }` and goes to that callback.
 */
function relayPreviewSocket(ws: WebSocket, onAuthFrame?: (token: string) => void): PreviewRelay {
  let phase: 'auth' | 'opening' | 'open' | 'closed' = onAuthFrame ? 'auth' : 'opening';
  let upstream: WebSocket | undefined;
  let expiry: NodeJS.Timeout | undefined;
  const queued: Array<{ data: RawData; binary: boolean }> = [];
  let queuedBytes = 0;
  const finish = (code: number, reason: string) => {
    if (phase === 'closed') return;
    phase = 'closed';
    clearTimeout(timeout);
    clearTimeout(expiry);
    queued.length = 0;
    for (const peer of [ws, upstream]) {
      if (!peer) continue;
      if (peer.readyState === WebSocket.CONNECTING) { peer.terminate(); continue; }
      // Reserved transport codes cannot be sent in a close frame.
      const wireCode = code === 1005 ? 1000 : code === 1006 || code === 1015 ? 1011 : code;
      if (peer.readyState === WebSocket.OPEN) peer.close(wireCode, reason);
    }
  };
  const timeout = setTimeout(() => finish(4401, 'auth timeout'), 10_000);
  const forward = (peer: WebSocket, data: RawData, binary: boolean) => {
    if (peer.bufferedAmount > MAX_BUFFER) return finish(1009, 'preview buffer is full');
    if (peer.readyState === WebSocket.OPEN) peer.send(data, { binary });
  };
  ws.on('error', () => finish(1011, 'socket error'));
  ws.on('close', (code, reason) => finish(code, reason.toString()));
  ws.on('message', (data, binary) => {
    if (phase === 'closed') return;
    if (phase === 'auth') {
      let frame: { type?: unknown; token?: unknown } | null = null;
      try { if (!binary) frame = JSON.parse(data.toString()) as { type?: unknown; token?: unknown }; } catch { /* Refuse invalid JSON. */ }
      if (!frame || frame.type !== 'auth' || typeof frame.token !== 'string') return finish(4401, 'expected an auth frame first');
      phase = 'opening';
      onAuthFrame?.(frame.token);
      return;
    }
    if (phase === 'open' && upstream) forward(upstream, data, binary);
    else {
      queuedBytes += Array.isArray(data) ? data.reduce((n, part) => n + part.length, 0) : data.byteLength;
      if (queuedBytes > MAX_BUFFER || queued.length >= 256) return finish(1009, 'preview buffer is full');
      queued.push({ data, binary });
    }
  });

  async function connect(target: PortTarget, pathAndQuery: string, expiresAt?: number, headers?: Record<string, string>): Promise<void> {
    try {
      const client = await fleetClientFor(target.workspaceId, target.fleetHost);
      if ((phase as string) === 'closed') return;
      if (expiresAt) expiry = setTimeout(() => finish(4400, 'authorization expired'), expiresAt - Date.now());
      clearTimeout(timeout);
      upstream = headers
        ? client.openPortWebSocket(target.sandboxId, target.port, pathAndQuery, ws.protocol, headers)
        : client.openPortWebSocket(target.sandboxId, target.port, pathAndQuery, ws.protocol);
      upstream.on('error', () => finish(1011, 'could not open the preview'));
      upstream.on('close', (code, reason) => finish(code, reason.toString()));
      upstream.on('message', (data, binary) => forward(ws, data, binary));
      upstream.on('open', () => {
        if (phase === 'closed') { upstream?.terminate(); return; }
        phase = 'open';
        for (const frame of queued.splice(0)) forward(upstream!, frame.data, frame.binary);
        queuedBytes = 0;
      });
    } catch (err) {
      console.warn(`[preview] socket failed for sandbox ${target.sandboxId}:`, err);
      finish(1011, 'could not open the preview');
    }
  }

  return { connect, finish, get closed() { return phase === 'closed'; } };
}

export function servePreviewPort(ws: WebSocket, authorization: string | undefined, route: PreviewPortPath, query: string): void {
  const relay = relayPreviewSocket(ws, authorization === undefined ? (token) => void authorise(token) : undefined);

  async function authorise(token: string): Promise<void> {
    try {
      const user = await verifyTokenAndGetUser(token);
      if (relay.closed) return;
      if (!user) return relay.finish(4401, 'invalid token');
      if (!(await userMayUseWorkbenches({ distinctId: user.id, email: user.email }))) {
        return relay.finish(4403, 'sessions are not available for this account');
      }
      const row = await getWorkbench(route.workbenchId);
      if (!row) return relay.finish(4404, 'session not found');
      const [workspace] = await getPoolDbClient().select({ ownerId: workspaces.ownerId }).from(workspaces)
        .where(eq(workspaces.id, row.workspaceId)).limit(1);
      if (workspace?.ownerId !== user.id) return relay.finish(4404, 'session not found');
      if (row.runtime !== 'sandbox') return relay.finish(4403, 'preview requires a sandbox');
      if (row.archivedAt || row.status === 'archived' || row.status === 'error') return relay.finish(1008, 'not_ready');
      if (row.status !== 'ready' || !row.sandboxId) return relay.finish(1013, 'session is not ready');
      if (user.expiresAt && user.expiresAt <= Date.now()) return relay.finish(4401, 'authorization expired');
      if (relay.closed) return;
      await relay.connect(
        { workspaceId: row.workspaceId, fleetHost: row.fleetHost, sandboxId: row.sandboxId, port: route.port },
        `${route.path}${query}`,
        user.expiresAt,
      );
    } catch (err) {
      if (err instanceof AuthError) return relay.finish(err.code === 'unavailable' ? 1013 : 4401, 'authentication failed');
      console.warn(`[preview] socket failed for ${route.workbenchId}:`, err);
      relay.finish(1011, 'could not open the preview');
    }
  }

  if (authorization !== undefined) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(authorization);
    if (!bearer) relay.finish(4401, 'invalid authorization header');
    else void authorise(bearer[1]);
  }
}
