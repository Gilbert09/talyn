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

export interface PreviewPortPath { workbenchId: string; port: number; path: string }

export function matchPreviewPortPath(pathname: string): PreviewPortPath | null {
  const match = /^\/api\/v1\/workbenches\/([^/]+)\/ports\/(\d+)\/(.*)$/.exec(pathname);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  try {
    const workbenchId = decodeURIComponent(match[1]);
    const path = decodeURIComponent(match[3]);
    if (!workbenchId || /[/\\\0]/.test(workbenchId) || /[\\\0]/.test(path) || path.split('/').some((p) => p === '.' || p === '..')) return null;
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

export function servePreviewPort(ws: WebSocket, authorization: string | undefined, route: PreviewPortPath, query: string): void {
  let phase: 'auth' | 'opening' | 'open' | 'closed' = 'auth';
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
      void authorise(frame.token);
      return;
    }
    if (phase === 'open' && upstream) forward(upstream, data, binary);
    else {
      queuedBytes += Array.isArray(data) ? data.reduce((n, part) => n + part.length, 0) : data.byteLength;
      if (queuedBytes > MAX_BUFFER || queued.length >= 256) return finish(1009, 'preview buffer is full');
      queued.push({ data, binary });
    }
  });

  async function authorise(token: string): Promise<void> {
    phase = 'opening';
    try {
      const user = await verifyTokenAndGetUser(token);
      if ((phase as string) === 'closed') return;
      if (!user) return finish(4401, 'invalid token');
      if (!(await userMayUseWorkbenches({ distinctId: user.id, email: user.email }))) {
        return finish(4403, 'sessions are not available for this account');
      }
      const row = await getWorkbench(route.workbenchId);
      if (!row) return finish(4404, 'session not found');
      const [workspace] = await getPoolDbClient().select({ ownerId: workspaces.ownerId }).from(workspaces)
        .where(eq(workspaces.id, row.workspaceId)).limit(1);
      if (workspace?.ownerId !== user.id) return finish(4404, 'session not found');
      if (row.runtime !== 'sandbox') return finish(4403, 'preview requires a sandbox');
      if (row.archivedAt || row.status === 'archived' || row.status === 'error') return finish(1008, 'not_ready');
      if (row.status !== 'ready' || !row.sandboxId) return finish(1013, 'session is not ready');
      if (user.expiresAt && user.expiresAt <= Date.now()) return finish(4401, 'authorization expired');
      if ((phase as string) === 'closed') return;
      const client = await fleetClientFor(row.workspaceId, row.fleetHost);
      if ((phase as string) === 'closed') return;
      if (user.expiresAt) expiry = setTimeout(() => finish(4400, 'authorization expired'), user.expiresAt - Date.now());
      clearTimeout(timeout);
      upstream = client.openPortWebSocket(row.sandboxId, route.port, `${route.path}${query}`, ws.protocol);
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
      if (err instanceof AuthError) return finish(err.code === 'unavailable' ? 1013 : 4401, 'authentication failed');
      console.warn(`[preview] socket failed for ${route.workbenchId}:`, err);
      finish(1011, 'could not open the preview');
    }
  }

  if (authorization !== undefined) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(authorization);
    if (!bearer) finish(4401, 'invalid authorization header');
    else void authorise(bearer[1]);
  }
}
