import type { ApiResponse } from '@talyn/shared';
import { getConfig, getRuntime, onConfigChange, type ApiClientConfig } from './config.js';
import { canRun, type Reachability } from './runtime.js';

/**
 * The current access token, via the host app's session store. Returns null
 * when we're not logged in; callers surface a clear error then.
 */
export async function getAuthToken(): Promise<string | null> {
  const ctx = context();
  try {
    assertActive(ctx);
    const token = await ctx.config.getAccessToken();
    assertActive(ctx);
    return token;
  } finally {
    ctx.dispose();
  }
}

/**
 * A transport-level failure reaching the backend: `fetch` itself rejected
 * (offline, DNS, TLS, connection refused, or the hosted backend down / cold-
 * starting) rather than returning an HTTP error status. The native rejection is
 * an opaque `TypeError: Failed to fetch` with a minified stack and no hint of
 * which call failed — this wraps it with the method, path, and online state so a
 * captured exception is actually identifiable.
 */
export class ApiNetworkError extends Error {
  readonly method: string;
  readonly path: string;
  /** Legacy flag: true means the network is not known to be offline. */
  readonly online: boolean;
  readonly reachability: Reachability;

  constructor(method: string, path: string, cause: unknown) {
    const reachability = getRuntime().lifecycle.getSnapshot().reachability;
    const online = reachability !== 'offline';
    // The QUERY STRING is deliberately dropped from the message, though the
    // full path is kept on the field below. Error tracking groups by message
    // text, and `?workspaceId=<uuid>&status=…` made every workspace — and every
    // distinct status filter — its own issue: one fault, fifteen issues, none
    // of them with a useful count. The route is what identifies the failure;
    // the arguments belong in the properties.
    const route = path.split('?')[0];
    super(
      `Could not reach backend: ${method} ${route} — ${
        reachability === 'unknown' ? 'network state unknown' : online ? 'backend unreachable' : 'browser is offline'
      }`,
      { cause }
    );
    this.name = 'ApiNetworkError';
    this.method = method;
    this.path = path;
    this.online = online;
    this.reachability = reachability;
  }
}

/**
 * An HTTP-level failure the backend answered deliberately: carries the
 * status and the machine-readable `code` from the ApiResponse envelope so
 * callers can branch (e.g. `task_limit_reached` → upgrade modal) instead of
 * string-matching the human message.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** The whole error envelope, for routes that send fields beside `code`. */
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Deduped session recovery, run when the backend 401s a request we sent a
 * token with. The host supplies the actual refresh (see
 * ApiClientConfig.recoverSession — it owns the "is this session really dead?"
 * judgement); this only guarantees that concurrent 401s share ONE in-flight
 * attempt, so a burst of failing polls can't stampede the single-use,
 * rotating refresh token.
 */
const sessionRecovery = new WeakMap<ApiClientConfig, Promise<boolean>>();

type RequestContext = {
  config: ApiClientConfig;
  runtime: ReturnType<typeof getRuntime>;
  invalidated: boolean;
  dispose: () => void;
};

export class ClientInactiveError extends Error {
  constructor() {
    super('The client is suspended, offline, or its configuration changed.');
    this.name = 'ClientInactiveError';
  }
}

function context(): RequestContext {
  const ctx: RequestContext = { config: getConfig(), runtime: getRuntime(), invalidated: false, dispose: () => {} };
  ctx.dispose = ctx.runtime.lifecycle.subscribe((event) => {
    if (event.type === 'state' && !canRun(event.state)) ctx.invalidated = true;
  });
  return ctx;
}

function assertActive(ctx: RequestContext): void {
  if (ctx.invalidated || ctx.config !== getConfig() || ctx.runtime.lifecycle.getSnapshot().activity === 'suspended') throw new ClientInactiveError();
}

function assertRetryAllowed(ctx: RequestContext): void {
  assertActive(ctx);
  if (!canRun(ctx.runtime.lifecycle.getSnapshot())) throw new ClientInactiveError();
}

async function recoverSession(ctx: RequestContext): Promise<boolean> {
  assertRetryAllowed(ctx);
  let pending = sessionRecovery.get(ctx.config);
  if (!pending) {
    pending = Promise.resolve().then(() => {
      assertRetryAllowed(ctx);
      return ctx.config.recoverSession();
    }).catch(() => false).finally(() => { sessionRecovery.delete(ctx.config); });
    sessionRecovery.set(ctx.config, pending);
  }
  const recovered = await pending;
  assertRetryAllowed(ctx);
  return recovered;
}

function retryDelay(ctx: RequestContext, signal?: AbortSignal | null): Promise<void> {
  assertRetryAllowed(ctx);
  return new Promise((resolve, reject) => {
    const cleanups: (() => void)[] = [];
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      if (error) reject(error);
      else resolve();
    };
    const add = (cleanup: () => void) => {
      if (settled) cleanup();
      else cleanups.push(cleanup);
    };
    add(ctx.runtime.scheduler.timeout(() => finish(), TRANSPORT_RETRY_DELAY_MS));
    add(onConfigChange(() => finish(new ClientInactiveError())));
    add(ctx.runtime.lifecycle.subscribe((event) => {
      if (event.type === 'state' && !canRun(event.state)) finish(new ClientInactiveError());
    }));
    const abort = () => finish(signal?.reason ?? new Error('Request aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    add(() => signal?.removeEventListener('abort', abort));
    if (signal?.aborted) abort();
    try { assertRetryAllowed(ctx); } catch (error) { finish(error); }
  });
}

/**
 * How long a GET waits before its one retry after a transport failure. After a
 * wake from sleep, the reconnect catch-up GETs fail within milliseconds of a
 * fresh WebSocket being accepted — most likely on a connection pooled before
 * the sleep. A real outage fails both attempts and still throws.
 */
const TRANSPORT_RETRY_DELAY_MS = 1000;

/**
 * `fetch`, with transport failures wrapped in ApiNetworkError so an outage or
 * offline blip is identifiable instead of a bare, un-symbolicated
 * "TypeError: Failed to fetch". fetch only rejects on a transport failure,
 * never on an HTTP error status.
 *
 * A GET is retried once (see TRANSPORT_RETRY_DELAY_MS). Only a GET: a POST
 * that rejected may still have reached the server, so a replay could apply it
 * twice. Not when offline (a retry cannot succeed) or once the caller aborted.
 */
async function fetchOrThrow(
  method: string,
  path: string,
  init: RequestInit,
  ctx: RequestContext
): Promise<Response> {
  assertActive(ctx);
  const url = `${ctx.config.baseUrl}/api/v1${path}`;
  const options = { ...init, method };
  try {
    return await ctx.runtime.fetch(url, options);
  } catch (err) {
    assertActive(ctx);
    const error = new ApiNetworkError(method, path, err);
    if (method !== 'GET' || !error.online || init.signal?.aborted) throw error;
  }
  await retryDelay(ctx, init.signal);
  assertRetryAllowed(ctx);
  try {
    return await ctx.runtime.fetch(url, options);
  } catch (err) {
    assertActive(ctx);
    throw new ApiNetworkError(method, path, err);
  }
}

function reportRequestError(error: unknown, method: string, path: string, ctx: RequestContext): void {
  if (ctx.config !== getConfig() || error instanceof ClientInactiveError) return;
  const apiError = error instanceof ApiError ? error : null;
  try {
    ctx.config.onRequestError?.({ error, method, path, status: apiError?.status, code: apiError?.code });
  } catch {
    // Reporting must not replace the request failure.
  }
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  isRetry = false,
  raw?: { body: BodyInit; contentType: string; name?: string }
): Promise<T> {
  const ctx = context();
  try {
    return await requestInternal<T>(method, path, body, isRetry, raw, ctx);
  } catch (error) {
    reportRequestError(error, method, path, ctx);
    throw error;
  } finally {
    ctx.dispose();
  }
}

async function requestInternal<T>(
  method: string,
  path: string,
  body: unknown,
  isRetry = false,
  raw: { body: BodyInit; contentType: string; name?: string } | undefined,
  ctx: RequestContext
): Promise<T> {
  assertActive(ctx);
  const headers: Record<string, string> = {
    'Content-Type': raw ? raw.contentType : 'application/json',
    // Identifies the build to the backend, for logs and support. It carries
    // NO entitlement any more: the free-plan gates used to exempt builds that
    // predated the upgrade UI, and that exemption is deleted — every caller is
    // enforced alike, whatever it claims here.
    'X-Talyn-Client-Version': ctx.config.clientVersion,
  };
  if (raw?.name) headers['X-Attachment-Name'] = encodeURIComponent(raw.name);
  const token = await ctx.config.getAccessToken();
  assertActive(ctx);
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetchOrThrow(method, path, {
    headers,
    body: raw ? raw.body : body ? JSON.stringify(body) : undefined,
  }, ctx);
  assertActive(ctx);

  if (response.status === 401 && token && !isRetry) {
    // The backend rejected our token. Try to recover the session (see
    // recoverSession) and replay the request once with the fresh token;
    // a second 401 falls through to the normal error path.
    if (await recoverSession(ctx)) {
      return requestInternal<T>(method, path, body, true, raw, ctx);
    }
  }

  // The edge proxy in front of the hosted backend answers with plain text
  // ("upstream error", "upstream request timeout") when the backend can't
  // respond — parse defensively so an outage reads as "backend unreachable"
  // instead of a JSON SyntaxError.
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (response.status >= 500) throw new ApiError(`Backend unreachable (HTTP ${response.status})`, response.status);
    throw new ApiNetworkError(method, path, error);
  }
  let data: ApiResponse<T> | null = null;
  try {
    data = JSON.parse(text) as ApiResponse<T>;
  } catch {
    throw new ApiError(
      `Backend unreachable (HTTP ${response.status}${text ? `: ${text.slice(0, 80)}` : ''})`,
      response.status
    );
  }

  if (!response.ok || !data.success) {
    throw new ApiError(
      data.error || 'Request failed',
      response.status,
      data.code,
      data as unknown as Record<string, unknown>
    );
  }

  assertActive(ctx);
  return data.data as T;
}

/**
 * A request whose response is NOT an `ApiResponse` envelope.
 *
 * Two admin endpoints stream or pass through: the Prometheus text scrape and
 * the run-transcript SSE proxy. `request()` reads the whole body as text and
 * JSON.parses it, which would buffer a stream forever and reject a text/plain
 * body — so those need the raw `Response`.
 *
 * Everything else about the transport is identical, deliberately: same auth
 * header, same client-version header, same 401-recover-and-replay, same
 * ApiNetworkError wrapping and transport retry. Diverging on any of those is
 * how one endpoint ends up being the only thing that doesn't survive a token
 * refresh.
 */
export async function rawRequest(
  method: string,
  path: string,
  init: { accept?: string; signal?: AbortSignal } = {}
): Promise<Response> {
  const ctx = context();
  try {
    return await rawRequestInternal(method, path, init, ctx);
  } catch (error) {
    reportRequestError(error, method, path, ctx);
    throw error;
  } finally {
    ctx.dispose();
  }
}

async function rawRequestInternal(
  method: string,
  path: string,
  init: { accept?: string; signal?: AbortSignal } = {},
  ctx: RequestContext,
  isRetry = false
): Promise<Response> {
  assertActive(ctx);
  const headers: Record<string, string> = {
    'X-Talyn-Client-Version': ctx.config.clientVersion,
  };
  if (init.accept) headers.Accept = init.accept;
  const token = await ctx.config.getAccessToken();
  assertActive(ctx);
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetchOrThrow(method, path, {
    headers,
    signal: init.signal,
  }, ctx);
  assertActive(ctx);

  if (response.status === 401 && token && !isRetry) {
    if (await recoverSession(ctx)) {
      return rawRequestInternal(method, path, init, ctx, true);
    }
  }

  if (!response.ok) {
    // An error body here IS the JSON envelope — only the success path is raw.
    const text = await response.text().catch(() => '');
    let code: string | undefined;
    let details: Record<string, unknown> | undefined;
    let message = `Request failed (HTTP ${response.status})`;
    try {
      const parsed = JSON.parse(text) as ApiResponse<never>;
      if (parsed.error) message = parsed.error;
      code = parsed.code;
      details = parsed as unknown as Record<string, unknown>;
    } catch {
      if (text) message = text.slice(0, 200);
    }
    throw new ApiError(message, response.status, code, details);
  }

  return response;
}

