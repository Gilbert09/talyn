import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { eq } from 'drizzle-orm';
import { Client as SshClient, utils as sshUtils, type ClientChannel } from 'ssh2';
import { WebSocket, WebSocketServer } from 'ws';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { workspaces as workspacesTable } from '../../db/schema.js';
import { AuthError, verifyTokenAndGetUser, type AuthUser } from '../../middleware/auth.js';
import {
  FleetPtyUnsupportedError,
  PTY_FRAME,
  PTY_MAX_FRAME_PAYLOAD,
  type FleetClient,
} from '../selfHosted/client.js';
import { userMayUseWorkbenches } from './access.js';
import { fleetClientFor, recordWorkbenchEvent, repoDirFor } from './sandboxRuntime.js';
import { recoverLostSandbox } from './recovery.js';
import { getWorkbench, type WorkbenchRow } from './store.js';

/**
 * The terminal for a sandbox workbench: a WebSocket at
 * `/api/v1/workbenches/:id/terminal`, bridged to a shell in the box.
 *
 * # The wire, as the client speaks it
 *
 *  - The FIRST message is the text frame `{"type":"auth","token":…}`. The token
 *    is not in the URL, for the reason the main socket's is not: URLs land in
 *    access logs.
 *  - Keystrokes are BINARY frames (a text frame that is not a JSON control
 *    message is accepted as keystrokes too).
 *  - A resize is the text frame `{"type":"resize","cols":…,"rows":…}`.
 *  - Output is binary.
 *  - Close codes 4401 (bad or missing token), 4403 (not allowed) and 4404 (no
 *    such workbench) are final, and so is 1008 with the reason `not_ready`
 *    (the workbench failed to start or is archived). Any other code means "try
 *    again", and the client reconnects — into the same tmux session, so
 *    nothing is lost. A workbench still starting closes 1013, which retries.
 *
 * # Two ways into the box
 *
 * The fleet's `/pty` first: a framed pseudo-terminal straight from the guest
 * agent, no key to manage. An older guest refuses it (409 `pty_unsupported`),
 * and then the bridge speaks SSH over the fleet's `ssh-stream` relay with a
 * key made for this one session.
 *
 * # The SSH key set
 *
 * The fleet's `POST /ssh` REPLACES the box's whole authorized set and offers
 * no way to read it back. So Talyn owns that set for a workbench box: each
 * terminal open installs exactly one fresh ed25519 key and nothing else. sshd
 * checks a key when a session authenticates and never again, so replacing the
 * set does not disturb terminals that are already open; the one race — two
 * opens installing their keys at the same moment — costs the loser an
 * authentication failure, which it retries. The private half exists only in
 * this process's memory for the life of the connection.
 */

/** One keystroke frame is tiny; a paste can be large. The guest caps a pty frame at 1 MiB, so this matches it. */
const MAX_CLIENT_FRAME = PTY_MAX_FRAME_PAYLOAD;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
/** How many times an SSH open is retried when another open replaced the key set under it. */
const SSH_AUTH_RETRIES = 2;

const TERMINAL_PATH = /^\/api\/v1\/workbenches\/([^/]+)\/terminal$/;

/** The workbench id when `pathname` is a terminal socket path, else null. */
export function matchTerminalPath(pathname: string): string | null {
  const match = TERMINAL_PATH.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME });

/** Take over an upgrade the HTTP server routed here. The origin check has already run. */
export function handleTerminalUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, workbenchId: string): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  wss.handleUpgrade(req, socket, head, (ws) => {
    runWithoutScope(() => {
      serveTerminal(ws, workbenchId, {
        session: sanitiseSession(url.searchParams.get('session')),
        cols: dimension(url.searchParams.get('cols'), DEFAULT_COLS),
        rows: dimension(url.searchParams.get('rows'), DEFAULT_ROWS),
      });
    });
  });
}

function sanitiseSession(raw: string | null): string {
  const s = (raw ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return s || 'main';
}

function dimension(raw: string | null | number, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && n >= 2 && n <= 1000 ? n : fallback;
}

/** A shell in the box, whichever way it was reached. */
export interface TerminalSession {
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface SessionHandlers {
  onData(data: Buffer): void;
  onExit(): void;
}

interface OpenOptions {
  session: string;
  cols: number;
  rows: number;
}

/** Tests replace the box side; production never calls this. */
type Opener = (row: WorkbenchRow, opts: OpenOptions, handlers: SessionHandlers) => Promise<TerminalSession>;
let openerOverride: Opener | null = null;
export function setTerminalOpenerForTests(fn: Opener | null): void {
  openerOverride = fn;
}

function serveTerminal(ws: WebSocket, workbenchId: string, opts: OpenOptions): void {
  let phase: 'auth' | 'opening' | 'open' | 'closed' = 'auth';
  let session: TerminalSession | null = null;
  let expiryTimer: NodeJS.Timeout | undefined;
  /** Input that arrived while the shell was still being opened. */
  const backlog: Buffer[] = [];

  const close = (code: number, reason: string) => {
    if (phase === 'closed') return;
    phase = 'closed';
    clearTimeout(handshakeTimer);
    clearTimeout(expiryTimer);
    session?.close();
    session = null;
    try {
      ws.close(code, reason);
    } catch {
      ws.terminate();
    }
  };
  const handshakeTimer = setTimeout(() => close(4401, 'auth timeout'), HANDSHAKE_TIMEOUT_MS);

  const control = (text: string): { type?: unknown; cols?: unknown; rows?: unknown; token?: unknown } | null => {
    if (!text.startsWith('{')) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (phase === 'closed') return;
    if (phase === 'auth') {
      const msg = isBinary ? null : control(data.toString('utf8'));
      if (!msg || msg.type !== 'auth' || typeof msg.token !== 'string') {
        close(4401, 'expected an auth frame first');
        return;
      }
      phase = 'opening';
      clearTimeout(handshakeTimer);
      void authorise(msg.token);
      return;
    }
    if (!isBinary) {
      const msg = control(data.toString('utf8'));
      if (msg?.type === 'resize') {
        opts.cols = dimension(msg.cols as number, opts.cols);
        opts.rows = dimension(msg.rows as number, opts.rows);
        session?.resize(opts.cols, opts.rows);
        return;
      }
    }
    if (session) session.write(data);
    else if (backlog.length < 256) backlog.push(data);
  });
  ws.on('close', () => close(1000, 'client closed'));
  ws.on('error', () => close(1011, 'socket error'));

  async function authorise(token: string): Promise<void> {
    let user: AuthUser | null = null;
    let row: WorkbenchRow | null = null;
    try {
      user = await verifyTokenAndGetUser(token);
    } catch (err) {
      if (err instanceof AuthError && err.code === 'unavailable') return close(1013, 'auth unavailable');
    }
    if (!user) return close(4401, 'invalid token');
    try {
      if (!(await userMayUseWorkbenches({ distinctId: user.id, email: user.email }))) {
        return close(4403, 'sessions are not available for this account');
      }
      row = await getWorkbench(workbenchId);
      // Not found and not yours are one answer, as on every route.
      if (!row || !(await ownsWorkspace(user.id, row.workspaceId))) return close(4404, 'session not found');
      if (row.runtime !== 'sandbox') return close(4403, 'a local session has its terminal in the desktop app');
      // Failed or archived: final, because no box is coming until a person acts.
      if (row.archivedAt || row.status === 'archived' || row.status === 'error') return close(1008, 'not_ready');
      // Still coming up: not final, so the client tries again.
      if (row.status !== 'ready' || !row.sandboxId) return close(1013, 'session is not ready');
      if (phase === 'closed') return;

      if (user.expiresAt) {
        // A token's end is not the session's: the client reconnects with a
        // fresh one and lands back in the same tmux session.
        expiryTimer = setTimeout(() => close(4400, 'authorization expired'), Math.max(0, user.expiresAt - Date.now()));
      }
      const handlers: SessionHandlers = {
        onData: (chunk) => {
          if (phase !== 'closed' && ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
        },
        onExit: () => close(1000, 'shell exited'),
      };
      const opened = await (openerOverride ?? openSandboxTerminal)(row, opts, handlers);
      if ((phase as string) === 'closed') {
        opened.close();
        return;
      }
      session = opened;
      phase = 'open';
      recordWorkbenchEvent(row, 'terminal_open', `terminal session ${opts.session}`);
      for (const chunk of backlog.splice(0)) opened.write(chunk);
    } catch (err) {
      if (row) await recoverLostSandbox(row, err).catch(() => undefined);
      console.warn(`[workbench] terminal for ${workbenchId} failed to open:`, err);
      close(1011, 'could not open the terminal');
    }
  }
}

async function ownsWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const rows = await getPoolDbClient()
    .select({ ownerId: workspacesTable.ownerId })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return rows[0]?.ownerId === userId;
}

async function openSandboxTerminal(
  row: WorkbenchRow,
  opts: OpenOptions,
  handlers: SessionHandlers,
): Promise<TerminalSession> {
  const client = await fleetClientFor(row.workspaceId, row.fleetHost);
  try {
    return await openFleetPty(client, row, opts, handlers);
  } catch (err) {
    if (!(err instanceof FleetPtyUnsupportedError)) throw err;
    return openSshTerminal(client, row, opts, handlers);
  }
}

/** One pty frame: `[type:1][len:uint32 BE][payload]`. */
export function encodePtyFrame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/** Splits a byte stream back into pty frames; a frame may span chunks. */
export class PtyFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Array<{ type: number; payload: Buffer }> {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: Array<{ type: number; payload: Buffer }> = [];
    while (this.buffer.length >= 5) {
      const length = this.buffer.readUInt32BE(1);
      if (length > PTY_MAX_FRAME_PAYLOAD) throw new Error(`pty frame of ${length} bytes exceeds the protocol's cap`);
      if (this.buffer.length < 5 + length) break;
      out.push({ type: this.buffer.readUInt8(0), payload: this.buffer.subarray(5, 5 + length) });
      this.buffer = this.buffer.subarray(5 + length);
    }
    return out;
  }
}

/**
 * The fleet's own pty: `GET /v1/sandboxes/{id}/pty`, framed. DATA both ways,
 * RESIZE from us, and one EXIT from the guest, always last. `session` makes
 * the guest run the shell in `tmux new-session -A`, so a reconnect reattaches.
 */
export async function openFleetPty(
  client: FleetClient,
  row: WorkbenchRow,
  opts: OpenOptions,
  handlers: SessionHandlers,
): Promise<TerminalSession> {
  const stream = await client.openPty(row.sandboxId!, {
    cols: opts.cols,
    rows: opts.rows,
    session: opts.session,
    cwd: repoDirFor(row),
  });
  const decoder = new PtyFrameDecoder();
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    stream.destroy();
    handlers.onExit();
  };
  stream.on('data', (chunk: Buffer) => {
    try {
      for (const frame of decoder.push(chunk)) {
        if (frame.type === PTY_FRAME.DATA) handlers.onData(frame.payload);
        else if (frame.type === PTY_FRAME.EXIT) end();
      }
    } catch (err) {
      console.warn(`[workbench] pty stream for ${row.id} broke:`, err);
      end();
    }
  });
  stream.on('close', end);
  stream.on('error', end);
  return {
    write: (data) => {
      // A paste larger than one frame is split; the guest refuses a frame over its cap.
      for (let off = 0; off < data.length; off += PTY_MAX_FRAME_PAYLOAD) {
        if (!ended) stream.write(encodePtyFrame(PTY_FRAME.DATA, data.subarray(off, off + PTY_MAX_FRAME_PAYLOAD)));
      }
    },
    resize: (cols, rows) => {
      if (!ended) stream.write(encodePtyFrame(PTY_FRAME.RESIZE, Buffer.from(JSON.stringify({ cols, rows }))));
    },
    close: () => {
      ended = true;
      stream.destroy();
    },
  };
}

/** The shell an SSH session runs: tmux when the image has it, so a reconnect reattaches. */
function sshShellCommand(row: WorkbenchRow, session: string): string {
  const dir = repoDirFor(row).replace(/'/g, '');
  return (
    `cd '${dir}' 2>/dev/null; ` +
    `if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s 'talyn-${session}'; ` +
    `else exec "\${SHELL:-bash}" -l; fi`
  );
}

/**
 * The fallback: SSH end to end with the guest's sshd, over the fleet's
 * `ssh-stream` relay, with a key made for this session. See the file comment
 * for why replacing the box's key set is safe.
 */
export async function openSshTerminal(
  client: FleetClient,
  row: WorkbenchRow,
  opts: OpenOptions,
  handlers: SessionHandlers,
): Promise<TerminalSession> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= SSH_AUTH_RETRIES; attempt++) {
    try {
      return await openSshOnce(client, row, opts, handlers);
    } catch (err) {
      lastError = err;
      const authFailure = err instanceof Error && /authentication/i.test(err.message);
      if (!authFailure) break;
    }
  }
  throw lastError;
}

async function openSshOnce(
  client: FleetClient,
  row: WorkbenchRow,
  opts: OpenOptions,
  handlers: SessionHandlers,
): Promise<TerminalSession> {
  const keys = sshUtils.generateKeyPairSync('ed25519');
  const access = await client.setSshKeys(row.sandboxId!, [`${keys.public.trim()} talyn-terminal`]);
  const stream = await client.openSshStream(row.sandboxId!);
  // The guest's own host key, handed over by the fleet, so the session is
  // pinned rather than trusting whatever answered.
  const expectedHostKey = Buffer.from((access.hostPublicKey ?? '').trim().split(/\s+/)[1] ?? '', 'base64');
  const conn = new SshClient();
  const channel = await new Promise<ClientChannel>((resolve, reject) => {
    conn.on('ready', () => {
      conn.exec(
        sshShellCommand(row, opts.session),
        { pty: { term: 'xterm-256color', cols: opts.cols, rows: opts.rows } },
        (err, ch) => (err ? reject(err) : resolve(ch)),
      );
    });
    conn.on('error', reject);
    conn.connect({
      sock: stream,
      username: access.user,
      privateKey: keys.private,
      readyTimeout: 20_000,
      hostVerifier: (key: Buffer) => expectedHostKey.length > 0 && key.equals(expectedHostKey),
    });
  }).catch((err) => {
    conn.end();
    stream.destroy();
    throw err;
  });

  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    conn.end();
    handlers.onExit();
  };
  channel.on('data', (chunk: Buffer) => handlers.onData(chunk));
  channel.stderr.on('data', (chunk: Buffer) => handlers.onData(chunk));
  channel.on('close', end);
  conn.on('close', end);
  conn.on('error', end);
  return {
    write: (data) => {
      if (!ended) channel.write(data);
    },
    resize: (cols, rows) => {
      if (!ended) channel.setWindow(rows, cols, 0, 0);
    },
    close: () => {
      ended = true;
      conn.end();
      stream.destroy();
    },
  };
}
