import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import { WebSocket, type RawData } from 'ws';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workspaces } from '../db/schema.js';
import { matchPreviewPortPath, servePreviewPort } from '../services/preview/portsWs.js';
import { insertWorkbench } from '../services/workbenches/store.js';
import { setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';
import type { FleetClient } from '../services/selfHosted/client.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { createOriginPolicy } from '../services/originPolicy.js';
import { createWebSocketUpgradeGuard } from '../services/websocket.js';

vi.mock('../middleware/auth.js', async (original) => ({
  ...await original<typeof import('../middleware/auth.js')>(),
  verifyTokenAndGetUser: async (token: string) => token === 'bad' ? null : {
    id: token, email: `${token}@test.invalid`, isAdmin: false,
  },
}));

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  protocol = 'vite-hmr';
  sent: Array<{ data: RawData; binary: boolean }> = [];
  closed: { code: number; reason: string } | undefined;
  send(data: RawData, opts: { binary: boolean }) { this.sent.push({ data, binary: opts.binary }); }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }
  terminate() { this.close(1006, ''); }
  asWs() { return this as unknown as WebSocket; }
}

let db: Awaited<ReturnType<typeof createTestDb>>;
let upstream: Socket;
const open = vi.fn();
const clients: Socket[] = [];

beforeAll(async () => {
  db = await createTestDb();
  await seedUser(db.db, { id: 'owner' });
  await db.db.insert(workspaces).values({ id: 'ws', ownerId: 'owner', name: 'Mine' });
  await db.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'o/r', url: 'https://github.com/o/r' });
  for (const [id, runtime, status] of [['ready', 'sandbox', 'ready'], ['local', 'local', 'ready'], ['new', 'sandbox', 'provisioning'], ['archived', 'sandbox', 'archived']] as const) {
    await insertWorkbench({ id, workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', baseBranch: 'main', branch: id, name: id, runtime, status, sandboxId: 'sb', agent: 'claude' });
  }
});

beforeEach(() => {
  for (const client of clients.splice(0)) client.close(1000, 'done');
  open.mockReset();
  upstream = new Socket();
  open.mockImplementation(() => {
    queueMicrotask(() => upstream.emit('open'));
    return upstream.asWs();
  });
  setWorkbenchFleetClientForTests(async () => ({ openPortWebSocket: open } as unknown as FleetClient));
  vi.stubEnv('WORKBENCHES_ENABLED', 'true');
  vi.stubEnv('SESSION_PREVIEWS_ENABLED', 'true');
  resetFeatureFlagsForTests();
});

afterAll(async () => {
  for (const client of clients) client.close(1000, 'done');
  setWorkbenchFleetClientForTests(null);
  await db.cleanup();
  vi.unstubAllEnvs();
  resetFeatureFlagsForTests();
});

function connect(id = 'ready', authorization?: string) {
  const ws = new Socket();
  clients.push(ws);
  servePreviewPort(ws.asWs(), authorization, { workbenchId: id, port: 5173, path: 'hmr' }, '?token=app-token');
  return ws;
}

describe('preview socket paths', () => {
  it('keeps the encoded path and accepts allowed ports', () => {
    expect(matchPreviewPortPath('/api/v1/workbenches/wb/ports/1024/a%20b')).toEqual({ workbenchId: 'wb', port: 1024, path: 'a%20b' });
    expect(matchPreviewPortPath('/api/v1/workbenches/wb/ports/65535/')).not.toBeNull();
  });
  it.each(['80/', '1023/', '65536/', '1.5/', 'abc/', '3000/../exec', '3000/%2e%2e/exec', '3000/%ZZ'])('refuses %s', (path) => {
    expect(matchPreviewPortPath(`/api/v1/workbenches/wb/ports/${path}`)).toBeNull();
  });
  it('refuses malformed and encoded IDs', () => {
    expect(matchPreviewPortPath('/api/v1/workbenches/%ZZ/ports/3000/')).toBeNull();
    expect(matchPreviewPortPath('/api/v1/workbenches/a%2fb/ports/3000/')).toBeNull();
    expect(matchPreviewPortPath('/api/v1/workbenches/wb/terminal')).toBeNull();
  });
});

describe('preview socket authentication and relay', () => {
  it.each([
    ['bad', 'ready', 4401], ['other', 'ready', 4404], ['owner', 'missing', 4404],
    ['owner', 'local', 4403], ['owner', 'new', 1013], ['owner', 'archived', 1008],
  ])('refuses token %s for %s', async (token, id, code) => {
    const ws = connect(id, `Bearer ${token}`);
    await vi.waitFor(() => expect(ws.closed?.code).toBe(code));
    expect(open).not.toHaveBeenCalled();
  });

  it.each(['WORKBENCHES_ENABLED', 'SESSION_PREVIEWS_ENABLED'])('checks %s', async (flag) => {
    vi.stubEnv(flag, 'false');
    resetFeatureFlagsForTests();
    const ws = connect('ready', 'Bearer owner');
    await vi.waitFor(() => expect(ws.closed?.code).toBe(4403));
    expect(open).not.toHaveBeenCalled();
  });

  it.each(['garbage', '{}', '{"type":"auth"}'])('refuses invalid first frame %s', (frame) => {
    const ws = connect();
    ws.emit('message', Buffer.from(frame), false);
    expect(ws.closed?.code).toBe(4401);
  });

  it.each(['header', 'frame'])('relays text and binary with %s auth', async (mode) => {
    const ws = connect('ready', mode === 'header' ? 'Bearer owner' : undefined);
    if (mode === 'frame') ws.emit('message', Buffer.from(JSON.stringify({ type: 'auth', token: 'owner' })), false);
    ws.emit('message', Buffer.from('update'), false);
    ws.emit('message', Buffer.from([0, 1, 2]), true);
    await vi.waitFor(() => expect(upstream.sent).toEqual([
      { data: Buffer.from('update'), binary: false }, { data: Buffer.from([0, 1, 2]), binary: true },
    ]));
    expect(open).toHaveBeenCalledWith('sb', 5173, 'hmr?token=app-token', 'vite-hmr');
    upstream.emit('message', Buffer.from('reply'), false);
    upstream.emit('message', Buffer.from([0, 3]), true);
    expect(ws.sent).toEqual([{ data: Buffer.from('reply'), binary: false }, { data: Buffer.from([0, 3]), binary: true }]);
    upstream.close(4001, 'done');
    expect(ws.closed).toEqual({ code: 4001, reason: 'done' });
  });

  it('propagates a client close code upstream', async () => {
    const ws = connect('ready', 'Bearer owner');
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    ws.close(4002, 'client done');
    expect(upstream.closed).toEqual({ code: 4002, reason: 'client done' });
  });

  it('bounds the queue before authorization completes', () => {
    const ws = connect('ready', 'Bearer owner');
    ws.emit('message', Buffer.alloc(1024 * 1024 + 1), true);
    expect(ws.closed?.code).toBe(1009);
  });

  it('refuses invalid authorization headers', () => {
    expect(connect('ready', 'Basic owner').closed?.code).toBe(4401);
  });

  it('uses the terminal origin policy and connection budget', () => {
    const policy = createOriginPolicy({ ALLOWED_ORIGINS: 'https://app.test' });
    expect(policy.isAllowed('https://evil.test')).toBe(false);
    expect(policy.isAllowed(undefined)).toBe(true);
    const budget = createWebSocketUpgradeGuard();
    for (let i = 0; i < 50; i++) {
      expect(budget({ headers: {}, socket: new EventEmitter() } as IncomingMessage)).toBe(true);
    }
    expect(budget({ headers: {}, socket: new EventEmitter() } as IncomingMessage)).toBe(false);
  });
});
