import type { IncomingHttpHeaders } from 'node:http';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from '../../middleware/rateLimit.js';
import { debugBus } from '../debugBus.js';
import { inboundAdapterFor } from './adapters/index.js';
import { processInboundDelivery } from './process.js';
import { connectionSecrets, insertDelivery } from './store.js';

/**
 * The inbound receiver: verify, store, answer 200, process after the response.
 *
 * Senders retry on a slow or failed answer, and during a deploy two replicas
 * can both get a request. So the receiver only verifies and inserts, and
 * `UNIQUE (connection_id, delivery_id)` makes the insert the idempotency. The
 * replica whose insert won processes the delivery right after the response.
 * The sweep picks up anything a crash left behind.
 *
 * Mounted on the app BEFORE `express.json`, with its own raw-body parser: the
 * signature is over the exact bytes.
 */

export const INBOUND_PATH = '/api/v1/webhooks/in';

/**
 * The largest body Talyn stores. Every inbound receiver here (Slack, Polar)
 * takes 1 MB. A webhook that starts work describes one event in a few
 * kilobytes, and each stored body stays for 7 days, so a larger body is a
 * misconfigured sender and is refused with 413. The prompt quotes only the
 * first 16 KB of what is stored.
 */
export const MAX_INBOUND_BODY = '1mb';

/**
 * Requests one URL may send a minute. A rule runs at most its hourly limit
 * (5 by default) on its URL, so a sender above two requests a second gains
 * nothing and only fills the table. 120 leaves room for a burst.
 */
const PER_CONNECTION_PER_MINUTE = 120;

/**
 * Requests one IP may send a minute across every URL. Each request costs a
 * database read before it can be refused, so this stops a scan of guessed
 * connection ids from becoming a database load. It is 5 times the
 * per-connection limit, so one sender can feed several rules.
 */
const PER_IP_PER_MINUTE = 600;

/** A connection id is a uuid. Anything else is refused before the database read. */
const CONNECTION_ID = /^[0-9a-fA-F-]{36}$/;

/** Header names that can carry a credential or a signature. Never stored. */
const SECRET_HEADER_WORDS = ['auth', 'cookie', 'token', 'secret', 'signature', 'key', 'password', 'session'];
/** Proxy headers: the sender's IP and our own routing. Not about the event. */
const PROXY_HEADER_PREFIXES = ['x-forwarded-', 'x-real-ip', 'x-envoy-', 'x-railway-', 'x-request-start'];

/**
 * The headers kept with a delivery: `content-type`, `user-agent` and the
 * sender's `x-` headers, minus anything that can carry a credential, a
 * signature or proxy routing.
 */
export function keptHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const wanted = lower === 'content-type' || lower === 'user-agent' || lower.startsWith('x-');
    if (!wanted) continue;
    if (SECRET_HEADER_WORDS.some((word) => lower.includes(word))) continue;
    if (PROXY_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    const value = Array.isArray(raw) ? raw.join(', ') : raw;
    if (typeof value === 'string') out[lower] = value;
  }
  return out;
}

/** The body as stored: parsed JSON, else the text, else null for an empty body. */
export function parseInboundBody(rawBody: Buffer): unknown {
  if (rawBody.length === 0) return null;
  const text = rawBody.toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function notFound(res: Response): void {
  // One answer for an unknown URL and for a feature that is off, so the
  // receiver does not say which connection ids exist.
  res.status(404).json({ error: 'not found' });
}

export async function handleInboundWebhook(req: Request, res: Response): Promise<void> {
  const connectionId = String(req.params.connectionId ?? '');
  const urlToken = typeof req.params.token === 'string' && req.params.token ? req.params.token : null;
  if (!CONNECTION_ID.test(connectionId)) return notFound(res);

  const connection = await connectionSecrets(connectionId);
  const adapter = connection ? inboundAdapterFor(connection.kind) : null;
  if (!connection || !adapter) return notFound(res);
  if (!(await adapter.workspaceAllowed(connection.workspaceId))) return notFound(res);

  const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const verdict = adapter.verify({ rawBody, headers: req.headers, urlToken, connection });
  if (verdict !== 'valid') {
    debugBus.recordEvent({
      service: 'inbound',
      action: 'refused',
      ok: false,
      summary: `${connection.kind} ${connection.id}: ${verdict}`,
      workspaceId: connection.workspaceId,
    });
    res.status(401).json({ error: verdict === 'missing' ? 'missing credentials' : 'invalid credentials' });
    return;
  }

  const payload = parseInboundBody(rawBody);
  let stored: { id: string; inserted: boolean };
  try {
    stored = await insertDelivery({
      connectionId: connection.id,
      deliveryId: adapter.deliveryId(rawBody, req.headers),
      eventType: adapter.eventType(payload, req.headers),
      payload,
      headers: keptHeaders(req.headers),
      payloadBytes: rawBody.length,
    });
  } catch (err) {
    // Not stored, so the sender should try again.
    console.error('[inbound] could not store delivery:', err);
    res.status(500).json({ error: 'could not store the request' });
    return;
  }

  res.status(200).json({ received: true, duplicate: !stored.inserted, id: stored.id });
  debugBus.recordEvent({
    service: 'inbound',
    action: 'received',
    summary: `${connection.kind} ${connection.id}${stored.inserted ? '' : ' (duplicate)'}`,
    workspaceId: connection.workspaceId,
    meta: { duplicate: !stored.inserted },
  });
  if (stored.inserted) scheduleProcessing(stored.id);
}

/** Process a stored delivery after the response, off the request's async context. */
export function scheduleProcessing(id: string): void {
  setImmediate(() => {
    void processInboundDelivery(id).catch((err) => console.error(`[inbound] processing ${id} failed:`, err));
  });
}

/** `express.raw` with a JSON 413 for an oversized body instead of the HTML default. */
function readRawBody(req: Request, res: Response, next: NextFunction): void {
  express.raw({ type: () => true, limit: MAX_INBOUND_BODY })(req, res, (err?: unknown) => {
    if (err) {
      const status = (err as { status?: number }).status ?? 400;
      res.status(status).json({ error: status === 413 ? 'request body is over 1 MB' : 'could not read the request body' });
      return;
    }
    next();
  });
}

/**
 * Mount the receiver. Called in `index.ts` before `express.json`, and by the
 * tests on a bare app.
 */
export function mountInboundWebhooks(app: Express): void {
  const perIp = rateLimit({ windowMs: 60_000, max: PER_IP_PER_MINUTE, message: 'Too many requests.' });
  const perConnection = rateLimit({
    windowMs: 60_000,
    max: PER_CONNECTION_PER_MINUTE,
    keyFn: (req) => `inbound:${String(req.params.connectionId ?? '')}`,
    message: 'Too many requests to this URL.',
  });
  app.post([`${INBOUND_PATH}/:connectionId`, `${INBOUND_PATH}/:connectionId/:token`], perIp, perConnection, readRawBody, (req, res) => {
    handleInboundWebhook(req, res).catch((err) => {
      console.error('[inbound] webhook failed:', err);
      if (!res.headersSent) res.status(500).json({ error: 'webhook processing failed' });
    });
  });
}
