import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { runWithoutScope } from '../../db/client.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { forwardRequestHeaders, isSafePreviewPath, proxyBody, proxyPortRequest } from './portsHttp.js';
import { acceptPreviewPortUpgrade } from './portsWs.js';
import { matchPreviewHost, previewBaseDomain, previewOrigin, type PreviewHostMatch } from './previewHost.js';
import {
  authorisePreview,
  PREVIEW_AUTH_PATH,
  PREVIEW_COOKIE,
  PREVIEW_SESSION_TTL_MS,
  redeemPreviewTicket,
} from './previewLinks.js';

/**
 * The preview host router. Mounted on the app BEFORE CORS, the API routes and
 * auth, so a request on a preview host never reaches the API: the app's own
 * `/api/v1/...` paths go to the app. A request on any other host passes
 * through untouched. See `previewLinks.ts` for the auth model.
 */
export function previewHostRouter(): RequestHandler {
  // Per IP. A Vite dev page loads about 300 modules, so this is ten full reloads a minute.
  const limit = rateLimit({ windowMs: 60_000, max: 3000, message: 'Too many preview requests. Slow down.' });
  return (req: Request, res: Response, next: NextFunction) => {
    const match = matchPreviewHost(req.headers.host, previewBaseDomain());
    if (match === null) return next();
    limit(req, res, () => {
      runWithoutScope(() => {
        handle(req, res, match).catch((err) => {
          console.warn('[preview] host request failed:', err);
          if (res.headersSent) res.end();
          else page(res, 502, 'The preview did not answer', 'The app in this session did not answer. Check that it is running, then reload.');
        });
      });
    });
  };
}

async function handle(req: Request, res: Response, match: PreviewHostMatch | 'invalid'): Promise<void> {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (match === 'invalid') return page(res, 404, 'Preview not found', 'This preview address is not valid.');
  const { pathname, search } = splitUrl(req.originalUrl);

  // All preview hosts are one site (talyn.dev), so SameSite=Lax still sends the
  // cookie on a request from another preview. Only a top-level page load may
  // come from another site.
  if (!fetchFromThisHostOrNavigation(req)) return page(res, 403, 'Not allowed', 'This preview only answers its own pages.');

  if (pathname === PREVIEW_AUTH_PATH) {
    if (req.method !== 'GET') return page(res, 405, 'Not allowed', 'Open the preview link in a browser.');
    const ticket = new URLSearchParams(search).get('ticket') ?? '';
    const session = await redeemPreviewTicket(match.id, ticket);
    if (!session) return page(res, 401, 'This link has expired', 'Preview links work once and expire after a few minutes. Open the preview from Talyn again.');
    res.setHeader('Set-Cookie', previewCookie(session.token));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, '/');
    return;
  }

  const cookies = splitCookies(req.headers.cookie);
  const access = await authorisePreview(match, cookies.ours);
  if (!access.ok) return page(res, access.status, titleFor(access.status), access.message);
  if (!isSafePreviewPath(pathname.slice(1))) return page(res, 400, 'Bad request', 'That path is not allowed.');

  const body = await proxyBody(req);
  if (body === 'too_large') return page(res, 413, 'Request too large', 'That request body is too large to forward.');
  const headers = forwardRequestHeaders(req);
  if (cookies.rest) headers.cookie = cookies.rest;
  await proxyPortRequest(req, res, access.target, `${pathname.slice(1)}${search}`, {
    headers,
    body,
    onHeaders: (upstream) => {
      const appCookies = upstream.headers.getSetCookie().map(appSetCookie).filter((c): c is string => c !== null);
      if (appCookies.length > 0) res.setHeader('Set-Cookie', appCookies);
      const location = upstream.headers.get('location');
      if (location) res.setHeader('Location', localLocation(location, match.port));
    },
  });
}

/** The WebSocket half: same cookie, plus the page's own Origin. */
export function handlePreviewHostUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, match: PreviewHostMatch | 'invalid'): void {
  void runWithoutScope(async () => {
    if (match === 'invalid') return refuse(socket, 404, 'Not Found');
    if (req.headers.origin !== previewOrigin(match.host)) return refuse(socket, 403, 'Forbidden');
    const { pathname, search } = splitUrl(req.url ?? '/');
    if (!isSafePreviewPath(pathname.slice(1))) return refuse(socket, 400, 'Bad Request');
    const cookies = splitCookies(req.headers.cookie);
    const access = await authorisePreview(match, cookies.ours);
    if (!access.ok) return refuse(socket, access.status, 'Unauthorized');
    acceptPreviewPortUpgrade(req, socket, head, access.target, `${pathname.slice(1)}${search}`, {
      expiresAt: access.expiresAt,
      ...(cookies.rest ? { headers: { cookie: cookies.rest } } : {}),
      recheck: async () => (await authorisePreview(match, cookies.ours)).ok,
    });
  }).catch((err) => {
    console.warn('[preview] host socket failed:', err);
    refuse(socket, 502, 'Bad Gateway');
  });
}

function refuse(socket: Duplex, status: number, text: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function splitUrl(raw: string): { pathname: string; search: string } {
  const at = raw.indexOf('?');
  const pathname = at === -1 ? raw : raw.slice(0, at);
  return { pathname: pathname.startsWith('/') ? pathname : `/${pathname}`, search: at === -1 ? '' : raw.slice(at) };
}

function fetchFromThisHostOrNavigation(req: Request): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== 'same-site' && site !== 'cross-site') return true;
  return (req.method === 'GET' || req.method === 'HEAD')
    && req.headers['sec-fetch-mode'] === 'navigate'
    && req.headers['sec-fetch-dest'] === 'document';
}

/** Talyn's cookie names. The app may neither read nor set them. */
const isTalynCookie = (name: string) => /^__(host|secure)-talyn/i.test(name);

/** Our cookie values, and the app's own cookies to forward. */
export function splitCookies(header: string | undefined): { ours: string[]; rest: string } {
  const ours: string[] = [];
  const rest: string[] = [];
  for (const part of (header ?? '').split(';')) {
    const pair = part.trim();
    if (!pair) continue;
    const at = pair.indexOf('=');
    const name = (at === -1 ? pair : pair.slice(0, at)).trim();
    if (name === PREVIEW_COOKIE) ours.push(pair.slice(at + 1).trim());
    else if (!isTalynCookie(name)) rest.push(pair);
  }
  return { ours, rest: rest.join('; ') };
}

/** The app's cookie, made host-only. Null for a cookie that uses Talyn's name. */
export function appSetCookie(value: string): string | null {
  const [pair, ...attributes] = value.split(';');
  const name = pair.split('=')[0].trim();
  if (!name || isTalynCookie(name)) return null;
  return [pair, ...attributes.filter((a) => a.split('=')[0].trim().toLowerCase() !== 'domain')].join(';');
}

/** A redirect to the app's own localhost address becomes a path on the preview host. */
export function localLocation(location: string, port: number): string {
  try {
    const url = new URL(location);
    if (['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(url.hostname) && url.port === String(port)) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // A relative Location stays as it is.
  }
  return location;
}

function previewCookie(token: string): string {
  return `${PREVIEW_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(PREVIEW_SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`;
}

function titleFor(status: number): string {
  if (status === 401) return 'Open this preview from Talyn';
  if (status === 410) return 'This session is archived';
  if (status === 503) return 'Not ready yet';
  return 'Preview not available';
}

/** Our own small page. The text is fixed, never from the request. */
function page(res: Response, status: number, title: string, message: string): void {
  res.status(status);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>`
    + '<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0b0c;color:#e6e6e6}'
    + 'main{max-width:28rem;padding:2rem}h1{font-size:1.15rem;margin:0 0 .5rem}p{margin:0;color:#a8a8ad}</style></head>'
    + `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
