import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workspaces } from '../db/schema.js';

/**
 * The terminal socket: the auth frame, the three final close codes, and the
 * keystroke / resize / output wire as the desktop client speaks it.
 */

const tokens: Record<string, { id: string; email: string; isAdmin: boolean; expiresAt?: number }> = {
  'tok-a': { id: 'owner-a', email: 'a@example.test', isAdmin: false },
  'tok-b': { id: 'owner-b', email: 'b@example.test', isAdmin: false },
};

vi.mock('../middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/auth.js')>()),
  verifyTokenAndGetUser: async (token: string) => tokens[token] ?? null,
}));

const { handleTerminalUpgrade, matchTerminalPath, setTerminalOpenerForTests } = await import(
  '../services/workbenches/terminalBridge.js'
);
const { insertWorkbench, updateWorkbench } = await import('../services/workbenches/store.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');

describe('workbench terminal socket', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let url: (id: string, query?: string) => string;
  let written: Buffer[];
  let resizes: Array<[number, number]>;
  let opened: Array<{ session: string; cols: number; rows: number }>;
  let closedSessions: number;
  let output: ((data: Buffer) => void) | null;
  let exit: (() => void) | null;

  function connect(
    id: string,
    query = '',
  ): Promise<{ ws: WebSocket; closed: Promise<number>; reason: Promise<string>; received: Buffer[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url(id, query));
      const received: Buffer[] = [];
      ws.on('message', (data: Buffer) => received.push(data));
      const ended = new Promise<{ code: number; reason: string }>((r) =>
        ws.on('close', (code, reason) => r({ code, reason: reason.toString('utf8') })),
      );
      const closed = ended.then((e) => e.code);
      const reason = ended.then((e) => e.reason);
      ws.on('open', () => resolve({ ws, closed, reason, received }));
      ws.on('error', reject);
    });
  }
  const auth = (token: string) => JSON.stringify({ type: 'auth', token });

  beforeEach(async () => {
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    resetFeatureFlagsForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    await testDb.db.insert(repositories).values({ id: 'repo-a', workspaceId: 'ws-a', name: 'o/r', url: 'https://github.com/o/r' });
    const common = { workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'o/r', baseBranch: 'main', agent: 'claude' };
    await insertWorkbench({ ...common, id: 'wb-ready', name: 'paris', branch: 'paris', runtime: 'sandbox', status: 'ready', sandboxId: 'sb-1' });
    await insertWorkbench({ ...common, id: 'wb-new', name: 'oslo', branch: 'oslo', runtime: 'sandbox', status: 'provisioning', sandboxId: 'sb-2' });
    await insertWorkbench({ ...common, id: 'wb-local', name: 'rome', branch: 'rome', runtime: 'local', status: 'ready' });

    written = [];
    resizes = [];
    opened = [];
    closedSessions = 0;
    output = null;
    exit = null;
    setTerminalOpenerForTests(async (_row, opts, handlers) => {
      opened.push({ ...opts });
      output = handlers.onData;
      exit = handlers.onExit;
      return {
        write: (data) => written.push(Buffer.from(data)),
        resize: (cols, rows) => resizes.push([cols, rows]),
        close: () => {
          closedSessions++;
        },
      };
    });

    server = createServer();
    server.on('upgrade', (req, socket, head) => {
      const id = matchTerminalPath(new URL(req.url ?? '/', 'http://x').pathname);
      if (id) handleTerminalUpgrade(req, socket, head, id);
      else socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    url = (id, query = '') => `ws://127.0.0.1:${port}/api/v1/workbenches/${id}/terminal${query}`;
  });

  afterEach(async () => {
    setTerminalOpenerForTests(null);
    await new Promise((resolve) => server.close(resolve));
    await testDb.cleanup();
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
  });

  it.each([
    ['a bad token', auth('nope'), 'wb-ready', 4401],
    ['keystrokes before the auth frame', 'ls\n', 'wb-ready', 4401],
    ['a JSON frame that is not auth', JSON.stringify({ type: 'resize', cols: 80, rows: 24 }), 'wb-ready', 4401],
    ['an auth frame with no token', JSON.stringify({ type: 'auth' }), 'wb-ready', 4401],
    ["another owner's workbench", auth('tok-b'), 'wb-ready', 4404],
    ['a workbench that does not exist', auth('tok-a'), 'wb-nope', 4404],
    ['a local workbench', auth('tok-a'), 'wb-local', 4403],
    // Not final: the client tries again once the box is up.
    ['a workbench still provisioning', auth('tok-a'), 'wb-new', 1013],
  ])('closes %s', async (_name, first, id, code) => {
    const { ws, closed } = await connect(id);
    ws.send(first);
    expect(await closed).toBe(code);
    expect(opened).toEqual([]);
  });

  it('closes a binary first frame as unauthenticated', async () => {
    const { ws, closed } = await connect('wb-ready');
    ws.send(Buffer.from(auth('tok-a')));
    expect(await closed).toBe(4401);
  });

  it.each([
    ['archived', { archivedAt: new Date(), status: 'archived' }],
    ['archived but still marked ready', { archivedAt: new Date() }],
    ['failed to start', { status: 'error', sandboxState: 'error' }],
  ] as const)('closes a workbench that %s with the final 1008 not_ready', async (_name, patch) => {
    await updateWorkbench('wb-ready', patch);
    const { ws, closed, reason } = await connect('wb-ready');
    ws.send(auth('tok-a'));
    expect(await closed).toBe(1008);
    expect(await reason).toBe('not_ready');
    expect(opened).toEqual([]);
  });

  it('keeps the retryable 1013 for a workbench still starting', async () => {
    const { ws, closed, reason } = await connect('wb-new');
    ws.send(auth('tok-a'));
    expect(await closed).toBe(1013);
    expect(await reason).toBe('session is not ready');
  });

  it('closes 4403 when the flag is off', async () => {

    vi.stubEnv('WORKBENCHES_ENABLED', 'false');
    resetFeatureFlagsForTests();
    const off = await connect('wb-new');
    off.ws.send(auth('tok-a'));
    expect(await off.closed).toBe(4403);
  });

  it('bridges keystrokes, resizes and output once authenticated', async () => {
    const { ws, closed, received } = await connect('wb-ready', '?session=dev%20box!&cols=100&rows=30');
    ws.send(auth('tok-a'));
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    // The session name is cut down to what is safe in a tmux name.
    expect(opened[0]).toEqual({ session: 'devbox', cols: 100, rows: 30 });

    ws.send(Buffer.from('ls -la\r'));
    ws.send('plain text keys');
    ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 43 }));
    ws.send('{"not":"a control frame"}');
    await vi.waitFor(() => expect(written).toHaveLength(3));
    expect(written.map((b) => b.toString())).toEqual(['ls -la\r', 'plain text keys', '{"not":"a control frame"}']);
    expect(resizes).toEqual([[132, 43]]);

    output!(Buffer.from([0x1b, 0x5b, 0x48, 0xff]));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect([...received[0]]).toEqual([0x1b, 0x5b, 0x48, 0xff]);

    exit!();
    expect(await closed).toBe(1000);
    expect(closedSessions).toBe(1);
  });

  it.each([
    [{ cols: 1, rows: 99999 }, [[100, 30]]],
    [{ cols: 'wide', rows: 40 }, [[100, 40]]],
  ])('keeps the last good size when a resize is nonsense: %j', async (resize, expected) => {
    const { ws } = await connect('wb-ready', '?cols=100&rows=30');
    ws.send(auth('tok-a'));
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    ws.send(JSON.stringify({ type: 'resize', ...resize }));
    await vi.waitFor(() => expect(resizes).toEqual(expected));
    ws.close();
  });

  it('replays input typed while the shell was still opening', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    setTerminalOpenerForTests(async () => {
      await gate;
      return { write: (d) => written.push(Buffer.from(d)), resize: () => undefined, close: () => undefined };
    });
    const { ws } = await connect('wb-ready');
    ws.send(auth('tok-a'));
    ws.send(Buffer.from('early'));
    await new Promise((r) => setTimeout(r, 50));
    expect(written).toEqual([]);
    finish();
    await vi.waitFor(() => expect(written.map((b) => b.toString())).toEqual(['early']));
    ws.close();
  });

  it('closes the shell when the client goes away, and reports a failed open as retryable', async () => {
    const first = await connect('wb-ready');
    first.ws.send(auth('tok-a'));
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    first.ws.close();
    await vi.waitFor(() => expect(closedSessions).toBe(1));

    setTerminalOpenerForTests(async () => {
      throw new Error('the guest is not answering');
    });
    const second = await connect('wb-ready');
    second.ws.send(auth('tok-a'));
    expect(await second.closed).toBe(1011);
  });

  it('ends the socket with a retryable code when the token expires', async () => {
    tokens['tok-short'] = { id: 'owner-a', email: 'a@example.test', isAdmin: false, expiresAt: Date.now() + 150 };
    const { ws, closed } = await connect('wb-ready');
    ws.send(auth('tok-short'));
    expect(await closed).toBe(4400);
    expect(closedSessions).toBe(1);
  });
});
