import type { Request, Response } from 'express';
import { Readable } from 'stream';
import { fleetClientFor } from '../workbenches/sandboxRuntime.js';

/**
 * The HTTP half of a preview: one request to a port a script listens on in the
 * sandbox, through the fleet's ports route. The API route
 * (`/workbenches/:id/ports/:port/*`) and the preview host router
 * (`previewHostRouter.ts`) both use it, so both apply the same header rules.
 */

/** The largest request body a preview forwards. */
export const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Headers not passed back from a preview. Hop-by-hop ones belong to the
 * fleet's connection, not ours; `content-encoding` and `content-length`
 * describe bytes fetch has already decoded; and the app's own cookies and
 * CORS headers must not be set on the API's origin.
 */
export const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'set-cookie',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'x-fleet-host',
]);

/** What a preview request carries on. Never the caller's Authorization or cookies: those are Talyn's, not the dev server's. */
const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'user-agent', 'range', 'if-none-match', 'if-modified-since'];

export function forwardRequestHeaders(req: Pick<Request, 'headers'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

/** The body to forward: what `express.json` already parsed, or the raw stream it left alone. */
export async function proxyBody(req: Request): Promise<Buffer | null | 'too_large'> {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  if (req.is('application/json') && req.body !== undefined) return Buffer.from(JSON.stringify(req.body));
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_PROXY_BODY_BYTES) return 'too_large';
    chunks.push(chunk);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : null;
}

/**
 * Whether a path may go after `/ports/<port>/`. fetch resolves `.` and `..`
 * segments (also `%2e%2e`), so such a path would leave the ports route and
 * reach another fleet route with Talyn's fleet token. Checked on the path in
 * the form that is sent, decoded once.
 */
export function isSafePreviewPath(path: string): boolean {
  try {
    const decoded = decodeURIComponent(path);
    return !/[\\\0]/.test(decoded) && !decoded.split('/').some((p) => p === '.' || p === '..');
  } catch {
    return false;
  }
}

export interface PortTarget {
  workspaceId: string;
  fleetHost: string | null;
  sandboxId: string;
  port: number;
}

/**
 * Sends one request to the port and streams the answer back. Throws before
 * the response starts (a fleet fault), so the caller can answer in its own
 * words. `onHeaders` runs after the default header copy and before the body.
 */
export async function proxyPortRequest(
  req: Request,
  res: Response,
  target: PortTarget,
  pathAndQuery: string,
  opts: { headers: Record<string, string>; body: Buffer | null; onHeaders?: (upstream: globalThis.Response) => void },
): Promise<void> {
  const client = await fleetClientFor(target.workspaceId, target.fleetHost);
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const upstream = await client.proxyPort(target.sandboxId, target.port, pathAndQuery, {
    method: req.method,
    headers: opts.headers,
    ...(opts.body ? { body: opts.body } : {}),
    signal: controller.signal,
  });
  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (!DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
  });
  opts.onHeaders?.(upstream);
  if (!upstream.body) {
    res.end();
    return;
  }
  Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])
    .on('error', () => res.end())
    .pipe(res);
}
