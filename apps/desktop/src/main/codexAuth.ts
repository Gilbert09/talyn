import http from 'http';
import { randomBytes, createHash } from 'crypto';

/**
 * Sign in to a ChatGPT subscription, from the desktop app.
 *
 * # Why this lives in the main process and not on the backend
 *
 * OpenAI publishes no third-party OAuth for ChatGPT-subscription inference. The
 * only client whose tokens the Codex backend accepts is OpenAI's own Codex CLI
 * client, and its registered redirect is a LOOPBACK address —
 * `http://localhost:1455/auth/callback`. A hosted backend at prod.talyn.dev can
 * never be that, so the authorize leg has to run on the user's own machine.
 * This is the same flow `codex login` runs, and the same one other third-party
 * coding tools run (OpenCode identifies itself with `originator=opencode`; we
 * send `originator=talyn`).
 *
 * State that: it is not a documented integration point. OpenAI can revoke the
 * client or start refusing unfamiliar originators, and that would break every
 * connected workspace at once rather than one at a time. See
 * docs/CLOUD_PROVIDERS.md for the fallback if it happens.
 *
 * `apps/web` cannot do any of this — a browser has no loopback listener — so it
 * asks the user to paste what `codex login` already wrote to
 * `~/.codex/auth.json`.
 *
 * # What the renderer gets back
 *
 * The finished token pair, which it forwards to the backend through the normal
 * `PUT /cloud-providers/selfhosted/config` route. The tokens pass THROUGH the
 * renderer rather than being posted from here, so there is exactly one place
 * that knows how to talk to the backend and one place that holds the session.
 */

/**
 * Fixed by OpenAI's registration, not by us. The port cannot move: a different
 * one is a `redirect_uri` the authorization server has never seen, which comes
 * back as an error page rather than as a token.
 */
const PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
/** `offline_access` is what yields the refresh token the backend renews with. */
const SCOPE = 'openid profile email offline_access';
const ORIGINATOR = 'talyn';

/** Give up rather than hold port 1455 forever if the user closes the tab. */
const TIMEOUT_MS = 5 * 60_000;

export interface CodexSignInResult {
  accessToken: string;
  refreshToken: string;
  accountId: string | null;
  expiresIn?: number;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Read `chatgpt_account_id` out of the access token's claims (a decode, not a
 *  verification — we are not the audience, and the backend re-reads it itself). */
function accountIdFrom(accessToken: string): string | null {
  const parts = accessToken.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const id = payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof id === 'string' && id.trim() ? id : null;
  } catch {
    return null;
  }
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0b0c;color:#e7e7e9}
div{text-align:center;max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}
p{color:#a1a1aa;margin:0;line-height:1.5}</style></head>
<body><div><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

/**
 * Run the whole flow: start the loopback listener, hand the renderer an
 * authorize URL to open, wait for the redirect, exchange the code.
 *
 * The listener is bound to 127.0.0.1 rather than to every interface. It holds a
 * one-time authorization code for a few seconds, and there is no reason for
 * anything off this machine to be able to reach it.
 */
/**
 * Bind the loopback callback on BOTH address families, refusing to start if
 * anything else already holds the port.
 *
 * # Why this is not just `listen(PORT, '127.0.0.1')`
 *
 * OpenAI's redirect URI is `http://localhost:1455/auth/callback`, and on macOS
 * `localhost` resolves to `::1` before `127.0.0.1`. Binding IPv4 only means a
 * different process holding IPv6 `*:1455` receives the callback instead — and
 * because the two are different address families, that does NOT raise
 * EADDRINUSE, so nothing here notices.
 *
 * That is not hypothetical. It is what happened the first time this shipped:
 *
 *     Talyn     IPv4  TCP 127.0.0.1:1455 (LISTEN)
 *     OpenCode  IPv6  TCP *:1455         (LISTEN)
 *
 * Both bound happily, Chrome resolved `localhost` to `::1`, and OpenCode
 * answered our callback with "Invalid state — potential CSRF attack" (correct
 * of it: we issued that state, not OpenCode). Anything using the Codex CLI's
 * OAuth client collides the same way — `codex login`, Codex CLI, OpenCode.
 *
 * The fix is to bind the SPECIFIC loopback addresses, both of them. A specific
 * bind beats a wildcard one for routing, which is what takes the callback back
 * from a process holding `*:1455` — measured, not assumed:
 *
 *     specific ::1 bind while :: is held  -> bound
 *       connect localhost  -> us
 *       connect [::1]      -> us
 *       connect 127.0.0.1  -> the wildcard holder   (hence binding IPv4 too)
 *
 * EADDRINUSE is still fatal, but it now means what it says: another process
 * holds the exact same specific address, so we would not receive our own
 * callback. A partial bind is the state to avoid — it looks like it worked and
 * hands the authorization code to somebody else. That code is not usable
 * without our PKCE verifier, which never leaves this process, but a
 * credential-bearing redirect landing in another application is not a thing to
 * shrug at.
 */
async function listenOnLoopback(
  server: http.Server,
  family: 'ipv4' | 'ipv6',
): Promise<'bound' | 'unavailable'> {
  const host = family === 'ipv6' ? '::1' : '127.0.0.1';
  return new Promise((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (e.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${PORT} is already in use by another application. ChatGPT sign-in ` +
              'always redirects there, so only one app can run it at a time. Quit ' +
              'OpenCode / the Codex CLI (or finish the sign-in it started) and try again.',
          ),
        );
        return;
      }
      // A host with no IPv6 stack at all. Not an error — carry on with IPv4.
      if (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL' || e.code === 'EINVAL') {
        resolve('unavailable');
        return;
      }
      reject(e);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve('bound');
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // ipv6Only so the IPv6 socket cannot also claim IPv4 and make the second
    // bind collide with our own first one.
    server.listen({ port: PORT, host, ipv6Only: family === 'ipv6' });
  });
}

export async function signInToCodex(
  openUrl: (url: string) => void,
): Promise<CodexSignInResult> {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(32));

  // One handler, two sockets — see listenOnLoopback.
  const servers = [http.createServer(), http.createServer()];
  const closeAll = () => servers.forEach((srv) => srv.close());

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for the ChatGPT sign-in to finish.'));
    }, TIMEOUT_MS);

    const handle = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      const returnedState = url.searchParams.get('state');
      const returnedCode = url.searchParams.get('code');

      // The state check is the CSRF guard, and it has to run before anything
      // else is believed: without it, any page that can reach this loopback
      // could feed us an authorization code minted for a different account.
      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('Sign-in could not be verified', 'Close this tab and try again from Talyn.'));
        clearTimeout(timer);
        reject(new Error('The sign-in response did not match this request.'));
        return;
      }
      if (err || !returnedCode) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(page('Sign-in was cancelled', 'You can close this tab.'));
        clearTimeout(timer);
        reject(new Error(err ? `ChatGPT sign-in failed: ${err}` : 'No authorization code was returned.'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page('Codex connected', 'You can close this tab and go back to Talyn.'));
      clearTimeout(timer);
      resolve(returnedCode);
    };
    servers.forEach((srv) => srv.on('request', handle));

    // Errors AFTER binding — a dropped connection, a malformed request. Bind
    // failures are handled by listenOnLoopback below, which is what turns a
    // port collision into a message naming the app to quit.
    servers.forEach((srv) => srv.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e);
    }));

    // Bind IPv6 first: it is the one `localhost` resolves to on macOS, so it is
    // the one an interloper will be holding.
    void (async () => {
      try {
        const v6 = await listenOnLoopback(servers[0], 'ipv6');
        await listenOnLoopback(servers[1], 'ipv4');
        if (v6 === 'unavailable') servers[0].close();
      } catch (e) {
        clearTimeout(timer);
        reject(e);
        return;
      }
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: `http://localhost:${PORT}${CALLBACK_PATH}`,
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        state,
        originator: ORIGINATOR,
      });
      openUrl(`${AUTHORIZE_URL}?${params.toString()}`);
    })();
  }).finally(closeAll);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      redirect_uri: `http://localhost:${PORT}${CALLBACK_PATH}`,
      code_verifier: verifier,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI refused the sign-in (${res.status}): ${text.slice(0, 300)}`);
  }
  let body: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('OpenAI returned an unreadable token response.');
  }
  if (!body.access_token || !body.refresh_token) {
    // Both, or the connection stops working within the hour with nothing to
    // renew it — which surfaces as runs that worked this morning and do not now.
    throw new Error('OpenAI returned an incomplete sign-in (no access and refresh token pair).');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accountId: accountIdFrom(body.access_token),
    expiresIn: body.expires_in,
  };
}
