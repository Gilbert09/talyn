import http from 'http';
import { randomBytes } from 'crypto';

/**
 * A loopback callback for MCP server sign-in.
 *
 * Some MCP servers (pganalyze) register only allowlisted redirect URIs at
 * dynamic client registration. The hosted `talyn.dev` callback is not on their
 * list, but loopback addresses are, because local clients like Claude Code
 * need them. The desktop app listens on one, and the backend falls back to it
 * when the server refuses the hosted callback.
 *
 * This process does NOT exchange the code. The backend holds the PKCE
 * verifier, so the code is useless here; the renderer forwards `code` and
 * `state` to the backend's `/mcp-servers/complete`, the same route the web
 * callback page uses.
 *
 * The redirect uses the IP literal `127.0.0.1`, not `localhost` (RFC 8252
 * section 7.3). `localhost` can resolve to `::1` first, where another process
 * can hold the port (see codexAuth.ts).
 */

/** Tried first, so a reconnect can reuse the client registered on it. A busy
 *  port falls back to a random one, and the backend registers that one. */
export const PREFERRED_PORT = 47823;
const CALLBACK_PATH = '/callback';
/** The backend's flow expires after ten minutes. */
const TIMEOUT_MS = 10 * 60_000;

export interface McpLoopbackCallback {
  state: string;
  code?: string;
  error?: string;
}

interface Listener {
  id: string;
  server: http.Server;
  expectedState: string | null;
  resolve: ((value: McpLoopbackCallback | null) => void) | null;
  timer: NodeJS.Timeout;
}

/** One sign-in at a time. A new one closes the old, which frees the port. */
let active: Listener | null = null;

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0b0c;color:#e7e7e9}
div{text-align:center;max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}
p{color:#a1a1aa;margin:0;line-height:1.5}</style></head>
<body><div><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve((server.address() as { port: number }).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ port, host: '127.0.0.1' });
  });
}

function finish(listener: Listener, value: McpLoopbackCallback | null): void {
  if (active === listener) active = null;
  clearTimeout(listener.timer);
  listener.server.close();
  listener.server.closeAllConnections?.();
  const resolve = listener.resolve;
  listener.resolve = null;
  resolve?.(value);
}

/**
 * Start listening. Returns the redirect URI to offer the backend, and an id
 * for `waitMcpLoopback` and `closeMcpLoopback`.
 */
export async function openMcpLoopback(
  preferredPort = PREFERRED_PORT,
): Promise<{ id: string; redirectUri: string }> {
  if (active) finish(active, null);
  const server = http.createServer();
  let port: number;
  try {
    port = await listen(server, preferredPort);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    port = await listen(server, 0);
  }
  const listener: Listener = {
    id: randomBytes(16).toString('hex'),
    server,
    expectedState: null,
    resolve: null,
    timer: setTimeout(() => finish(listener, null), TIMEOUT_MS),
  };
  listener.timer.unref?.();
  if (active) finish(active, null);
  active = listener;

  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const state = url.searchParams.get('state');
    // The CSRF guard. A page that can reach this port cannot know the state,
    // so a mismatch is answered and ignored, and the real callback can still
    // arrive.
    if (!listener.expectedState || state !== listener.expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(page('Sign-in could not be verified', 'Close this tab and try again from Talyn.'));
      return;
    }
    const code = url.searchParams.get('code') ?? undefined;
    const error = url.searchParams.get('error') ?? undefined;
    if (!code && !error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(page('Sign-in did not finish', 'Close this tab and try again from Talyn.'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(error
      ? page('Sign-in was cancelled', 'You can close this tab.')
      : page('Finishing sign-in', 'You can close this tab and go back to Talyn.'));
    finish(listener, { state, ...(code ? { code } : {}), ...(error ? { error: error.slice(0, 500) } : {}) });
  });
  server.on('error', () => finish(listener, null));

  return { id: listener.id, redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}` };
}

/**
 * Wait for the callback that carries `state`. Resolves with null when the
 * listener closes first: a timeout, a newer sign-in or `closeMcpLoopback`.
 */
export function waitMcpLoopback(id: string, state: string): Promise<McpLoopbackCallback | null> {
  const listener = active;
  if (!listener || listener.id !== id || listener.resolve || !state) return Promise.resolve(null);
  listener.expectedState = state;
  return new Promise((resolve) => {
    listener.resolve = resolve;
  });
}

/** Stop listening. Does nothing when a newer sign-in replaced this one. */
export function closeMcpLoopback(id: string): void {
  if (active?.id === id) finish(active, null);
}
